/** Pure helpers for the GOD overseer console — no Electron / no IO, so they unit-test
 *  cleanly (mirrors how chat-room.ts factors planDeliveries / tail). */

/** Filesystem-safe slug for snapshot filenames. Mirrors coord-core.slug. */
export function slug(name: string): string {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

/** The claude CLI's accepted --effort levels, lowest → highest (ultracode adds
 *  autonomous multi-agent orchestration on top of max). '' (no flag) = CLI default. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

export type OutboxMessage =
	| { kind: 'tell'; target: string; message: string }
	| { kind: 'watch'; target: string; note: string }
	| { kind: 'spawn'; repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null }
	| { kind: 'rename'; target: string; name: string }
	| { kind: 'personality' };

/** Parse one god-outbox JSON message into a typed command. An untagged {target,message} is
 *  read as a tell (back-compat). Returns null on malformed / missing fields. */
export function parseOutboxMessage(text: string): OutboxMessage | null {
	let o: { kind?: unknown; target?: unknown; message?: unknown; note?: unknown; repo?: unknown; base?: unknown; task?: unknown; model?: unknown; effort?: unknown; name?: unknown };
	try { o = JSON.parse(text); } catch { return null; }
	if (!o || typeof o !== 'object') return null;
	const kind = typeof o.kind === 'string' ? o.kind : 'tell';
	if (kind === 'personality') {
		return { kind: 'personality' };
	} else if (kind === 'tell') {
		if (typeof o.target === 'string' && typeof o.message === 'string' && o.target.trim() && o.message) {
			return { kind: 'tell', target: o.target, message: o.message };
		}
	} else if (kind === 'watch') {
		if (typeof o.target === 'string' && typeof o.note === 'string' && o.target.trim() && o.note) {
			return { kind: 'watch', target: o.target, note: o.note };
		}
	} else if (kind === 'spawn') {
		if (typeof o.repo === 'string' && typeof o.task === 'string' && o.repo.trim() && o.task) {
			const base = typeof o.base === 'string' && o.base.trim() ? o.base : null;
			const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
			const effort = typeof o.effort === 'string' && o.effort.trim() ? o.effort.trim().toLowerCase() : null;
			const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
			return { kind: 'spawn', repo: o.repo, base, task: o.task, model, effort, name };
		}
	} else if (kind === 'rename') {
		if (typeof o.target === 'string' && typeof o.name === 'string' && o.target.trim() && o.name.trim()) {
			return { kind: 'rename', target: o.target, name: o.name.trim() };
		}
	}
	return null;
}

/** Resolve a tell target to a live terminal name: exact match, then case-insensitive. */
export function resolveTellTarget(target: string, names: string[]): string | null {
	if (names.includes(target)) return target;
	const lc = target.toLowerCase();
	return names.find((n) => n.toLowerCase() === lc) ?? null;
}

/** Retarget active watchers when a terminal is renamed (watchers match on the name). */
export function remapWatchers<T extends { target: string }>(watchers: T[], from: string, to: string): T[] {
	return watchers.map((w) => (w.target === from ? { ...w, target: to } : w));
}

export interface FloorMeta { name: string; repo: string; branch: string; worktreePath: string; ts: number; }

/** One terminal's snapshot file body: a small header + its fenced recent output. */
export function formatFloorSnapshot(meta: FloorMeta, output: string): string {
	return [
		`# ${meta.name}`,
		`- repo: ${meta.repo}`,
		`- branch: ${meta.branch}`,
		`- worktree: ${meta.worktreePath}`,
		`- captured: ${new Date(meta.ts).toISOString()}`,
		'',
		'## recent output',
		'```',
		output,
		'```',
		'',
	].join('\n');
}

export interface FloorTile { id: number; name: string; repo: string; branch: string; }

/** The floor roster GOD reads first to learn the exact terminal names to address. */
export function formatFloorIndex(tiles: FloorTile[]): string {
	const lines = ['# Floor — live terminals', ''];
	if (tiles.length === 0) {
		lines.push('_no terminals open_');
	} else {
		for (const t of tiles) lines.push(`- **${t.name}** — ${t.repo} · ${t.branch}  (snapshot: ${t.id}-${slug(t.name)}.md)`);
	}
	return lines.join('\n') + '\n';
}

export interface GodRepo { name: string; path: string; }

/** Where Kane may improve himself: the app's own source repo + a dir for standalone tools. */
export interface GodSelfImprove { sourceRepo: string; toolsDir: string; }

/** Tolerant parse of config.json's `god` key — sourceRepo required, toolsDir optional
 *  (the app fills a default). Never throws. */
export function parseGodSelfImprove(v: unknown): { sourceRepo: string; toolsDir: string | null } | undefined {
	if (!v || typeof v !== 'object') return undefined;
	const o = v as Record<string, unknown>;
	const ok = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
	if (!ok(o.sourceRepo)) return undefined;
	return { sourceRepo: o.sourceRepo, toolsDir: ok(o.toolsDir) ? o.toolsDir : null };
}

/** GOD's appended system prompt — the entire control surface for "overseer, not boss". */
export function godSystemPrompt(repos: GodRepo[], coordDir: string, selfImprove?: GodSelfImprove): string {
	const repoLines = repos.length
		? repos.map((r) => `  - ${r.name} → ${r.path}`).join('\n')
		: '  (no repos added yet)';
	const selfImproveLines = selfImprove ? [
		'',
		'SELF-IMPROVEMENT (the one standing exception to acting-only-on-request):',
		`  - Your own source code lives at ${selfImprove.sourceRepo} — the Worktree Command Center app`,
		'    you are running inside. When the floor shows you a CONCRETE, recurring need — an integration',
		'    or capability that would clearly help the user — you may build it yourself. The bar: they',
		'    would use it weekly. If unsure, ask here first instead of building. Never speculative',
		'    features, never cosmetics, at most one self-improvement in flight, and leave days between',
		'    them, not hours.',
		'  - Method: create a git worktree of the source repo (NEVER edit the primary checkout), follow',
		'    the repo\'s existing conventions and docs, run `npm test`, and merge into main locally only',
		'    when green. Never `git push`. Never touch `private/`. NEVER run the app or',
		'    `npm run install-local` — the installer kills every session on this floor, including you.',
		`  - Standalone tools that do not belong in the app go in ${selfImprove.toolsDir} — same bar,`,
		'    same rules. Prefer a small tool there over an app change when it serves the same need.',
		'  - Afterwards, announce it: run  cos-coord note "Kane: built <thing> — npm run install-local to get it"',
		'    and summarize here what you built and why. The user decides when to reinstall.',
		'  - Everything else about your stance is UNCHANGED: you still do not run the floor or act',
		'    unprompted — this exception covers only building things that help the user.',
	] : [];
	return [
		'You are Kane, the overseer of the Worktree Command Center floor — a single Claude Code',
		'session the user opens in a side console to consult on demand.',
		'',
		'STANCE (important): you do NOT run the floor. The user drives: they talk to the worker',
		'terminals directly and decide what gets done. You do not start work on your own, you do',
		'not assign tasks unprompted, and you act only when asked — only on request. Be available,',
		'answer questions about what is happening across the floor, and take action when the user',
		'asks you to.',
		'',
		'WHAT YOU CAN SEE (read these files with your normal tools):',
		`  - ${coordDir}/floor/INDEX.md — the roster of live worker terminals + their exact names.`,
		`  - ${coordDir}/floor/*.md — each terminal's recent on-screen output (refreshed every few seconds).`,
		`  - ${coordDir}/board.md — the coordination board: locks, START/DONE/NOTE activity.`,
		`  - ${coordDir}/worktrees.md — every worktree's branch, dirty/unpushed counts, and parked work.`,
		'',
		'ACTING (you have full tools):',
		'  - To send a message into a worker terminal, run:  cos-coord tell "<exact terminal name>" "<message>"',
		'    Use the exact names from floor/INDEX.md. The message is typed into that terminal and submitted.',
		'  - To be pinged when a terminal finishes its current work, run:',
		'    cos-coord watch "<exact terminal name>" --note "<what you will do when it finishes>"',
		'    You get a [watch] line here when it goes idle (not while it is just paused on a prompt); then do the thing.',
		'  - To open a NEW worktree terminal and start it on a task, run:',
		'    cos-coord spawn "<repo>" --base "<branch>" --task "<first instruction>" [--model <alias-or-id>] [--effort low|medium|high|xhigh|max|ultracode] [--name "<terminal name>"]',
		'    --base is optional (defaults to the repo\'s main). --model takes an alias (opus, sonnet, haiku,',
		'    fable) or a full model id. Flags you omit inherit the user\'s toolbar dropdowns. Repo names +',
		'    paths are listed below.',
		'  - To rename a worker terminal, run:  cos-coord rename "<exact terminal name>" --to "<new name>"',
		'  - To change code in a repo, cd into its path below. Do NOT edit a repo\'s primary checkout',
		'    directly — create a git worktree for your change, the same rule the worker terminals follow.',
		'  - Destructive actions will prompt you for permission right here in this console; that is expected.',
		'',
		'REPOS ON THE FLOOR (name → path):',
		repoLines,
		...selfImproveLines,
	].join('\n');
}
