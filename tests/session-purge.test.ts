import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { partitionStale, PURGE_AFTER_MS, sweepStaleSessions } from '../src/terminals/session-purge';
import { shouldStampOutput, REPLAY_WINDOW_MS } from '../src/terminals/session-purge';

describe('shouldStampOutput', () => {
	it('ignores output inside the replay window, stamps after', () => {
		const spawn = 1_800_000_000_000;
		expect(shouldStampOutput(spawn, spawn + REPLAY_WINDOW_MS - 1)).toBe(false);
		expect(shouldStampOutput(spawn, spawn + REPLAY_WINDOW_MS + 1)).toBe(true);
	});
});

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
	it('does not throw on a null element (JSON.stringify turns undefined array holes into null); drops it, still purges a valid neighbor', () => {
		let calls = 0;
		const r = partitionStale([null, t({ lastActivity: OLD })] as never, NOW, () => { calls++; return 0; });
		expect(r.purge.length).toBe(1);
		expect(r.keep.length).toBe(0);
		expect(r.missing).toContain(null);
		expect(calls).toBe(0); // the null entry must never reach the probe
	});
	it('does not throw on other non-object elements (string/number) either — `typeof` scalars route to missing', () => {
		const rows = ['oops', 42] as never;
		expect(() => partitionStale(rows, NOW, () => 0)).not.toThrow();
		const r = partitionStale(rows, NOW, () => 0);
		expect(r.keep.length).toBe(0);
		expect(r.missing.length).toBe(2);
	});
	it('an array element is `typeof object` (not null) so it is kept, not treated as poison — no throw either way', () => {
		const rows = [['nested']] as never;
		expect(() => partitionStale(rows, NOW, () => 0)).not.toThrow();
		const r = partitionStale(rows, NOW, () => 0);
		expect(r.keep.length).toBe(1);
	});
});

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

describe('sweepStaleSessions', () => {
	let dir: string; let file: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));
		file = path.join(dir, '.terminal-sessions.json');
	});
	afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	const write = (data: unknown): void => fs.writeFileSync(file, JSON.stringify(data), 'utf8');
	const readAll = (): Record<string, unknown[]> => JSON.parse(fs.readFileSync(file, 'utf8'));
	// sweepStaleSessions calls the real Date.now() internally (unlike partitionStale, which takes
	// `now` as an injected param) — so these must be real-clock-relative, NOT the fake NOW/OLD/FRESH
	// constants above (those are calibrated to a fixed fake "now" used only for partitionStale).
	const REAL_OLD = Date.now() - PURGE_AFTER_MS - 60_000;
	const REAL_FRESH = Date.now() - 1000;

	it('(a) purges an old hidden terminal entry: rewrites file, calls removeWorktree with its identity, singular message', async () => {
		write({ default: [t({ lastActivity: REAL_OLD })] });
		const calls: Array<[string, string, string]> = [];
		const msg = await sweepStaleSessions(file, { removeWorktree: async (r, w, b) => { calls.push([r, w, b]); } });
		expect(msg).toBe('Auto-purged 1 hidden session (idle 5+ days)');
		expect(calls).toEqual([['C:\\repo', 'C:\\wt\\x', 'wt/x']]);
		expect(readAll().default).toEqual([]);
	});

	it('(b) drops a missing-worktree entry (probe = -1), counts it, never calls removeWorktree', async () => {
		write({ default: [t({})] }); // no lastActivity -> probed
		let removeCalls = 0;
		const msg = await sweepStaleSessions(file, { probe: () => -1, removeWorktree: async () => { removeCalls++; } });
		expect(msg).toBe('Auto-purged 1 hidden session (idle 5+ days)');
		expect(removeCalls).toBe(0);
		expect(readAll().default).toEqual([]);
	});

	it('(c) an all-fresh file returns null and leaves the file bytes untouched', async () => {
		write({ default: [t({ lastActivity: REAL_FRESH })] });
		const before = fs.readFileSync(file, 'utf8');
		const msg = await sweepStaleSessions(file, { removeWorktree: async () => { throw new Error('must not be called'); } });
		expect(msg).toBeNull();
		expect(fs.readFileSync(file, 'utf8')).toBe(before);
	});

	it('(d) a file containing the literal JSON `null` returns null without throwing', async () => {
		write(null);
		await expect(sweepStaleSessions(file)).resolves.toBeNull();
	});

	it('(e) an absent sessions file returns null', async () => {
		await expect(sweepStaleSessions(path.join(dir, 'does-not-exist.json'))).resolves.toBeNull();
	});

	it('(f) a rejecting removeWorktree still drops the entry and reports the failure count', async () => {
		write({ default: [t({ lastActivity: REAL_OLD })] });
		const msg = await sweepStaleSessions(file, { removeWorktree: async () => { throw new Error('boom'); } });
		expect(msg).toBe('Auto-purged 1 hidden session (idle 5+ days) — 1 worktree cleanup failed');
		expect(readAll().default).toEqual([]);
	});

	it('(g) pluralizes "sessions" when more than one is purged', async () => {
		const rows = [
			t({ worktreePath: 'C:\\wt\\a', branch: 'wt/a', lastActivity: REAL_OLD }),
			t({ worktreePath: 'C:\\wt\\b', branch: 'wt/b', lastActivity: REAL_OLD }),
		];
		write({ default: rows });
		const msg = await sweepStaleSessions(file, { removeWorktree: async () => {} });
		expect(msg).toBe('Auto-purged 2 hidden sessions (idle 5+ days)');
	});

	it('skips a per-workspace value that is not an array instead of throwing', async () => {
		write({ default: 42 });
		await expect(sweepStaleSessions(file)).resolves.toBeNull();
	});

	it('(h) a `null` entry inside a workspace array does not brick the sweep: no throw, file rewritten without it', async () => {
		write({ default: [null] });
		const msg = await sweepStaleSessions(file, { removeWorktree: async () => { throw new Error('must not be called for a null entry'); } });
		expect(msg).toBe('Auto-purged 1 hidden session (idle 5+ days)');
		expect(readAll().default).toEqual([]);
	});

	it('(i) a `null` entry alongside a real stale entry: both are dropped, only the real one triggers removeWorktree', async () => {
		write({ default: [null, t({ lastActivity: REAL_OLD })] });
		const calls: Array<[string, string, string]> = [];
		const msg = await sweepStaleSessions(file, { removeWorktree: async (r, w, b) => { calls.push([r, w, b]); } });
		expect(msg).toBe('Auto-purged 2 hidden sessions (idle 5+ days)');
		expect(calls).toEqual([['C:\\repo', 'C:\\wt\\x', 'wt/x']]);
		expect(readAll().default).toEqual([]);
	});
});
