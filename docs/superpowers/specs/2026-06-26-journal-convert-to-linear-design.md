# Journal → Convert to Linear — Design (Phase 3)

> Status: approved design, pre-implementation. Date: 2026-06-26.
> Builds on Phase 1 (journal tile) + Phase 2 (Format / headless-claude pattern). Final phase.

## 1. Goal

Enable the journal tile's **Convert to Linear** button. It runs in **two phases**: Claude reads
the note and **proposes** a 1‑or‑more issue split; the tile shows each proposed issue with a
**checkbox** (include/exclude); on **Create**, a second headless Claude **creates the checked
issues** in the `CJBrothers` Linear team via the `linear-cjb` MCP; the tile then shows the
**created issue links** (and any per-issue failures). Nothing is created without the preview +
explicit Create click.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Split | Claude decides 1..N issues; the user reviews and includes/excludes per issue (no inline editing in v1). |
| Mechanism | Two one-shot headless `claude -p` runs (propose, then create), each reading its input from a temp file in `cwd` (note / chosen issues) — input never rides the Windows command line (same reason as Phase 2's fix). |
| Propose tools | `--allowedTools Read` only (read the note temp file; no Linear access, no writes). |
| Create tools | `--allowedTools mcp__linear-cjb__save_issue` only — the create step can ONLY create Linear issues, nothing else. No `--dangerously-skip-permissions`. |
| Linear target | Team **CJBrothers** (id `0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5` — the only team). Team backlog, no project/label/assignee in v1. |
| Structured I/O | Claude returns JSON; a robust `parseIssuesJson` extracts the array (strip ANSI, slice `[`…`]`, `JSON.parse`, validate shape). Malformed → clean error state. |
| Approve UX | Per-issue checkboxes; the Create button label reflects the checked count; Discard creates none. |
| Partial failure | The create step reports per-issue `{title, url?, ok, error?}`; the result view lists successes (with links) and failures separately. |
| Safety | Create is user-initiated (preview + Create click); the spawned Claude is constrained to the single `save_issue` tool. |

## 3. Architecture — units

### 3.1 `LinearConvertProbe` — `src/terminals/linear-convert-probe.ts` (new)

```ts
export interface LinearConvertProbeOpts { sidecarPath: string; cwd: string; }
export interface ProposedIssue { title: string; description: string; }
export interface CreatedIssue { title: string; url?: string; ok: boolean; error?: string; }

export function buildProposePrompt(notePath: string): string;
export function buildCreatePrompt(issuesPath: string): string;
/** Strip ANSI, slice the first '['…last ']', JSON.parse, return [] if absent/malformed. */
export function parseIssuesJson(raw: string): unknown[];

export class LinearConvertProbe {
  constructor(opts: LinearConvertProbeOpts);
  propose(noteText: string): Promise<ProposedIssue[]>;          // claude -p --allowedTools Read
  create(issues: ProposedIssue[]): Promise<CreatedIssue[]>;     // claude -p --allowedTools mcp__linear-cjb__save_issue
}
```

- Both `propose`/`create` mirror Phase 2's `FormatProbe`: write input to a temp file in `cwd`,
  spawn a one-shot `SessionBridge('claude', ['-p', prompt, '--output-format', 'text', '--allowedTools', <tool>])`,
  collect stdout, resolve on exit (timeout: propose 60s, create 120s), delete the temp file on
  every exit.
- `propose`: `buildProposePrompt(notePath)` →
  > "Read the note at <path>. Split it into the SMALLEST sensible set of actionable Linear issues
  > (often just 1; more only if it clearly contains distinct tasks). Output ONLY a JSON array of
  > objects `{\"title\": string, \"description\": string}` — title concise, description the
  > relevant note context. No preamble, no code fences."
  Parse with `parseIssuesJson`, validate each has string `title`+`description` → `ProposedIssue[]`.
- `create`: write the chosen issues to a temp JSON file; `buildCreatePrompt(issuesPath)` →
  > "Read the JSON array of issues at <path>. For EACH, create a Linear issue in team
  > \"CJBrothers\" (id 0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5) using the available Linear tool, with
  > its title and description. Output ONLY a JSON array `{\"title\": string, \"url\": string,
  > \"ok\": true}` per created issue, or `{\"title\": string, \"ok\": false, \"error\": string}`
  > if one failed. No preamble, no code fences."
  Parse + validate → `CreatedIssue[]`.

### 3.2 `JournalTile` changes — `src/terminals/journal-tile.ts`

- `JournalTileOpts` gains `onConvertPropose: (text) => Promise<ProposedIssue[]>` and
  `onConvertCreate: (issues: ProposedIssue[]) => Promise<CreatedIssue[]>`.
- Un-disable the **Convert to Linear** button → `convertToLinear()`:
  1. read note; empty → `toast('Nothing to convert')`; else `setFooterDisabled(true)` + body shows "Analyzing note…".
  2. `propose` → `renderConvertPreview(proposed)`; on error → toast + `renderEditor()` + re-enable.
  3. **Preview:** `.cos-journal-convert` list, one row per proposed issue — a checkbox (default
     checked), the title, and the description (muted). An actions bar: **Create N issue(s)**
     (count = checked; disabled at 0) + **Discard**. The count updates on checkbox toggle.
  4. **Create:** body → "Creating in Linear…"; `create(checked)` → `renderConvertResult(results)`;
     on error → toast + back to editor.
  5. **Result:** list of created issues — ✓ title → link (Ctrl/Cmd-click opens via the existing
     `openExternalUrl`), and ✗ title → error for failures. A **Done** button → `renderEditor()`.
- Reuses `setFooterDisabled` from Phase 2; all exit paths re-enable the footer.

### 3.3 Grid wiring — `src/terminals/terminals-grid.ts`

- `private linearProbe = new LinearConvertProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir })` (ctor, by `formatProbe`).
- Pass `onConvertPropose: (t) => this.linearProbe.propose(t)` and
  `onConvertCreate: (i) => this.linearProbe.create(i)` into BOTH JournalTile sites.

## 4. Visual

```
proposed:                                  result:
┌ Journal 1 — Convert to Linear   🔒 – × ┐  ┌ Journal 1 — Created            🔒 – × ┐
│ [x] Fix migrate on dev deploy          │  │ ✓ Fix migrate on dev deploy  CJB-101 │
│     ↳ the deploy migrate failed …      │  │ ✓ ACH button on Weekly Pay   CJB-102 │
│ [x] Add ACH button to Weekly Payments  │  │ ✗ Ask Spencer … (error: …)           │
│ [ ] Ask Spencer re: vendor list        │  │                                       │
├─────────────────────────────────────────┤  ├───────────────────────────────────────┤
│  [Create 2 issues]   [Discard]          │  │  [Done]                               │
└─────────────────────────────────────────┘  └───────────────────────────────────────┘
(running: "Analyzing note…" / "Creating in Linear…")
```

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Claude returns malformed JSON | `parseIssuesJson` slices `[`…`]` + tolerant parse; empty/invalid → toast "Couldn't read the proposed split" + back to editor. |
| Creates real Linear issues (outward) | Two-step: preview + explicit Create; the create Claude is restricted to ONLY `mcp__linear-cjb__save_issue`. |
| Partial create failure | Per-issue `{ok,error}`; result view shows successes + failures, nothing silently dropped. |
| Note/issues with `%`, quotes, length | Always passed via temp file, never the command line (Phase 2 lesson). |
| `save_issue` needs team resolution | Prompt supplies the team name AND id, so no extra lookup tool is needed. |
| Long create (N issues) | 120s timeout; on timeout the result is unknown → toast "Create timed out — check Linear" (issues may have been created; we do not retry). |
| Classifier may gate the create-spawn at build time | Expected; the controller commits or the user approves — same as Phase 2's tool-flag handling. |

## 6. Testing

- `tests/linear-convert-probe.test.ts` (pure): `buildProposePrompt`/`buildCreatePrompt` reference
  the temp path + carry the strict instruction + the CJBrothers id (create); `parseIssuesJson`
  extracts a well-formed array, tolerates a ```` ```json ```` fence + preamble, slices a leading
  "Here are the issues:" prefix, and returns `[]` for non-array / malformed input.
- Propose/create spawns + tile DOM = build + manual: a multi-task note proposes >1 issue; unchecking
  drops it from the count; Create makes real CJBrothers issues and the result links open; a note with
  `%`/quotes converts intact; malformed/empty handled.

## 7. Out of scope (Phase 3 / v1)

- Inline editing of proposed issues (you chose include/exclude). Project / label / assignee / priority
  targeting. Dedupe against existing Linear issues. Linking the journal to the created issues. Retry on
  timeout. Streaming progress per issue.
