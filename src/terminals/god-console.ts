import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge } from './session-bridge';
import { godSystemPrompt, type GodRepo } from './god';

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

	private fitSoon(): void {
		window.setTimeout(() => {
			try { this.fit?.fit(); if (this.term) this.bridge?.resize(this.term.cols, this.term.rows); } catch { /* not visible yet */ }
		}, 30);
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
		this.bridge?.kill(); this.bridge = null;
		this.term?.dispose(); this.term = null;
		this.el?.remove(); this.el = this.bodyEl = null;
	}
}
