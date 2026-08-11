import * as fsSync from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { removeWorktreeAndBranch } from './worktree-manager';

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

export interface SweepDeps {
	removeWorktree?: (repoPath: string, worktreePath: string, branch: string) => Promise<void>;
	probe?: (worktreePath: string) => number;
}

/** Boot-time purge of hidden terminals idle >= 5 days (spec 2026-08-10). Callers should run
 *  this before any session-owning UI (e.g. TerminalsGrid) exists, so a purged session never
 *  gets a chance to spawn a process. Never throws: an unreadable OR malformed sessions file
 *  (valid JSON that isn't a plain `{ [ws]: PurgeRecord[] }` object — `null`, an array, a
 *  string, `{"ws": 42}`, ...) must not brick startup, and neither can a failed worktree
 *  deletion — both degrade gracefully to "nothing changed" instead of throwing. */
export async function sweepStaleSessions(sessionsFile: string, deps: SweepDeps = {}): Promise<string | null> {
	const removeWorktree = deps.removeWorktree ?? removeWorktreeAndBranch;
	const probe = deps.probe ?? probeWorktreeActivity;
	let raw: unknown;
	try { raw = JSON.parse(await fsp.readFile(sessionsFile, 'utf8')); } catch { return null; }
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const all = raw as Record<string, PurgeRecord[]>;
	let purged = 0; let failed = 0; let changed = false;
	for (const ws of Object.keys(all)) {
		const entries = all[ws];
		if (!Array.isArray(entries)) continue; // malformed per-workspace value — skip, don't throw
		const { keep, purge, missing } = partitionStale(entries, Date.now(), probe);
		if (purge.length === 0 && missing.length === 0) continue;
		changed = true;
		all[ws] = keep;
		purged += purge.length + missing.length;
		for (const e of purge) {
			try { await removeWorktree(e.repoPath!, e.worktreePath!, e.branch!); }
			catch { failed++; }
		}
	}
	if (!changed) return null;
	await fsp.writeFile(sessionsFile, JSON.stringify(all, null, 2), 'utf8');
	return `Auto-purged ${purged} hidden session${purged === 1 ? '' : 's'} (idle 5+ days)` + (failed ? ` — ${failed} worktree cleanup${failed === 1 ? '' : 's'} failed` : '');
}
