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

	/** Refresh: boot a session, open /usage, wait for the readout to settle, scrape, then kill
	 *  the session — the next refresh must be a new process to get a fresh fetch. */
	async refresh(): Promise<UsageReadout> {
		return this.refreshOnce(true);
	}

	private static sleep(ms: number): Promise<void> {
		return new Promise((r) => window.setTimeout(r, ms));
	}

	/** Has the /usage screen actually opened? (v2.1.227 renders it as the Usage settings tab.) */
	private opened(): boolean {
		return /current\s*session/i.test(stripAnsi(this.buf));
	}

	private async refreshOnce(retryOnEmpty: boolean): Promise<UsageReadout> {
		await this.ensureSession();
		const b = this.bridge;
		if (!b) throw new Error('usage probe: session unavailable');
		this.buf = '';
		// SUBMIT-AND-VERIFY (2026-08-11): the v2.1.227 slash-command autocomplete eats or defers
		// a blind text-then-\r submission most of the time (empirically 1-in-4). So: close any
		// menu with Esc, type, Enter — then VERIFY the usage screen opened and retry if not.
		// The separated Enter still matters (a bundled "/usage\r" pastes and never submits).
		for (let attempt = 0; attempt < 3 && !this.opened(); attempt++) {
			this.bridge?.write('\x1b');
			await UsageProbe.sleep(250);
			this.bridge?.write('/usage');
			await UsageProbe.sleep(400); // let the autocomplete menu settle before Enter
			this.bridge?.write('\r');
			for (let i = 0; i < 20 && !this.opened(); i++) await UsageProbe.sleep(200);
			if (!this.opened()) { // a second Enter clears a menu that swallowed the first
				this.bridge?.write('\r');
				for (let i = 0; i < 15 && !this.opened(); i++) await UsageProbe.sleep(200);
			}
		}
		// SETTLE: session + week render as soon as the limits fetch lands; the Fable row only
		// joins after a further refresh pass, so give it a grace window and stop waiting on
		// plans that simply have no Fable section. The old "no scanning/refreshing in the tail"
		// check is gone: the accumulated stream buffer effectively always contains those words
		// on v2.1.227 (the local-session scan repaints continuously), so it never settled.
		const started = Date.now();
		let primarySince: number | null = null;
		let readout = parseUsage(this.buf);
		while (Date.now() - started < 30000) {
			readout = parseUsage(this.buf);
			const primary = readout.sessionPct !== null && readout.sessionReset !== null && readout.weekPct !== null;
			if (primary && primarySince === null) primarySince = Date.now();
			if (primary && (readout.fablePct !== null || Date.now() - primarySince! > 8000)) break;
			await UsageProbe.sleep(400);
		}
		this.dispose(); // fresh session per refresh — see the class comment
		// A first-ever session in the probe dir boots into claude's trust prompt, which eats
		// the /usage keystrokes (the Enter accepts the prompt — our own empty dir, safe). One
		// retry in the now-trusted dir self-heals that, and any other transient empty readout.
		if (readout.sessionPct === null && retryOnEmpty) return this.refreshOnce(false);
		return readout;
	}

	dispose(): void { this.bridge?.kill(); this.bridge = null; this.ready = false; }
}
