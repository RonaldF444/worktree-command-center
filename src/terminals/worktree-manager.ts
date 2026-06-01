import * as path from 'path';
import * as fsp from 'fs/promises';
import { runCommand } from '../command-runner';
import { isParkCommitSubject, parkCommitSubject } from './worktree-registry';

export interface WorktreeInfo {
	worktreePath: string;
	branch: string;
}

export function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function autoBranchName(baseBranch: string, n: number): string {
	return `wt/${slugify(baseBranch)}-${n}`;
}

/** The branch a repo's dropdown should default to: prefer `main`, then `master`
 *  (e.g. Backend), else the first listed branch. */
export function defaultBranch(branches: string[]): string | undefined {
	if (branches.includes('main')) return 'main';
	if (branches.includes('master')) return 'master';
	return branches[0];
}

export function worktreePathFor(repoPath: string, repoName: string, branch: string): string {
	const parent = path.dirname(repoPath);
	return path.join(parent, '.claude-worktrees', repoName, slugify(branch));
}

export function shouldRemoveWorktree(statusPorcelain: string, revListCount: number): boolean {
	return statusPorcelain.trim() === '' && revListCount === 0;
}

/** System-prompt text injected into each spawned session so the terminal knows
 *  what it is, that sibling terminals share the repo, and the cross-repo rule. */
export function terminalSystemPrompt(repoName: string, branch: string, worktreePath: string): string {
	return [
		'You are a Claude Code session running inside a dedicated git worktree that was created for you by the Worktree Command Center app. Keep these facts in mind for the whole session:',
		'',
		`- Identity: you are working in repo "${repoName}", on branch "${branch}", in the working directory "${worktreePath}". This worktree is yours — do your work here, on this branch.`,
		`- Parallelism: other Claude Code terminals are very likely open AT THE SAME TIME in this same "${repoName}" repo, each on its own separate worktree and branch. You are not the only one working in this repo. Do not assume exclusive ownership, expect branches and worktrees you did not create, and prefer rebasing/merging over assuming a clean shared state.`,
		'- Cross-repo rule: if your task requires changing a DIFFERENT repository, do NOT edit that other repo\'s primary checkout directly. Create a new git worktree in that repo (e.g. `git worktree add -b <branch> <path> <base>`) and make the changes there, mirroring how this terminal was set up. One worktree per repo you touch.',
		'',
		'Coordinating with the other terminals (they share resources with you):',
		'- A `cos-coord` command is on your PATH. Before any DESTRUCTIVE or EXCLUSIVE operation on a shared resource (a DB reset, a backtest/replay, an A/B run, a migration), first run `cos-coord status` to see what is active.',
		'- Then wrap the operation in a lock: `cos-coord acquire <area>:<thing> --reason "..." [--ttl <seconds>] && <your command> ; cos-coord release <area>:<thing>`. Resource names are lowercase `<area>:<thing>`, e.g. `db:reset`. If acquire fails, another terminal holds it — wait and retry, do not force it.',
		'- When a long task finishes, run `cos-coord note "..."` so other terminals stop waiting.',
		'- `git push` and `git worktree add` are locked for you automatically; if one is denied, wait a few seconds and retry.',
		'- `<coordDir>/worktrees.md` is the shared ledger of everyone\'s in-flight work — read it to see what other terminals have uncommitted before you touch shared files. Abandoned work is auto-parked as `wip:` commits on its branch.',
	].join('\n');
}

/** Branch names from `git branch`, current-branch marker and whitespace stripped. */
export async function listBranches(repoPath: string): Promise<string[]> {
	const r = await runCommand('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath, timeoutMs: 8000 });
	if (r.code !== 0) return [];
	return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** The .claude/settings.local.json content: the .cos-ready marker hook (Stop/Notification),
 *  the coordination hooks (PreToolUse acquire / PostToolUse release) on Bash, and a
 *  pre-approval of `cos-coord` so agents chat/coordinate with each other without prompting. */
export function settingsLocalJson(notifyScriptAbsPath: string, coordHookAbsPath: string): string {
	const ready = [{ hooks: [{ type: 'command', command: `node "${notifyScriptAbsPath}"` }] }];
	const coord = (extra: string) => [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${coordHookAbsPath}"${extra}` }] }];
	return JSON.stringify({
		permissions: { allow: ['Bash(cos-coord:*)'] }, // chatting/coordinating never needs approval
		hooks: { Stop: ready, Notification: ready, PreToolUse: coord(''), PostToolUse: coord(' --release') },
	}, null, 2);
}

/** Write the scoped hooks (ready marker + coordination) into a worktree. */
export async function writeReadyHook(worktreePath: string, notifyScriptAbsPath: string, coordHookAbsPath: string): Promise<void> {
	const dir = path.join(worktreePath, '.claude');
	await fsp.mkdir(dir, { recursive: true });
	await fsp.writeFile(path.join(dir, 'settings.local.json'), settingsLocalJson(notifyScriptAbsPath, coordHookAbsPath), 'utf8');
}

/** Create a fresh worktree on a NEW branch based on baseBranch. Throws on git failure. */
export async function createWorktree(
	repoPath: string, repoName: string, baseBranch: string, branch: string, notifyScriptAbsPath?: string, coordHookAbsPath?: string,
): Promise<WorktreeInfo> {
	const worktreePath = worktreePathFor(repoPath, repoName, branch);
	const r = await runCommand('git', ['worktree', 'add', worktreePath, '-b', branch, baseBranch], { cwd: repoPath, timeoutMs: 20000 });
	if (r.code !== 0) {
		throw new Error((r.error ?? r.stderr).split('\n')[0] || 'git worktree add failed');
	}
	if (notifyScriptAbsPath && coordHookAbsPath) {
		try { await writeReadyHook(worktreePath, notifyScriptAbsPath, coordHookAbsPath); } catch { /* hooks are best-effort */ }
	}
	return { worktreePath, branch };
}

/** Remove the worktree only if pristine; otherwise keep it. Returns the action taken. */
export async function removeWorktreeIfPristine(
	repoPath: string, worktreePath: string, baseBranch: string,
): Promise<'removed' | 'kept'> {
	const status = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath, timeoutMs: 8000 });
	const revs = await runCommand('git', ['rev-list', '--count', `${baseBranch}..HEAD`], { cwd: worktreePath, timeoutMs: 8000 });
	// Fail safe on both probes: if status OR rev-list errored, treat as NOT pristine so we never delete work we couldn't verify.
	const count = revs.code === 0 ? (parseInt(revs.stdout.trim() || '0', 10) || 0) : 1;
	if (!shouldRemoveWorktree(status.code === 0 ? status.stdout : ' M', count)) return 'kept';
	const rm = await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeoutMs: 15000 });
	return rm.code === 0 ? 'removed' : 'kept';
}

/** Hard-delete a worktree AND its branch — used on a manual × (the branch should die). */
export async function removeWorktreeAndBranch(
	repoPath: string, worktreePath: string, branch: string,
): Promise<void> {
	await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeoutMs: 15000 });
	await runCommand('git', ['branch', '-D', branch], { cwd: repoPath, timeoutMs: 8000 });
}

/** Auto-save a dirty worktree as a recoverable commit on ITS OWN branch. Returns the
 *  action taken. Never throws and never deletes — a failure keeps the worktree intact. */
export async function parkWorktree(worktreePath: string, nowIso: string): Promise<'parked' | 'clean' | 'failed'> {
	const status = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath, timeoutMs: 8000 });
	if (status.code !== 0) return 'failed';
	if (status.stdout.trim() === '') return 'clean';
	const add = await runCommand('git', ['add', '-A'], { cwd: worktreePath, timeoutMs: 15000 });
	if (add.code !== 0) return 'failed';
	const commit = await runCommand('git', ['commit', '-m', parkCommitSubject(nowIso), '--no-verify'], { cwd: worktreePath, timeoutMs: 15000 });
	return commit.code === 0 ? 'parked' : 'failed';
}

/** Restore parked work to uncommitted: if HEAD is a park commit, soft-reset it so the
 *  changes come back as they were. Recreates the worktree from the branch if its folder
 *  is gone. Safe — only ever soft-resets our own park commit. */
export async function reopenWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
	const probe = await runCommand('git', ['rev-parse', '--git-dir'], { cwd: worktreePath, timeoutMs: 8000 });
	if (probe.code !== 0) {
		await runCommand('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath, timeoutMs: 20000 });
	}
	const subj = await runCommand('git', ['log', '-1', '--pretty=%s'], { cwd: worktreePath, timeoutMs: 8000 });
	if (subj.code === 0 && isParkCommitSubject(subj.stdout.trim())) {
		await runCommand('git', ['reset', '--soft', 'HEAD~1'], { cwd: worktreePath, timeoutMs: 8000 });
	}
}
