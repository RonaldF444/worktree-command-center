/** Debounce + dedupe the xterm fit→pty-resize cycle.
 *
 *  Why this exists: tiles animate their size over ~0.5s (CSS transition), so a single
 *  click-to-center fires ResizeObserver dozens of times. Resizing the PTY on every tick
 *  makes ConPTY repaint the whole viewport each time, and those repaints pile up in the
 *  xterm scrollback as duplicated, multi-width garble. We instead coalesce a burst into a
 *  SINGLE fit after the size settles, and skip the pty resize entirely when the computed
 *  cols/rows haven't actually changed (e.g. a position-only move). */
export interface FitThrottleDeps {
	fit: () => void;                                    // run the xterm FitAddon (sync)
	dims: () => { cols: number; rows: number };         // terminal dims to read AFTER fit
	resize: (cols: number, rows: number) => void;       // push the new size to the PTY
	delayMs?: number;                                   // quiet period before committing (default 120)
	setTimer?: (cb: () => void, ms: number) => number;  // injectable for tests
	clearTimer?: (id: number) => void;
}

export class FitThrottle {
	private timer: number | null = null;
	private lastCols = -1;
	private lastRows = -1;
	private readonly delay: number;
	private readonly setTimer: (cb: () => void, ms: number) => number;
	private readonly clearTimer: (id: number) => void;

	constructor(private deps: FitThrottleDeps) {
		this.delay = deps.delayMs ?? 120;
		this.setTimer = deps.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number);
		this.clearTimer = deps.clearTimer ?? ((id) => globalThis.clearTimeout(id));
	}

	/** Request a fit. A burst of these collapses into one fit `delayMs` after the last call. */
	schedule(): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => { this.timer = null; this.run(); }, this.delay);
	}

	private run(): void {
		try {
			this.deps.fit();
			const { cols, rows } = this.deps.dims();
			if (cols > 0 && rows > 0 && (cols !== this.lastCols || rows !== this.lastRows)) {
				this.lastCols = cols;
				this.lastRows = rows;
				this.deps.resize(cols, rows);
			}
		} catch { /* terminal not visible yet — a later resize will retry */ }
	}

	dispose(): void {
		if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
	}
}
