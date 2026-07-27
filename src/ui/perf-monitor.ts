import * as fs from 'fs';

/** Renderer-aging telemetry: one JSON line every few minutes into perf-log.jsonl (userData),
 *  so a long-lived instance's degradation (heap growth, DOM bloat) can be diagnosed after the
 *  fact instead of guessed at. Pure line formatting is split out so it unit-tests cleanly. */

interface HeapInfo { usedJSHeapSize: number; totalJSHeapSize: number; }

export function perfSampleLine(nowMs: number, startMs: number, heap: HeapInfo | null, domNodes: number): string {
	return JSON.stringify({
		t: new Date(nowMs).toISOString(),
		uptimeMin: Math.round((nowMs - startMs) / 60_000),
		heapUsedMB: heap ? Math.round(heap.usedJSHeapSize / 1_048_576) : null,
		heapTotalMB: heap ? Math.round(heap.totalJSHeapSize / 1_048_576) : null,
		domNodes,
	});
}

/** One line per detected main-thread stall: `kind` is 'longtask' (JS blocked — the observer
 *  attributes it) or 'gap' (heartbeat starved without a longtask — compositor/GPU side). */
export function perfStallLine(nowMs: number, kind: 'longtask' | 'gap', ms: number): string {
	return JSON.stringify({ t: new Date(nowMs).toISOString(), stall: kind, ms: Math.round(ms) });
}

const ROTATE_BYTES = 512 * 1024; // keep at most ~2 files of history; telemetry must stay tiny

export class PerfMonitor {
	private timer: number | null = null;
	private heartbeat: number | null = null;
	private longTasks: PerformanceObserver | null = null;
	private lastBeat = 0;
	private lastLongTaskAt = 0;
	private readonly startMs = Date.now();

	constructor(private logPath: string) {}

	begin(intervalMs = 300_000): void {
		if (this.timer !== null) return;
		this.timer = window.setInterval(() => this.sample(), intervalMs);
		// Stall detection. Long tasks = JS blocking the main thread ≥50ms (log ≥250ms).
		try {
			this.longTasks = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					if (e.duration >= 250) { this.lastLongTaskAt = Date.now(); this.append(perfStallLine(Date.now(), 'longtask', e.duration)); }
				}
			});
			this.longTasks.observe({ entryTypes: ['longtask'] });
		} catch { /* longtask observer unsupported — heartbeat still runs */ }
		// Heartbeat: a 100ms tick arriving very late WITHOUT a recent longtask points at the
		// frame/compositor side (GPU starvation, vsync stalls) rather than our JS.
		this.lastBeat = Date.now();
		this.heartbeat = window.setInterval(() => {
			const now = Date.now();
			const gap = now - this.lastBeat;
			this.lastBeat = now;
			if (gap >= 350 && now - this.lastLongTaskAt > 2_000) this.append(perfStallLine(now, 'gap', gap - 100));
		}, 100);
	}

	dispose(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.heartbeat !== null) { window.clearInterval(this.heartbeat); this.heartbeat = null; }
		this.longTasks?.disconnect();
		this.longTasks = null;
	}

	private sample(): void {
		try {
			// performance.memory is Chromium-only (fine here) but typed nowhere — feature-detect.
			const heap = ((performance as unknown as { memory?: HeapInfo }).memory) ?? null;
			this.append(perfSampleLine(Date.now(), this.startMs, heap, document.getElementsByTagName('*').length));
		} catch { /* telemetry must never break the app */ }
	}

	private append(line: string): void {
		try {
			try {
				if (fs.existsSync(this.logPath) && fs.statSync(this.logPath).size > ROTATE_BYTES) {
					fs.renameSync(this.logPath, `${this.logPath}.1`); // clobbers the previous .1
				}
			} catch { /* rotation is best-effort */ }
			fs.appendFileSync(this.logPath, line + '\n', 'utf8');
		} catch { /* telemetry must never break the app */ }
	}
}
