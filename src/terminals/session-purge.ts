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
