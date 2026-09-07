import { ReplayBuffer } from './replay-buffer';

export type TapKey = string;
export interface TapDeps {
	emit: (channel: string, payload: unknown) => void;
	batchMs?: number;
	maxChars?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}
export const RESTART_MARKER = '\r\n\x1b[2m— restarted —\x1b[0m\r\n';

/** Desktop-side tap on every terminal's output. Each key (one tile or Kane, per workspace) keeps
 *  a ReplayBuffer so a browser that attaches later gets scrollback; while at least one browser
 *  is connected, chunks are batched per key for `batchMs` and emitted as ONE `tile:data` event,
 *  so a chatty floor does not turn into one IPC message per PTY read. Pure: timers injectable. */
export class RemoteTap {
	private buffers = new Map<TapKey, ReplayBuffer>();
	private pending = new Map<TapKey, string[]>();
	private timer: unknown = null;
	private clients = 0;
	private readonly batchMs: number;
	private readonly setTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (h: unknown) => void;

	constructor(private deps: TapDeps) {
		this.batchMs = deps.batchMs ?? 16;
		this.setTimer = deps.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
		this.clearTimer = deps.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	setClientCount(n: number): void { this.clients = n; }
	keys(): TapKey[] { return [...this.buffers.keys()]; }

	private buf(key: TapKey): ReplayBuffer {
		let b = this.buffers.get(key);
		if (!b) { b = new ReplayBuffer(this.deps.maxChars); this.buffers.set(key, b); }
		return b;
	}

	push(key: TapKey, chunk: string): void {
		if (!chunk) return;
		this.buf(key).push(chunk);
		if (this.clients <= 0) return;
		let q = this.pending.get(key);
		if (!q) { q = []; this.pending.set(key, q); }
		q.push(chunk);
		if (this.timer === null) this.timer = this.setTimer(() => this.flush(), this.batchMs);
	}

	private flush(): void {
		this.timer = null;
		const batch = this.pending; this.pending = new Map();
		for (const [key, chunks] of batch) this.deps.emit('tile:data', { key, chunk: chunks.join('') });
	}

	restart(key: TapKey): void {
		this.buf(key).clear();
		this.pending.delete(key);
		this.push(key, RESTART_MARKER);
	}

	snapshot(key: TapKey): string { return this.buffers.get(key)?.snapshot() ?? ''; }

	detach(key: TapKey): void {
		this.buffers.delete(key);
		this.pending.delete(key);
		this.deps.emit('tile:exit', { key });
	}
}
