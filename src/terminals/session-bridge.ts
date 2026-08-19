import { ChildProcess, spawn } from 'child_process';

export interface Frame { t: string; [k: string]: unknown; }

export function encodeFrame(obj: Frame): string {
	return JSON.stringify(obj) + '\n';
}

export function decodeFrames(buffer: string): { frames: Frame[]; rest: string } {
	const frames: Frame[] = [];
	let rest = buffer;
	let i: number;
	while ((i = rest.indexOf('\n')) >= 0) {
		const line = rest.slice(0, i);
		rest = rest.slice(i + 1);
		if (!line.trim()) continue;
		try { frames.push(JSON.parse(line) as Frame); } catch { /* skip malformed */ }
	}
	return { frames, rest };
}

/**
 * Owns one sidecar child process running `claude` in a worktree via a PTY.
 * Spawns SYSTEM node (the `.exe` trick searches PATH and avoids Obsidian's
 * Electron execPath). Never throws on spawn failure — surfaces via onExit.
 */
export class SessionBridge {
	private proc: ChildProcess | null = null;
	private rxBuf = '';
	private onDataCb: ((utf8: string) => void) | null = null;
	private onExitCb: ((code: number | null) => void) | null = null;
	private onReadyCb: (() => void) | null = null;
	/** PID of the sidecar's PTY child (claude/cmd). On Windows the ConPTY child escapes the
	 *  sidecar's process tree, so kill() must tree-kill this PID directly or it leaks. */
	private childPid: number | undefined;

	constructor(
		private sidecarPath: string,
		private cwd: string,
		private command = 'claude',
		private args: string[] = [],
		private extraEnv: Record<string, string> = {},
	) {}

	onData(cb: (utf8: string) => void): void { this.onDataCb = cb; }
	onExit(cb: (code: number | null) => void): void { this.onExitCb = cb; }
	/** Fired when the sidecar detects the session has gone idle (waiting for input). */
	onReady(cb: () => void): void { this.onReadyCb = cb; }

	start(): void {
		const node = process.platform === 'win32' ? 'node.exe' : 'node';
		this.proc = spawn(node, [this.sidecarPath, this.cwd, this.command, ...this.args], {
			windowsHide: true,
			env: { ...process.env, ...this.extraEnv },
		});
		this.proc.stdout?.on('data', (d) => this.handleRx(d.toString('utf8')));
		this.proc.stderr?.on('data', () => { /* sidecar logs nothing to stderr normally */ });
		this.proc.on('error', (e) => this.onExitCb?.(this.exitFromError(e)));
		this.proc.on('exit', (code) => this.onExitCb?.(code));
	}

	write(utf8: string): void {
		this.send({ t: 'data', d: Buffer.from(utf8, 'utf8').toString('base64') });
	}

	resize(cols: number, rows: number): void {
		this.send({ t: 'resize', cols, rows });
	}

	kill(): void {
		// Tree-kill the PTY child FIRST — on Windows the ConPTY child (claude + its MCP-server
		// children) is NOT in the sidecar's process tree, so killing only the sidecar leaks it.
		// childPid is reported by the sidecar right after pty.spawn.
		const child = this.childPid;
		this.childPid = undefined;
		if (child !== undefined && process.platform === 'win32') {
			spawn('taskkill', ['/pid', String(child), '/T', '/F'], { windowsHide: true });
		}
		const pid = this.proc?.pid;
		if (pid === undefined) return;
		if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
		else { try { process.kill(-pid, 'SIGKILL'); } catch { this.proc?.kill('SIGKILL'); } }
		this.proc = null;
	}

	private send(frame: Frame): void {
		try { this.proc?.stdin?.write(encodeFrame(frame)); } catch { /* pipe closed */ }
	}

	private handleRx(chunk: string): void {
		const { frames, rest } = decodeFrames(this.rxBuf + chunk);
		this.rxBuf = rest;
		for (const f of frames) {
			if (f.t === 'data' && typeof f.d === 'string') {
				this.onDataCb?.(Buffer.from(f.d, 'base64').toString('utf8'));
			} else if (f.t === 'exit') {
				this.onExitCb?.(typeof f.code === 'number' ? f.code : 0);
			} else if (f.t === 'ready') {
				this.onReadyCb?.();
			} else if (f.t === 'pid' && typeof f.pid === 'number') {
				this.childPid = f.pid;
			}
		}
	}

	private exitFromError(e: Error): number {
		this.onDataCb?.(`\r\n[failed to start session: ${e.message}]\r\n`);
		return 1;
	}
}

/** Overlay-provided extra env for a spawn (see docs/superpowers/specs/2026-07-13-session-env-provider-design.md).
 *  Never throws; {} when unset or failing — a buggy provider must not break spawning. */
export function safeSessionEnv(fn?: () => Record<string, string>): Record<string, string> {
	try { return fn?.() ?? {}; } catch { return {}; }
}
