import * as fsSync from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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
