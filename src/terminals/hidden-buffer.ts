/** Pending-output buffer for a suspended (hidden / workspace-detached) terminal tile.
 *
 *  While a tile is offscreen its PTY output is accumulated here instead of being parsed by
 *  xterm, and flushed in one batched write on a slow cadence (and on reveal). If a flush
 *  window overflows `capBytes`, the whole window is superseded — the flicker-free TUI keeps
 *  everything on the alternate screen, so the caller recovers the CURRENT screen with a
 *  resize nudge (ConPTY re-emits it) instead of parsing megabytes of stale frames. */
export class HiddenOutputBuffer {
	private chunks: string[] = [];
	private bytes = 0;
	private droppedSinceTake = false;

	constructor(private capBytes = 256 * 1024) {}

	/** Append a PTY chunk. Overflowing the cap discards the whole pending window (the
	 *  overflowing chunk included) and marks it dropped — accumulation restarts fresh. */
	push(chunk: string): void {
		this.bytes += chunk.length;
		if (this.bytes > this.capBytes) {
			this.chunks = [];
			this.bytes = 0;
			this.droppedSinceTake = true;
			return;
		}
		this.chunks.push(chunk);
	}

	/** Drain: pending data in arrival order + whether any window was dropped since the
	 *  last take. Resets both. */
	takeAll(): { data: string; dropped: boolean } {
		const out = { data: this.chunks.join(''), dropped: this.droppedSinceTake };
		this.chunks = [];
		this.bytes = 0;
		this.droppedSinceTake = false;
		return out;
	}

	/** Discard everything, including the dropped flag (session restart). */
	clear(): void {
		this.chunks = [];
		this.bytes = 0;
		this.droppedSinceTake = false;
	}
}
