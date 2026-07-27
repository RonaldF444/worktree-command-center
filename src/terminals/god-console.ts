import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { activeTerminalPalette, activeTerminalFont, type TerminalPalette } from './theme-store';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge, safeSessionEnv } from './session-bridge';
import { readClipboardText, writeClipboardText } from './clipboard';
import { godSystemPrompt, type GodRepo, type GodSelfImprove } from './god';
import { scrollIntentForKey, type ScrollIntent } from './scroll-keys';
import { FitThrottle } from './fit-throttle';
import { ctrlClickActivator, openExternalUrl } from './links';
import { promptForConfirm } from '../ui/prompt-dialog';

export interface GodConsoleOpts {
	repos: GodRepo[];
	coordDir: string;
	sidecarPath: string;
	godHomeDir: string;   // a neutral cwd outside every repo
	sessionEnv?: () => Record<string, string>;
	selfImprove?: GodSelfImprove; // when set, Kane may improve his own source + build tools
	onFocusChange?: (focused: boolean) => void;
	instanceName?: string;   // head label + COS_TERMINAL_NAME (default 'Kane')
	terminalId?: string;     // COS_TERMINAL_ID for cos-coord identity (default '0')
	resume?: boolean;        // open with --continue (fresh fallback) — the main Kane sets this
}

/** GOD: a single privileged claude session in a docked side panel. Real terminal — the
 *  user types directly into it. Hidden (not killed) when toggled off, so re-opening is
 *  instant. No worktree, no branch, no delete-on-close. */
export class GodConsole {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private fit: FitAddon | null = null;
	private bridge: SessionBridge | null = null;
	private resizeObs: ResizeObserver | null = null;
	private fitThrottle: FitThrottle | null = null;
	private busy = false;            // approximate: true while output is actively streaming
	private busyTimer: number | null = null;

	constructor(private opts: GodConsoleOpts, private onHide: () => void) {}

	/** The panel root, so the grid can place it in the dock and toggle visibility. */
	get element(): HTMLElement | null { return this.el; }

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-god-panel' });
		// Report keyboard-focus changes so the grid can hold auto-centering while the user is
		// typing to Kane (mirrors terminal-tile's focusin/focusout wiring).
		this.el.addEventListener('focusin', () => this.opts.onFocusChange?.(true));
		this.el.addEventListener('focusout', () => this.opts.onFocusChange?.(false));
		// Left-edge grip: drag to resize the panel width. One shared width for every Kane
		// panel, persisted across sessions; the body's ResizeObserver refits xterm live.
		const saved = Number(window.localStorage.getItem('cos-god-width'));
		if (Number.isFinite(saved) && saved >= 280) this.el.style.flex = `0 0 ${Math.min(Math.round(saved), Math.round(window.innerWidth * 0.7))}px`;
		const grip = this.el.createDiv({ cls: 'cos-god-resize' });
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = this.el?.getBoundingClientRect().width ?? 0;
			grip.setPointerCapture(e.pointerId); // pointerup arrives even if released outside the window
			grip.classList.add('dragging');
			const move = (ev: PointerEvent): void => {
				if (!this.el) return; // disposed mid-drag
				const w = Math.min(Math.max(280, startW + (startX - ev.clientX)), Math.round(window.innerWidth * 0.7));
				this.el.style.flex = `0 0 ${Math.round(w)}px`;
			};
			const up = (ev: PointerEvent): void => {
				grip.classList.remove('dragging');
				grip.removeEventListener('pointermove', move);
				grip.removeEventListener('pointerup', up);
				grip.removeEventListener('pointercancel', up);
				try { grip.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
				if (this.el) window.localStorage.setItem('cos-god-width', String(Math.round(this.el.getBoundingClientRect().width)));
			};
			grip.addEventListener('pointermove', move);
			grip.addEventListener('pointerup', up);
			grip.addEventListener('pointercancel', up);
		});
		const head = this.el.createDiv({ cls: 'cos-god-head' });
		head.createSpan({ text: `🜲 ${this.opts.instanceName ?? 'Kane'}` });
		const refreshBtn = head.createEl('button', { text: '⟳', cls: 'cos-term-refresh', attr: { title: 'Refresh Kane — reload with --continue (keeps the conversation)' } });
		refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.refresh(); });
		const hide = head.createEl('button', { text: '×', attr: { title: 'Hide Kane (session keeps running)' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.onHide(); });

		this.bodyEl = this.el.createDiv({ cls: 'cos-god-body' });
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: false, scrollback: 5000, theme: activeTerminalPalette(), ...activeTerminalFont(),
			// OSC 8 hyperlinks from the new Claude TUI — open in the real browser on Ctrl/Cmd+click
			// instead of xterm's built-in "navigate… could be dangerous" confirm (no linkHandler set).
			linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) openExternalUrl(uri); } },
		});
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		this.term.open(this.bodyEl);
		// GPU-accelerated rendering, mirroring TerminalTile: load after open(); on context
		// loss dispose → xterm falls back to the DOM renderer for this console only.
		try {
			const gl = new WebglAddon();
			gl.onContextLoss(() => gl.dispose());
			this.term.loadAddon(gl);
		} catch { /* no GPU/context available — DOM renderer remains */ }
		// Ctrl/Cmd+click a URL to open it in the real browser.
		this.term.loadAddon(new WebLinksAddon(ctrlClickActivator(openExternalUrl)));
		// Clipboard + scrollback keys, mirroring TerminalTile: Ctrl/Cmd+V pastes (xterm would
		// otherwise send a literal ^V to Claude); Shift+Page/Arrow/Home/End scroll. Everything
		// else passes through to Claude untouched.
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
				e.preventDefault(); // suppress the browser's own paste so we don't double-paste
				this.pasteFromClipboard();
				return false;
			}
			// Copy: Ctrl/Cmd+Shift+C always copies the selection; plain Ctrl/Cmd+C copies ONLY
			// when there is a selection — otherwise it must fall through to Claude as the
			// interrupt (SIGINT), which is what Ctrl+C means in a terminal.
			if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
				const hasSel = !!this.term?.hasSelection();
				if (e.shiftKey || hasSel) {
					if (hasSel) {
						const sel = this.term!.getSelection();
						if (sel) this.writeClipboard(sel);
						this.term!.clearSelection();
					}
					e.preventDefault();
					return false;
				}
				return true; // no selection → let plain Ctrl+C through as interrupt
			}
			const intent = scrollIntentForKey(e);
			if (!intent) return true;
			// New flicker-free TUI keeps the conversation in the ALTERNATE screen buffer (no xterm
			// scrollback) — translate Shift+nav into Claude's native scroll keys down the PTY. The
			// classic normal-buffer TUI still has scrollback, so scroll xterm there.
			if (this.term?.buffer.active.type === 'alternate') { this.sendScrollKey(intent); return false; }
			this.applyScroll(intent);
			return false;
		});
		// Right-click: copy the selection if there is one, otherwise paste.
		this.bodyEl.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			if (this.term?.hasSelection()) {
				const sel = this.term.getSelection();
				if (sel) this.writeClipboard(sel);
				this.term.clearSelection();
			} else {
				this.pasteFromClipboard();
			}
		});
		// Paste is owned solely by our handlers (Ctrl+V keydown + the right-click above). Swallow
		// xterm's native paste in the capture phase so a right-click doesn't paste twice.
		this.bodyEl.addEventListener('paste', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
		this.fitThrottle = new FitThrottle({
			// Kane lives in a fixed-width dock (never bubbles), so fit it to its actual size —
			// no minimum clamp (clamping would clip his own readable content).
			propose: () => this.fit?.proposeDimensions() ?? null,
			apply: (cols, rows) => { this.term?.resize(cols, rows); this.bridge?.resize(cols, rows); },
		});
		this.fitSoon();

		this.term.onData((d) => this.bridge?.write(d));
		// resume → Kane picks his conversation back up across app restarts, exactly like the
		// tiles (fresh fallback if no transcript). /clear inside the session starts a new one.
		this.startSession(this.opts.resume ?? false, this.opts.resume ?? false);

		this.resizeObs = new ResizeObserver(() => this.fitSoon());
		this.resizeObs.observe(this.bodyEl);
	}

	/** Build args/env, create Kane's session bridge, wire it, and start it. Called from render()
	 *  and from refresh(). resume → claude --continue; fallbackFresh → if --continue finds no
	 *  conversation, relaunch a FRESH session in place (so ⟳ revives a dead Kane). */
	private startSession(resume: boolean, fallbackFresh = false): void {
		const ctxFile = this.writeSystemPromptFile();
		this.writeKaneCommands();
		const args: string[] = resume ? ['--continue'] : [];
		if (ctxFile) args.push('--append-system-prompt-file', ctxFile);
		const sidecarDir = path.dirname(this.opts.sidecarPath);
		const env: Record<string, string> = {
			...safeSessionEnv(this.opts.sessionEnv),
			COS_COORD_DIR: this.opts.coordDir,
			COS_TERMINAL_ID: this.opts.terminalId ?? '0',
			COS_TERMINAL_NAME: this.opts.instanceName ?? 'Kane',
			COS_ROLE: 'god',
			PATH: sidecarDir + path.delimiter + (process.env.PATH ?? ''),
		};
		fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
		let probe = ''; // first bytes only (capped) — detect the --continue "no conversation" exit
		this.bridge = new SessionBridge(this.opts.sidecarPath, this.opts.godHomeDir, 'claude', args, env);
		this.bridge.onData((d) => { if (fallbackFresh && probe.length < 2048) probe += d; this.term?.write(d); this.markBusy(); });
		this.bridge.onExit((code) => {
			if (fallbackFresh && /no conversation found to continue/i.test(probe)) {
				this.term?.reset();          // --continue had nothing to resume → start fresh in place
				this.startSession(false);
				return;
			}
			this.term?.write(`\r\n[${this.opts.instanceName ?? 'Kane'} session ended (code ${code ?? '?'})]\r\n`);
		});
		this.bridge.start();
	}

	/** Kane has no ready-marker, so approximate "busy" from output activity: any output marks
	 *  busy and (re)arms a short timer that clears it once output goes quiet. */
	private markBusy(): void {
		this.busy = true;
		if (this.busyTimer !== null) window.clearTimeout(this.busyTimer);
		this.busyTimer = window.setTimeout(() => { this.busy = false; this.busyTimer = null; }, 1500);
	}

	/** Re-tint the terminal well live (theme switch — see theme-store). Font weight and the
	 *  contrast floor travel with the palette: light wells need both to read well. */
	setTerminalPalette(p: TerminalPalette): void {
		if (!this.term) return;
		this.term.options.theme = p;
		const f = activeTerminalFont();
		this.term.options.fontWeight = f.fontWeight as never;
		this.term.options.fontWeightBold = f.fontWeightBold as never;
		this.term.options.minimumContrastRatio = f.minimumContrastRatio;
	}

	/** Refresh Kane: kill + relaunch with --continue in place, resuming his conversation.
	 *  Confirms first only if he's mid-output. */
	async refresh(): Promise<void> {
		if (this.busy) {
			const ok = await promptForConfirm('Refresh Kane?', 'Kane is mid-response. Refreshing interrupts it and reloads with --continue (the conversation is kept).', 'Refresh');
			if (!ok) return;
		}
		this.restartInPlace();
	}

	/** Restart Kane's session in place WITHOUT confirming — the account switch uses this so
	 *  a live Kane moves to the new session env too (env re-read inside startSession). */
	restartInPlace(): void {
		if (this.busyTimer !== null) { window.clearTimeout(this.busyTimer); this.busyTimer = null; }
		this.busy = false;
		this.bridge?.kill();
		this.term?.reset();
		this.startSession(true, true); // try --continue; if no conversation, fall back to a fresh session
	}

	/** Show/hide the panel WITHOUT killing the session. Refits on show. */
	setVisible(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? '' : 'none';
		if (on) { this.fitSoon(); this.focus(); }
	}

	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }

	/** Last ≤20 non-blank lines of Kane's buffer — for the phone floor view. */
	recentOutput(): string {
		const t = this.term;
		if (!t) return '';
		const buf = t.buffer.active; const lines: string[] = [];
		for (let i = buf.length - 1; i >= 0 && lines.length < 20; i--) {
			const row = buf.getLine(i); if (!row) continue;
			const s = row.translateToString(true).trimEnd(); if (s) lines.unshift(s);
		}
		return lines.join('\n');
	}

	/** Inject a line into Kane's session (text + a separated Enter so ConPTY can't coalesce
	 *  them) — used to ping him when a watch fires. */
	notify(text: string): void {
		this.bridge?.write(text);
		// 250ms + a 900ms retry: match TerminalTile.sendLine — the new TUI's wider paste
		// window eats a fast \r; the second Enter is a no-op on an already-submitted box.
		window.setTimeout(() => this.bridge?.write('\r'), 250);
		window.setTimeout(() => this.bridge?.write('\r'), 900);
	}

	/** Scroll this terminal's scrollback buffer per a keyboard scroll intent. */
	private applyScroll(intent: ScrollIntent): void {
		const t = this.term;
		if (!t) return;
		if (intent.kind === 'lines') t.scrollLines(intent.amount);
		else if (intent.kind === 'pages') t.scrollPages(intent.amount);
		else if (intent.kind === 'top') t.scrollToTop();
		else t.scrollToBottom();
	}

	/** Alternate-screen (flicker-free) TUI: no xterm scrollback, so map a scroll intent to Claude's
	 *  native scroll keys down the PTY — wheel ticks for line up/down (≈3 lines, like before), PgUp/
	 *  PgDn for page, Ctrl+Home/Ctrl+End for top/bottom. */
	private sendScrollKey(intent: ScrollIntent): void {
		let seq: string;
		if (intent.kind === 'top') seq = '\x1b[1;5H';
		else if (intent.kind === 'bottom') seq = '\x1b[1;5F';
		else if (intent.kind === 'pages') seq = intent.amount < 0 ? '\x1b[5~' : '\x1b[6~';
		else seq = intent.amount < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M';
		this.bridge?.write(seq);
	}

	/** Paste clipboard text into the terminal (honors bracketed-paste via term.paste). */
	private pasteFromClipboard(): void {
		void readClipboardText().then((txt) => { if (txt) this.term?.paste(txt); });
	}

	/** Copy text to the clipboard (used by right-click when there's a selection). */
	private writeClipboard(text: string): void {
		writeClipboardText(text);
	}

	/** Coalesce resize bursts into a single fit + pty-resize (see FitThrottle). */
	private fitSoon(): void {
		this.fitThrottle?.schedule();
	}

	/** Drop a project-level `/personality` slash command + a scoped settings file into Kane's
	 *  home dir. The command makes Kane run `cos-coord personality` (the app drains it and flips
	 *  the mode); the settings pre-allow `cos-coord` so the toggle/tell/watch/spawn don't each
	 *  pop a permission prompt. Everything else still prompts (Kane stays non-bypass). */
	private writeKaneCommands(): void {
		try {
			const cmdDir = path.join(this.opts.godHomeDir, '.claude', 'commands');
			fs.mkdirSync(cmdDir, { recursive: true });
			fs.writeFileSync(path.join(cmdDir, 'personality.md'), [
				'---',
				'description: Toggle Kane\'s personality (forge-master persona + periodic floor pulses) on/off',
				'---',
				'Run exactly this command and nothing else, then confirm in one short line:',
				'',
				'```bash',
				'cos-coord personality',
				'```',
				'',
				'It toggles your personality mode — the app handles the persona switch and starts or',
				'stops the periodic floor "[pulse]" nudges. Do not do anything else.',
				'',
			].join('\n'), 'utf8');
			const settingsFile = path.join(this.opts.godHomeDir, '.claude', 'settings.json');
			// With self-improvement enabled, Kane also gets prompt-free file edits + git/npm/node,
			// or "he builds it and lets you know" would stall on a permission prompt per edit.
			const allow = ['Bash(cos-coord:*)', ...(this.opts.selfImprove ? ['Edit', 'Write', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(node:*)'] : [])];
			fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow } }, null, 2), 'utf8');
		} catch { /* best effort — /personality still works, just with a permission prompt */ }
	}

	/** Write GOD's appended system prompt to his home dir; return the path (or null). */
	private writeSystemPromptFile(): string | null {
		try {
			fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
			const file = path.join(this.opts.godHomeDir, 'god-system-prompt.md');
			fs.writeFileSync(file, godSystemPrompt(this.opts.repos, this.opts.coordDir, this.opts.selfImprove), 'utf8');
			return file;
		} catch { return null; }
	}

	/** Full teardown — kills the session. */
	dispose(): void {
		// Removing a focused element fires no focusout — clear the grid's focus flag manually.
		if (this.el?.contains(document.activeElement)) this.opts.onFocusChange?.(false);
		this.resizeObs?.disconnect(); this.resizeObs = null;
		this.fitThrottle?.dispose(); this.fitThrottle = null;
		this.bridge?.kill(); this.bridge = null;
		this.term?.dispose(); this.term = null;
		this.el?.remove(); this.el = this.bodyEl = null;
	}
}
