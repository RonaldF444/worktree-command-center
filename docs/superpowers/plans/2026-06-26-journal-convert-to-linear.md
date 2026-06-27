# Journal → Convert to Linear (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the journal tile's **Convert to Linear** button — Claude proposes a 1‑or‑more issue split, the user picks via checkboxes, and a second headless Claude creates the checked issues in the `CJBrothers` Linear team, then the tile shows the created links.

**Architecture:** A `LinearConvertProbe` runs two one-shot headless `claude -p` calls (propose with `--allowedTools Read`; create with `--allowedTools mcp__linear-cjb__save_issue`), each reading input from a temp file in `cwd` (never the command line — Phase 2 lesson). Pure `buildProposePrompt`/`buildCreatePrompt`/`parseIssuesJson` helpers are unit-tested. The `JournalTile` gets a propose→checkbox-preview→create→result flow. Builds on Phase 1+2 already on `main`.

**Tech Stack:** TypeScript, Electron renderer, vitest. Spec: `docs/superpowers/specs/2026-06-26-journal-convert-to-linear-design.md`.

## Global Constraints

- TS strict; verify each task with `npx tsc --noEmit --skipLibCheck` (repo root).
- Reuse `stripAnsi` (`usage-parse.ts`) and `SessionBridge` (`session-bridge.ts`). Reuse `setFooterDisabled` + `openExternalUrl` already in `journal-tile.ts`/`links.ts`.
- Input ALWAYS via a temp file in `cwd`, never the `-p` arg. Create step is restricted to `--allowedTools mcp__linear-cjb__save_issue` — never `--dangerously-skip-permissions`.
- Linear team: `CJBrothers`, id `0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5`.
- Commit on `main`, each task scoped via `git add <files>`. Working dir `C:/Users/User/Dev/worktree-command-center`; Windows/Git Bash.

---

### Task 1: `LinearConvertProbe` + helpers

**Files:**
- Create: `src/terminals/linear-convert-probe.ts`
- Test: `tests/linear-convert-probe.test.ts`

**Interfaces:**
- Produces: `interface ProposedIssue { title; description }`; `interface CreatedIssue { title; url?; ok; error? }`; `buildProposePrompt(notePath)`, `buildCreatePrompt(issuesPath)`, `parseIssuesJson(raw): unknown[]`; `class LinearConvertProbe { propose(noteText): Promise<ProposedIssue[]>; create(issues): Promise<CreatedIssue[]> }`.

- [ ] **Step 1: Write the failing test** — `tests/linear-convert-probe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildProposePrompt, buildCreatePrompt, parseIssuesJson } from '../src/terminals/linear-convert-probe';

describe('buildProposePrompt', () => {
  it('references the note path and asks for a JSON array', () => {
    const p = buildProposePrompt('/tmp/n.md');
    expect(p).toContain('/tmp/n.md');
    expect(p).toContain('JSON array');
  });
});
describe('buildCreatePrompt', () => {
  it('references the issues path, the CJBrothers team, and its id', () => {
    const p = buildCreatePrompt('/tmp/i.json');
    expect(p).toContain('/tmp/i.json');
    expect(p).toContain('CJBrothers');
    expect(p).toContain('0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5');
  });
});
describe('parseIssuesJson', () => {
  it('extracts a well-formed array', () => {
    expect(parseIssuesJson('[{"title":"a","description":"b"}]')).toEqual([{ title: 'a', description: 'b' }]);
  });
  it('tolerates a json fence and a preamble', () => {
    expect(parseIssuesJson('Here are the issues:\n```json\n[{"title":"a"}]\n```')).toEqual([{ title: 'a' }]);
  });
  it('strips ANSI before parsing', () => {
    expect(parseIssuesJson('\x1b[2m[{"title":"a"}]\x1b[0m')).toEqual([{ title: 'a' }]);
  });
  it('returns [] for non-array / malformed / empty', () => {
    expect(parseIssuesJson('{"title":"a"}')).toEqual([]);
    expect(parseIssuesJson('not json')).toEqual([]);
    expect(parseIssuesJson('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/linear-convert-probe.test.ts`.

- [ ] **Step 3: Implement** — `src/terminals/linear-convert-probe.ts`:

```ts
import { SessionBridge } from './session-bridge';
import { stripAnsi } from './usage-parse';
import * as fs from 'fs';
import * as path from 'path';

export interface LinearConvertProbeOpts { sidecarPath: string; cwd: string; }
export interface ProposedIssue { title: string; description: string; }
export interface CreatedIssue { title: string; url?: string; ok: boolean; error?: string; }

const CJB_TEAM = 'CJBrothers';
const CJB_TEAM_ID = '0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5';

export function buildProposePrompt(notePath: string): string {
  return (
    `Read the note at ${notePath}. Split it into the SMALLEST sensible set of actionable Linear ` +
    'issues — often just one; more only if it clearly contains distinct tasks. Output ONLY a JSON ' +
    'array of objects {"title": string, "description": string}: title concise, description the ' +
    'relevant note context. No preamble, no explanation, no code fences.'
  );
}

export function buildCreatePrompt(issuesPath: string): string {
  return (
    `Read the JSON array of issues at ${issuesPath}. For EACH issue, create a Linear issue in the ` +
    `"${CJB_TEAM}" team (id ${CJB_TEAM_ID}) using the available Linear tool, with its title and ` +
    'description. Output ONLY a JSON array with one object per issue: {"title": string, "url": ' +
    'string, "ok": true} on success, or {"title": string, "ok": false, "error": string} on ' +
    'failure. No preamble, no explanation, no code fences.'
  );
}

/** Strip ANSI, slice the first '[' … last ']', JSON.parse; [] if absent/malformed/non-array. */
export function parseIssuesJson(raw: string): unknown[] {
  const t = stripAnsi(raw);
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try { const p = JSON.parse(t.slice(start, end + 1)); return Array.isArray(p) ? p : []; }
  catch { return []; }
}

/** Two one-shot headless `claude -p` calls (propose / create), input via temp file, tool-scoped. */
export class LinearConvertProbe {
  private seq = 0;
  constructor(private opts: LinearConvertProbeOpts) {}

  private run(input: string, prompt: (p: string) => string, tool: string, timeoutMs: number): Promise<unknown[]> {
    const tmp = path.join(this.opts.cwd, `.cos-linear-${Date.now()}-${this.seq++}.json`);
    return new Promise<unknown[]>((resolve, reject) => {
      try { fs.writeFileSync(tmp, input, 'utf8'); }
      catch (e) { reject(e instanceof Error ? e : new Error('convert: temp write failed')); return; }
      const cleanup = (): void => { try { fs.unlinkSync(tmp); } catch { /* gone */ } };
      const bridge = new SessionBridge(
        this.opts.sidecarPath, this.opts.cwd, 'claude',
        ['-p', prompt(tmp), '--output-format', 'text', '--allowedTools', tool], {},
      );
      let buf = '';
      let done = false;
      const finish = (fn: () => void): void => { if (done) return; done = true; window.clearTimeout(timer); cleanup(); fn(); };
      const timer = window.setTimeout(() => finish(() => { bridge.kill(); reject(new Error('convert timed out')); }), timeoutMs);
      bridge.onData((d) => { buf += d; });
      bridge.onExit(() => finish(() => resolve(parseIssuesJson(buf))));
      bridge.start();
    });
  }

  async propose(noteText: string): Promise<ProposedIssue[]> {
    if (noteText.trim() === '') return [];
    const rows = await this.run(noteText, buildProposePrompt, 'Read', 60000);
    return rows
      .filter((r): r is ProposedIssue =>
        !!r && typeof (r as ProposedIssue).title === 'string' && typeof (r as ProposedIssue).description === 'string')
      .map((r) => ({ title: r.title, description: r.description }));
  }

  async create(issues: ProposedIssue[]): Promise<CreatedIssue[]> {
    if (!issues.length) return [];
    const rows = await this.run(JSON.stringify(issues), buildCreatePrompt, 'mcp__linear-cjb__save_issue', 120000);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof (r as Record<string, unknown>).title === 'string')
      .map((r) => ({
        title: String(r.title),
        url: typeof r.url === 'string' ? r.url : undefined,
        ok: r.ok === true,
        error: typeof r.error === 'string' ? r.error : undefined,
      }));
  }
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/linear-convert-probe.test.ts`.
- [ ] **Step 5: Type-check.** `npx tsc --noEmit --skipLibCheck` → clean.
- [ ] **Step 6: Commit.** `git add src/terminals/linear-convert-probe.ts tests/linear-convert-probe.test.ts && git commit -m "feat(journal): LinearConvertProbe + prompt/parse helpers"`

---

### Task 2: JournalTile Convert flow

**Files:**
- Modify: `src/terminals/journal-tile.ts`

**Interfaces:**
- Consumes: `onConvertPropose`/`onConvertCreate` (new opts, supplied by Task 3); `ProposedIssue`/`CreatedIssue` (Task 1); `openExternalUrl` from `./links`.

- [ ] **Step 1: Imports + opts.** Add at top: `import { openExternalUrl } from './links';` and `import type { ProposedIssue, CreatedIssue } from './linear-convert-probe';`. Add to `JournalTileOpts`:

```ts
  onConvertPropose: (text: string) => Promise<ProposedIssue[]>;
  onConvertCreate: (issues: ProposedIssue[]) => Promise<CreatedIssue[]>;
```

- [ ] **Step 2: Enable the button.** Replace the disabled "Convert to Linear" placeholder line in `render()` with:

```ts
    this.convertBtn = actions.createEl('button', { text: 'Convert to Linear', cls: 'cos-journal-convert-btn', attr: { title: 'Propose Linear issues from this note' } }) as HTMLButtonElement;
    this.convertBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.convertToLinear(); });
```

Add a `private convertBtn: HTMLButtonElement | null = null;` field, and include it in `setFooterDisabled`'s list: change that method's array to `[this.saveBtn, this.historyBtn, this.fmtBtn, this.convertBtn]`.

- [ ] **Step 3: Convert flow.** Add these methods (near `format()`):

```ts
  private async convertToLinear(): Promise<void> {
    const text = this.textarea?.value ?? this.currentText;
    if (text.trim() === '') { this.opts.toast('Nothing to convert'); return; }
    this.currentText = text;
    this.setFooterDisabled(true);
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Analyzing note…' }); }
    let proposed: ProposedIssue[];
    try { proposed = await this.opts.onConvertPropose(text); }
    catch { this.opts.toast('Convert failed'); this.renderEditor(); this.setFooterDisabled(false); return; }
    if (!proposed.length) { this.opts.toast("Couldn't read a proposed split"); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderConvertPreview(proposed);
  }

  private renderConvertPreview(proposed: ProposedIssue[]): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const checked = proposed.map(() => true);
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-convert' });
    proposed.forEach((iss, i) => {
      const row = list.createDiv({ cls: 'cos-journal-convert-row' });
      const cb = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = true;
      const txt = row.createDiv({ cls: 'cos-journal-convert-txt' });
      txt.createDiv({ cls: 'cos-journal-convert-title', text: iss.title });
      txt.createDiv({ cls: 'cos-journal-convert-desc', text: iss.description });
      cb.addEventListener('change', () => { checked[i] = cb.checked; updateBtn(); });
    });
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    const createBtn = bar.createEl('button', { cls: 'cos-journal-save' }) as HTMLButtonElement;
    const updateBtn = (): void => {
      const n = checked.filter(Boolean).length;
      createBtn.setText(`Create ${n} issue${n === 1 ? '' : 's'}`);
      createBtn.disabled = n === 0;
    };
    updateBtn();
    createBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.doCreate(proposed.filter((_, i) => checked[i])); });
    bar.createEl('button', { text: 'Discard' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }

  private async doCreate(issues: ProposedIssue[]): Promise<void> {
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Creating in Linear…' }); }
    let results: CreatedIssue[];
    try { results = await this.opts.onConvertCreate(issues); }
    catch { this.opts.toast('Create timed out — check Linear'); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderConvertResult(results);
  }

  private renderConvertResult(results: CreatedIssue[]): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-convert' });
    if (!results.length) list.createDiv({ cls: 'cos-journal-hist-empty', text: 'No issues created' });
    for (const r of results) {
      const row = list.createDiv({ cls: 'cos-journal-convert-row' });
      row.createSpan({ cls: 'cos-journal-convert-mark', text: r.ok ? '✓' : '✗' });
      if (r.ok && r.url) {
        const a = row.createEl('a', { cls: 'cos-journal-convert-link', text: r.title, attr: { href: r.url } });
        a.addEventListener('click', (e) => { e.preventDefault(); openExternalUrl(r.url!); });
      } else {
        row.createSpan({ cls: 'cos-journal-convert-title', text: r.title });
        if (r.error) row.createSpan({ cls: 'cos-journal-convert-desc', text: r.error });
      }
    }
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    bar.createEl('button', { text: 'Done', cls: 'cos-journal-save' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }
```

- [ ] **Step 4: Type-check.** `npx tsc --noEmit --skipLibCheck`. Expected: errors ONLY about the missing `onConvertPropose`/`onConvertCreate` at the two `new JournalTile({...})` sites in `terminals-grid.ts` (fixed in Task 3); `journal-tile.ts` itself clean.
- [ ] **Step 5: Commit.** `git add src/terminals/journal-tile.ts && git commit -m "feat(journal): Convert to Linear flow — propose, checkbox preview, create, results"`

---

### Task 3: Grid wiring

**Files:**
- Modify: `src/terminals/terminals-grid.ts`

- [ ] **Step 1: Import + field.** Add `import { LinearConvertProbe } from './linear-convert-probe';`. Add field by `formatProbe`: `private linearProbe!: LinearConvertProbe;`. In the constructor, after `this.formatProbe = ...`: `this.linearProbe = new LinearConvertProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir });`

- [ ] **Step 2: Pass callbacks at both JournalTile sites** (`spawnJournal()` + `restoreSessions()` journal branch), alongside the existing `onFormat`:

```ts
    onConvertPropose: (text) => this.linearProbe.propose(text),
    onConvertCreate: (issues) => this.linearProbe.create(issues),
```

- [ ] **Step 3: Type-check + tests.** `npx tsc --noEmit --skipLibCheck && npx vitest run` → clean (the 2 pre-existing `coord-cli.test.ts` failures are unrelated; `linear-convert-probe` passes).
- [ ] **Step 4: Commit.** `git add src/terminals/terminals-grid.ts && git commit -m "feat(journal): wire LinearConvertProbe into journal tiles"`

---

### Task 4: Convert UI styles

**Files:**
- Modify: `app.css`

- [ ] **Step 1: Append styles** to `app.css`:

```css
/* Journal → Convert to Linear: proposal checklist + result list. */
.cos-journal-convert { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; width: 100%; }
.cos-journal-convert-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 6px; border-radius: 5px; }
.cos-journal-convert-row:hover { background: var(--background-modifier-hover); }
.cos-journal-convert-row input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
.cos-journal-convert-txt { display: flex; flex-direction: column; min-width: 0; }
.cos-journal-convert-title { color: var(--text-normal); font-weight: 600; }
.cos-journal-convert-desc { color: var(--text-muted); font-size: 11px; white-space: pre-wrap; }
.cos-journal-convert-mark { flex: 0 0 auto; font-weight: 700; }
.cos-journal-convert-link { color: var(--interactive-accent); cursor: pointer; text-decoration: none; font-weight: 600; }
.cos-journal-convert-link:hover { text-decoration: underline; }
```

- [ ] **Step 2: Build + manual.** `npm run build`, reload. Multi-task note → "Analyzing…" → checklist (uncheck one → count drops) → Create → "Creating in Linear…" → result links open in browser; a note with `%`/quotes converts intact; empty note toasts.
- [ ] **Step 3: Commit.** `git add app.css && git commit -m "feat(journal): convert-to-linear UI styles"`

---

## Self-Review

- **Spec coverage:** §3.1 probe + helpers → T1; §3.2 tile propose/preview/create/result + footer-disable → T2; §3.3 grid probe + both callbacks → T3; §4 visual → T2/T4. Per-issue checkboxes + partial-failure result + temp-file input + tool-scoped spawns all in T1/T2. Covered.
- **Placeholder scan:** none — full code each step.
- **Type consistency:** `propose(): Promise<ProposedIssue[]>` / `create(ProposedIssue[]): Promise<CreatedIssue[]>` (T1) match the tile opts (T2) and grid callbacks (T3). `parseIssuesJson` returns `unknown[]`; `propose`/`create` validate shape. `openExternalUrl` imported in T2 (exists in `links.ts`). `setFooterDisabled` extended to include `convertBtn`.
