import { SessionBridge, safeSessionEnv } from './session-bridge';
import { parseUsage, stripAnsi, type UsageReadout } from './usage-parse';

export interface UsageProbeOpts { sidecarPath: string; cwd: string; sessionEnv?: () => Record<string, string>; }

/** Drives a hidden `claude` session to read `/usage` on demand — a FRESH session per
 *  refresh: the CLI fetches limit data once per process and re-renders that snapshot on
 *  every reopen, so a reused session can never show new numbers (verified empirically —
 *  two /usage passes in one live session came back byte-identical with no re-fetch).
 *  `/usage` is a local command — this consumes no tokens. No worktree, no UI. */
export class UsageProbe {
	private bridge: SessionBridge | null = null;
	private buf = '';
	private ready = false;

	constructor(private opts: UsageProbeOpts) {}

	private ensureSession(): Promise<void> {
		if (this.bridge && this.ready) return Promise.resolve();
		if (!this.bridge) {
			const b = new SessionBridge(this.opts.sidecarPath, this.opts.cwd, 'claude', [], safeSessionEnv(this.opts.sessionEnv));
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

	/** Refresh: boot a session, open /usage, wait for the scan to settle, scrape, then kill
	 *  the session — the next refresh must be a new process to get a fresh fetch. */
	async refresh(): Promise<UsageReadout> {
		return this.refreshOnce(true);
	}

	private async refreshOnce(retryOnEmpty: boolean): Promise<UsageReadout> {
		await this.ensureSession();
		const b = this.bridge;
		if (!b) throw new Error('usage probe: session unavailable');
		this.buf = '';
		// Submit like TerminalTile.sendLine: text first, then a SEPARATED Enter on a later tick.
		// Bundling "/usage\r" into one write makes the sidecar/ConPTY coalesce it so the \r lands
		// as a pasted newline that never submits — which is why the battery read 0 (it never ran).
		b.write('/usage');
		// 200ms: match TerminalTile.sendLine — the new TUI's wider paste window eats a fast \r.
		window.setTimeout(() => this.bridge?.write('\r'), 200);
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
		this.dispose(); // fresh session per refresh — see the class comment
		// A first-ever session in the probe dir boots into claude's trust prompt, which eats
		// the /usage keystrokes (the Enter accepts the prompt — our own empty dir, safe). One
		// retry in the now-trusted dir self-heals that, and any other transient empty readout.
		if (readout.sessionPct === null && retryOnEmpty) return this.refreshOnce(false);
		return readout;
	}

	dispose(): void { this.bridge?.kill(); this.bridge = null; this.ready = false; }
}
