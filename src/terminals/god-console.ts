import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge } from './session-bridge';
import { godSystemPrompt, type GodRepo } from './god';
import { scrollIntentForKey, type ScrollIntent } from './scroll-keys';
import { FitThrottle } from './fit-throttle';

export interface GodConsoleOpts {
	repos: GodRepo[];
	coordDir: string;
	sidecarPath: string;
	godHomeDir: string;   // a neutral cwd outside every repo
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

	constructor(private opts: GodConsoleOpts, private onHide: () => void) {}

	/** The panel root, so the grid can place it in the dock and toggle visibility. */
	get element(): HTMLElement | null { return this.el; }

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-god-panel' });
		const head = this.el.createDiv({ cls: 'cos-god-head' });
		head.createSpan({ text: '🜲 GOD' });
		const hide = head.createEl('button', { text: '×', attr: { title: 'Hide GOD (session keeps running)' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.onHide(); });

		this.bodyEl = this.el.createDiv({ cls: 'cos-god-body' });
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: true, scrollback: 5000, theme: { background: '#0e0f17' } });
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		this.term.open(this.bodyEl);
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
		this.fitThrottle = new FitThrottle({
			fit: () => this.fit?.fit(),
			dims: () => ({ cols: this.term?.cols ?? 0, rows: this.term?.rows ?? 0 }),
			resize: (cols, rows) => this.bridge?.resize(cols, rows),
		});
		this.fitSoon();

		const ctxFile = this.writeSystemPromptFile();
		const args: string[] = [];
		if (ctxFile) args.push('--append-system-prompt-file', ctxFile);
		const sidecarDir = path.dirname(this.opts.sidecarPath);
		const env: Record<string, string> = {
			COS_COORD_DIR: this.opts.coordDir,
			COS_TERMINAL_ID: '0',
			COS_TERMINAL_NAME: 'GOD',
			COS_ROLE: 'god',
			PATH: sidecarDir + path.delimiter + (process.env.PATH ?? ''),
		};
		fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
		this.bridge = new SessionBridge(this.opts.sidecarPath, this.opts.godHomeDir, 'claude', args, env);
		this.bridge.onData((d) => this.term?.write(d));
		this.bridge.onExit((code) => this.term?.write(`\r\n[GOD session ended (code ${code ?? '?'})]\r\n`));
		this.term.onData((d) => this.bridge?.write(d));
		this.bridge.start();

		this.resizeObs = new ResizeObserver(() => this.fitSoon());
		this.resizeObs.observe(this.bodyEl);
	}

	/** Show/hide the panel WITHOUT killing the session. Refits on show. */
	setVisible(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? '' : 'none';
		if (on) { this.fitSoon(); this.focus(); }
	}

	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }

	/** Scroll this terminal's scrollback buffer per a keyboard scroll intent. */
	private applyScroll(intent: ScrollIntent): void {
		const t = this.term;
		if (!t) return;
		if (intent.kind === 'lines') t.scrollLines(intent.amount);
		else if (intent.kind === 'pages') t.scrollPages(intent.amount);
		else if (intent.kind === 'top') t.scrollToTop();
		else t.scrollToBottom();
	}

	/** Electron's clipboard (reliable & synchronous), or null outside Electron. */
	private electronClipboard(): { readText?: () => string; writeText?: (t: string) => void } | null {
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			if (!req) return null;
			const mod = req('electron') as { clipboard?: { readText?: () => string; writeText?: (t: string) => void } };
			return mod.clipboard ?? null;
		} catch { return null; }
	}

	/** Paste clipboard text into the terminal (honors bracketed-paste via term.paste). */
	private pasteFromClipboard(): void {
		const t = this.term;
		if (!t) return;
		const sync = this.electronClipboard()?.readText?.();
		if (typeof sync === 'string') { if (sync) t.paste(sync); return; }
		// Fallback for non-Electron runtimes: the async Clipboard API.
		navigator.clipboard?.readText?.().then((txt) => { if (txt) t.paste(txt); }).catch(() => { /* denied / empty */ });
	}

	/** Copy text to the clipboard (used by right-click when there's a selection). */
	private writeClipboard(text: string): void {
		const clip = this.electronClipboard();
		if (clip?.writeText) { clip.writeText(text); return; }
		navigator.clipboard?.writeText?.(text).catch(() => { /* denied */ });
	}

	/** Coalesce resize bursts into a single fit + pty-resize (see FitThrottle). */
	private fitSoon(): void {
		this.fitThrottle?.schedule();
	}

	/** Write GOD's appended system prompt to his home dir; return the path (or null). */
	private writeSystemPromptFile(): string | null {
		try {
			fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
			const file = path.join(this.opts.godHomeDir, 'god-system-prompt.md');
			fs.writeFileSync(file, godSystemPrompt(this.opts.repos, this.opts.coordDir), 'utf8');
			return file;
		} catch { return null; }
	}

	/** Full teardown — kills the session. */
	dispose(): void {
		this.resizeObs?.disconnect(); this.resizeObs = null;
		this.fitThrottle?.dispose(); this.fitThrottle = null;
		this.bridge?.kill(); this.bridge = null;
		this.term?.dispose(); this.term = null;
		this.el?.remove(); this.el = this.bodyEl = null;
	}
}
