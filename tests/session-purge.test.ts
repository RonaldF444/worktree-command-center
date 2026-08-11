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
