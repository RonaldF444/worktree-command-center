import { SessionBridge } from './session-bridge';
import { parseUsage, stripAnsi, type UsageReadout } from './usage-parse';

export interface UsageProbeOpts { sidecarPath: string; cwd: string; }

/** Drives a hidden, reused `claude` session to read `/usage` on demand. `/usage` is a local
 *  command — this consumes no tokens. No worktree, no UI. */
export class UsageProbe {
	private bridge: SessionBridge | null = null;
	private buf = '';
	private ready = false;

	constructor(private opts: UsageProbeOpts) {}

	private ensureSession(): Promise<void> {
		if (this.bridge && this.ready) return Promise.resolve();
		if (!this.bridge) {
			const b = new SessionBridge(this.opts.sidecarPath, this.opts.cwd, 'claude', [], {});
			this.bridge = b;
			b.onData((d) => { this.buf += d; });
			b.onExit(() => { this.bridge = null; this.ready = false; });
			b.onReady(() => { this.ready = true; });
			b.start();
		}
		// Resolve on first ready, or after a boot timeout (claude takes a few seconds).
		return new Promise((resolve) => {
			const started = Date.now();
			const iv = window.setInterval(() => {
				if (this.ready || Date.now() - started > 9000) { window.clearInterval(iv); resolve(); }
			}, 200);
		});
	}

	/** Refresh: open /usage, wait for the scan to settle, scrape, Esc out, return the readout. */
	async refresh(): Promise<UsageReadout> {
		await this.ensureSession();
		const b = this.bridge;
		if (!b) throw new Error('usage probe: session unavailable');
		this.buf = '';
		b.write('/usage\r');
		const readout = await new Promise<UsageReadout>((resolve) => {
			const started = Date.now();
			const iv = window.setInterval(() => {
				const r = parseUsage(this.buf);
				const tail = stripAnsi(this.buf).slice(-200);
				const settled = r.sessionPct !== null && r.sessionReset !== null && !/scanning|refreshing/i.test(tail);
				if (settled || Date.now() - started > 12000) {
					window.clearInterval(iv);
					resolve(parseUsage(this.buf));
				}
			}, 400);
		});
		b.write('\x1b'); // leave the usage view so the session is reusable
		return readout;
	}

	dispose(): void { this.bridge?.kill(); this.bridge = null; this.ready = false; }
}
