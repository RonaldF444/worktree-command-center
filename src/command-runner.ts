import { spawn } from 'child_process';

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	error?: string;
}

/**
 * Run a short, deterministic command (git, gh, psql, …) and resolve with its
 * output. This is the fast path that powers LIVE tiles — no LLM, no shell
 * quoting games.
 *
 * - `shell: false` + an explicit `.exe` on Windows so args are passed verbatim
 *   (no cmd.exe splitting spaces or expanding `%`), while PATH is still
 *   searched by libuv. This is why git pretty-formats with spaces work.
 * - Never rejects: failures come back as `{ code, error }` so a provider can
 *   degrade gracefully per-command.
 * - Hard timeout with a Windows tree-kill so a wedged command can't hang a tile.
 */
export function runCommand(
	command: string,
	args: string[],
	opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
	// In the RENDERER, delegate to the main process: spawn() blocks the calling thread for
	// the whole CreateProcess syscall (~50-100ms each with AV scanning), and repo scans
	// profiled at 95% of renderer self-time as `spawn` during fleet activity (2026-07-22).
	// Main absorbs the block; the UI thread stays live. When this module is bundled into
	// MAIN there is no wcc bridge, so the local spawn path below runs.
	const bridge = (globalThis as { wcc?: { runCommand?: (c: string, a: string[], o?: object) => Promise<CommandResult> } }).wcc;
	if (bridge?.runCommand) return bridge.runCommand(command, args, opts);
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const exe = process.platform === 'win32' ? `${command}.exe` : command;

	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawn(exe, args, { cwd: opts.cwd, windowsHide: true });
		} catch (err) {
			resolve({ stdout: '', stderr: '', code: null, timedOut: false, error: (err as Error).message });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		const done = (r: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};

		const timer = setTimeout(() => {
			killTree(proc.pid);
			done({ stdout, stderr, code: null, timedOut: true, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);

		proc.stdout?.on('data', (d) => (stdout += d.toString()));
		proc.stderr?.on('data', (d) => (stderr += d.toString()));
		proc.on('error', (err) => done({ stdout, stderr, code: null, timedOut: false, error: err.message }));
		proc.on('exit', (code) => done({ stdout, stderr, code, timedOut: false }));
	});
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		if (process.platform === 'win32') {
			spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		/* best effort */
	}
}
