# Auto-Purge Stale Hidden Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every app boot, purge hidden terminal sessions idle ≥ 5 days — remove their persistence entry (so they never respawn) and delete their worktree + branch.

**Architecture:** A pure decision module `session-purge.ts` (`partitionStale`) runs once at boot in `app.ts` against the whole `.terminal-sessions.json`, before any `TerminalsGrid` exists. Live idle tracking is a `lastActivity` stamp on `TerminalTile`, persisted through the grid's existing `serializeTile`/`restoreRecord`. Backfill for old entries probes worktree disk/git timestamps.

**Tech Stack:** TypeScript (strict, tabs, single quotes), vitest (`npm test`), Electron renderer with Node access (`fs/promises`, `child_process`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-auto-purge-stale-hidden-design.md`
- Threshold constant: `PURGE_AFTER_MS = 5 * 864e5`; replay window: `REPLAY_WINDOW_MS = 2 * 60_000`. No config UI.
- Only `kind === 'terminal' && hidden === true` entries may purge. Journals, god, chat, visible tiles: exempt. Malformed/unknown entries: keep.
- Purge is unconditional (no dirty-check) — user's explicit choice. Entry is dropped even if disk deletion fails.
- Sessions-file read failure at boot → skip sweep entirely, app boots normally.
- **NEVER run `npm run build`, `npm run dist`, or `npm run install-local`** — the user triggers those personally. Stop at green tests + `npx tsc -noEmit -skipLibCheck`.
- Vitest runs in node env; there is no DOM test harness — test pure logic, not DOM.

---

### Task 1: Pure decision module `session-purge.ts`

**Files:**
- Create: `src/terminals/session-purge.ts`
- Test: `tests/session-purge.test.ts`

**Interfaces:**
- Produces: `PURGE_AFTER_MS`, `REPLAY_WINDOW_MS`, `interface PurgeRecord { kind?: string; hidden?: boolean; worktreePath?: string; repoPath?: string; branch?: string; lastActivity?: number }`, `partitionStale<T extends PurgeRecord>(entries: T[], now: number, probe: (worktreePath: string) => number): { keep: T[]; purge: T[]; missing: T[] }` — `purge` = idle ≥ 5 days with worktree on disk (probe > 0 or lastActivity present); `missing` = hidden terminals whose probe returns `-1` (worktree gone: drop entry, nothing to delete).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { partitionStale, PURGE_AFTER_MS } from '../src/terminals/session-purge';

const NOW = 1_800_000_000_000;
const OLD = NOW - PURGE_AFTER_MS - 1;
const FRESH = NOW - 1000;
const t = (over: object) => ({ kind: 'terminal', hidden: true, worktreePath: 'C:\\wt\\x', repoPath: 'C:\\repo', branch: 'wt/x', ...over });

describe('partitionStale', () => {
	it('purges hidden terminals idle past the threshold', () => {
		const r = partitionStale([t({ lastActivity: OLD })], NOW, () => 0);
		expect(r.purge.length).toBe(1);
		expect(r.keep.length).toBe(0);
	});
	it('keeps hidden terminals with recent activity', () => {
		const r = partitionStale([t({ lastActivity: FRESH })], NOW, () => 0);
		expect(r.keep.length).toBe(1);
		expect(r.purge.length).toBe(0);
	});
	it('keeps visible tiles, journals and god regardless of age', () => {
		const rows = [t({ hidden: false, lastActivity: OLD }), t({ kind: 'journal', lastActivity: OLD }), t({ kind: 'god', lastActivity: OLD })];
		const r = partitionStale(rows, NOW, () => 0);
		expect(r.keep.length).toBe(3);
	});
	it('backfills a missing lastActivity from the probe', () => {
		expect(partitionStale([t({})], NOW, () => OLD).purge.length).toBe(1);
		expect(partitionStale([t({})], NOW, () => FRESH).keep.length).toBe(1);
	});
	it('routes probe=-1 (worktree gone) to missing', () => {
		const r = partitionStale([t({})], NOW, () => -1);
		expect(r.missing.length).toBe(1);
		expect(r.purge.length).toBe(0);
	});
	it('probe=0 (unknown age) purges per spec', () => {
		expect(partitionStale([t({})], NOW, () => 0).purge.length).toBe(1);
	});
	it('never probes entries that carry lastActivity or are exempt', () => {
		let calls = 0;
		partitionStale([t({ lastActivity: FRESH }), t({ hidden: false })], NOW, () => { calls++; return 0; });
		expect(calls).toBe(0);
	});
	it('keeps malformed entries', () => {
		const r = partitionStale([{ kind: 'terminal', hidden: true } as never], NOW, () => 0);
		expect(r.keep.length).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/session-purge.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
export const PURGE_AFTER_MS = 5 * 864e5;
export const REPLAY_WINDOW_MS = 2 * 60_000;

export interface PurgeRecord {
	kind?: string; hidden?: boolean; worktreePath?: string;
	repoPath?: string; branch?: string; lastActivity?: number;
}

/** Split persisted session records into keep / purge / missing. Pure: `now` and `probe` are
 *  injected. `probe(worktreePath)` returns the newest on-disk activity timestamp (epoch ms),
 *  0 when unknowable, -1 when the worktree no longer exists. Only hidden terminals without a
 *  lastActivity stamp are probed. */
export function partitionStale<T extends PurgeRecord>(
	entries: T[], now: number, probe: (worktreePath: string) => number,
): { keep: T[]; purge: T[]; missing: T[] } {
	const keep: T[] = []; const purge: T[] = []; const missing: T[] = [];
	for (const e of entries) {
		if (e.kind !== 'terminal' || e.hidden !== true || !e.worktreePath || !e.repoPath || !e.branch) { keep.push(e); continue; }
		let last = e.lastActivity;
		if (last === undefined) {
			const probed = probe(e.worktreePath);
			if (probed === -1) { missing.push(e); continue; }
			last = probed;
		}
		if (now - last >= PURGE_AFTER_MS) purge.push(e); else keep.push(e);
	}
	return { keep, purge, missing };
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/session-purge.test.ts` → all PASS.
- [ ] **Step 5: Commit** — `git add src/terminals/session-purge.ts tests/session-purge.test.ts && git commit -m "feat: pure partition logic for stale hidden session purge"`

### Task 2: Disk-activity probe

**Files:**
- Modify: `src/terminals/session-purge.ts` (append)
- Test: `tests/session-purge.test.ts` (append)

**Interfaces:**
- Produces: `probeWorktreeActivity(worktreePath: string, io?: ProbeIo): number` with `interface ProbeIo { statMtime(p: string): number | null; readText(p: string): string | null; lastCommitSec(wt: string): number | null }` — default `io` uses `fs` + `child_process.execFileSync('git', ['-C', wt, 'log', '-1', '--format=%ct'], { timeout: 10_000 })`. Returns -1 if the worktree dir doesn't stat, else newest of: root mtime, `.git` file mtime, gitdir `logs/HEAD`/`index`/`HEAD` mtimes, last commit × 1000; 0 if every signal fails.

- [ ] **Step 1: Write the failing test** (append to `tests/session-purge.test.ts`)

```ts
import { probeWorktreeActivity } from '../src/terminals/session-purge';

describe('probeWorktreeActivity', () => {
	const io = (over: object) => ({
		statMtime: () => null, readText: () => null, lastCommitSec: () => null, ...over,
	});
	it('returns -1 when the worktree root does not stat', () => {
		expect(probeWorktreeActivity('C:\\gone', io({}))).toBe(-1);
	});
	it('takes the newest of all signals', () => {
		const m = new Map([['C:\\wt', 100], ['C:\\wt\\.git', 200], ['C:\\gd\\logs\\HEAD', 900], ['C:\\gd\\index', 300], ['C:\\gd\\HEAD', 400]]);
		const p = probeWorktreeActivity('C:\\wt', io({
			statMtime: (x: string) => m.get(x) ?? null,
			readText: () => 'gitdir: C:\\gd',
			lastCommitSec: () => null,
		}));
		expect(p).toBe(900);
	});
	it('uses last commit time when newer', () => {
		const p = probeWorktreeActivity('C:\\wt', io({ statMtime: (x: string) => (x === 'C:\\wt' ? 100 : null), lastCommitSec: () => 5 }));
		expect(p).toBe(5000);
	});
	it('returns root mtime alone when git signals fail', () => {
		expect(probeWorktreeActivity('C:\\wt', io({ statMtime: (x: string) => (x === 'C:\\wt' ? 100 : null) }))).toBe(100);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/session-purge.test.ts` → FAIL (not exported).

- [ ] **Step 3: Write minimal implementation** (append to `session-purge.ts`)

```ts
import * as fsSync from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ProbeIo {
	statMtime(p: string): number | null;
	readText(p: string): string | null;
	lastCommitSec(wt: string): number | null;
}

const realIo: ProbeIo = {
	statMtime: (p) => { try { return fsSync.statSync(p).mtimeMs; } catch { return null; } },
	readText: (p) => { try { return fsSync.readFileSync(p, 'utf8'); } catch { return null; } },
	lastCommitSec: (wt) => {
		try {
			const out = execFileSync('git', ['-C', wt, 'log', '-1', '--format=%ct'], { timeout: 10_000, encoding: 'utf8' }).trim();
			return out ? Number(out) : null;
		} catch { return null; }
	},
};

/** Newest on-disk activity for a worktree; -1 = worktree gone, 0 = no readable signal. */
export function probeWorktreeActivity(worktreePath: string, io: ProbeIo = realIo): number {
	const root = io.statMtime(worktreePath);
	if (root === null) return -1;
	let best = root;
	const take = (v: number | null): void => { if (v !== null && v > best) best = v; };
	const dotgit = path.join(worktreePath, '.git');
	take(io.statMtime(dotgit));
	const pointer = io.readText(dotgit);
	const gd = pointer?.includes('gitdir:') ? pointer.split('gitdir:')[1]!.trim() : null;
	if (gd) for (const tail of ['logs/HEAD', 'index', 'HEAD']) take(io.statMtime(path.join(gd, tail)));
	const commit = io.lastCommitSec(worktreePath);
	take(commit !== null ? commit * 1000 : null);
	return best;
}
```

- [ ] **Step 4: Run test to verify it passes**, then the whole file: `npx vitest run tests/session-purge.test.ts` → all PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: disk-activity probe for purge backfill"`

### Task 3: Boot sweep in `app.ts`

**Files:**
- Modify: `src/app.ts` — insert after the `sessionsFile` path is computed (`src/app.ts:135` area) and BEFORE `const grids = new Map<string, TerminalsGrid>()`.

**Interfaces:**
- Consumes: `partitionStale`, `probeWorktreeActivity` (Tasks 1–2); `removeWorktreeAndBranch(repoPath, worktreePath, branch)` from `./terminals/worktree-manager` (exists).
- Produces: `sweepStaleSessions(sessionsFile: string): Promise<string | null>` (module-level fn in `app.ts`) returning a toast message or null when nothing purged.

- [ ] **Step 1: Add the sweep function to `app.ts`** (top-level, near other helpers; imports at top of file):

```ts
import { partitionStale, probeWorktreeActivity } from './terminals/session-purge';
import { removeWorktreeAndBranch } from './terminals/worktree-manager';
import { promises as fsp } from 'fs';

/** Boot-time purge of hidden terminals idle >= 5 days (spec 2026-08-10). Runs before any
 *  grid exists so purged sessions never spawn a process. Never throws: an unreadable file
 *  or failed deletion must not brick startup. */
async function sweepStaleSessions(sessionsFile: string): Promise<string | null> {
	let all: Record<string, import('./terminals/session-purge').PurgeRecord[]>;
	try { all = JSON.parse(await fsp.readFile(sessionsFile, 'utf8')); } catch { return null; }
	let purged = 0; let failed = 0; let changed = false;
	for (const ws of Object.keys(all)) {
		const { keep, purge, missing } = partitionStale(all[ws]!, Date.now(), probeWorktreeActivity);
		if (purge.length === 0 && missing.length === 0) continue;
		changed = true;
		all[ws] = keep;
		purged += purge.length + missing.length;
		for (const e of purge) {
			try { await removeWorktreeAndBranch(e.repoPath!, e.worktreePath!, e.branch!); }
			catch { failed++; }
		}
	}
	if (!changed) return null;
	await fsp.writeFile(sessionsFile, JSON.stringify(all, null, 2), 'utf8');
	return `Auto-purged ${purged} hidden session${purged === 1 ? '' : 's'} (idle 5+ days)` + (failed ? ` — ${failed} worktree cleanup${failed === 1 ? '' : 's'} failed` : '');
}
```

- [ ] **Step 2: Call it at boot.** Immediately after the object containing `sessionsFile: path.join(userData, '.terminal-sessions.json')` is built (before `const grids = new Map(...)`), add — reusing the SAME `sessionsFile` expression the grid deps use, and the toast helper `app.ts` already gives grids via its deps (hoist it to a local if it is currently inline):

```ts
const purgeMsg = await sweepStaleSessions(path.join(userData, '.terminal-sessions.json'));
if (purgeMsg) toast(purgeMsg);
```

If `app.ts` has no reusable `toast`, add this minimal one next to the sweep call (repo styles already define toast CSS; match the class the grid's toast uses — grep `cos-toast` in `app.css`/`styles.css` and reuse that class):

```ts
const toast = (msg: string): void => {
	const el = document.body.createDiv({ cls: 'cos-toast', text: msg });
	window.setTimeout(() => el.remove(), 5000);
};
```

- [ ] **Step 3: Typecheck** — `npx tsc -noEmit -skipLibCheck` → clean. (No behavior test possible without DOM harness; logic is covered by Tasks 1–2.)
- [ ] **Step 4: Run full suite** — `npm test` → all green.
- [ ] **Step 5: Commit** — `git commit -am "feat: boot-time sweep purges stale hidden sessions before any spawn"`

### Task 4: `lastActivity` stamping + persistence round-trip

**Files:**
- Modify: `src/terminals/terminals-grid.ts:56` (SessionRecord), `serializeTile` (~line 1249), `restoreRecord` (~line 1291)
- Modify: `src/terminals/terminal-tile.ts`, `src/terminals/stage-tile.ts`
- Test: `tests/session-purge.test.ts` (append pure-helper tests)

**Interfaces:**
- Consumes: `REPLAY_WINDOW_MS` (Task 1).
- Produces: `shouldStampOutput(spawnedAt: number, now: number): boolean` in `session-purge.ts`; `StageTile` gains optional readonly `lastActivity?: number`; `TerminalTileOpts` gains `initialLastActivity?: number`; `SessionRecord` gains `lastActivity?: number`.

- [ ] **Step 1: Failing test for the replay-window helper** (append):

```ts
import { shouldStampOutput, REPLAY_WINDOW_MS } from '../src/terminals/session-purge';

describe('shouldStampOutput', () => {
	it('ignores output inside the replay window, stamps after', () => {
		const spawn = 1_800_000_000_000;
		expect(shouldStampOutput(spawn, spawn + REPLAY_WINDOW_MS - 1)).toBe(false);
		expect(shouldStampOutput(spawn, spawn + REPLAY_WINDOW_MS + 1)).toBe(true);
	});
});
```

- [ ] **Step 2: Verify fail, implement in `session-purge.ts`:**

```ts
/** PTY output only counts as activity after the --continue replay window, so a mere
 *  relaunch never resets a hidden session's idle clock. */
export function shouldStampOutput(spawnedAt: number, now: number): boolean {
	return now - spawnedAt > REPLAY_WINDOW_MS;
}
```

- [ ] **Step 3: Verify pass.**
- [ ] **Step 4: Wire the tile.** In `terminal-tile.ts`:
  - Add fields: `private spawnedAtMs = Date.now();` and `private lastActivityMs: number;` — in the constructor: `this.lastActivityMs = opts.initialLastActivity ?? Date.now();` (add `initialLastActivity?: number` to `TerminalTileOpts`). Reset `this.spawnedAtMs = Date.now()` wherever the claude process is (re)launched (initial spawn and the restart/refresh paths that relaunch with `--continue`).
  - Getter: `get lastActivity(): number { return this.lastActivityMs; }`
  - Stamp `this.lastActivityMs = Date.now()` in: the method that writes user input to the PTY; `setHidden` (both directions); `setCentered(true)`; and the PTY data handler guarded by `if (shouldStampOutput(this.spawnedAtMs, Date.now()))`.
  - In `stage-tile.ts` add to the `StageTile` interface: `readonly lastActivity?: number;`
- [ ] **Step 5: Persist + restore round-trip.** In `terminals-grid.ts`:
  - `SessionRecord` (line 56): add `lastActivity?: number;`
  - `serializeTile`: include `...(t.lastActivity !== undefined ? { lastActivity: t.lastActivity } : {})`
  - `restoreRecord`: pass `initialLastActivity: rec.lastActivity` into the `TerminalTile` it constructs — a restored-but-untouched hidden session MUST keep its old stamp, not get a fresh one.
- [ ] **Step 6: Typecheck + full suite** — `npx tsc -noEmit -skipLibCheck` clean; `npm test` green.
- [ ] **Step 7: Commit** — `git commit -am "feat: lastActivity stamping with replay-window guard, persisted per session"`

### Task 5: Final verification (NO build/install)

- [ ] **Step 1:** `npm test` → every file green.
- [ ] **Step 2:** `npx tsc -noEmit -skipLibCheck` → clean.
- [ ] **Step 3:** Report done. Do NOT run `npm run build` / `dist` / `install-local` — the user triggers installs personally.
