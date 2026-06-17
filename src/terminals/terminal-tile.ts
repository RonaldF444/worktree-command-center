import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge } from './session-bridge';
import { removeWorktreeAndBranch, terminalSystemPrompt, type WorktreeInfo } from './worktree-manager';
import { scrollIntentForKey, type ScrollIntent } from './scroll-keys';
import { FitThrottle } from './fit-throttle';
import { ctrlClickActivator, openExternalUrl } from './links';

export interface TerminalTileOpts {
	tileId: number;
	repoName: string;
	repoPath: string;
	baseBranch: string;
	worktree: WorktreeInfo;
	sidecarPath: string;
	coordDir: string;
	onClosed: (tile: TerminalTile) => void;
	onHide?: (tile: TerminalTile) => void;
	onLock?: (tile: TerminalTile) => void;
	onCenter?: (tile: TerminalTile) => void;
	onInput?: (tile: TerminalTile, data: string) => void;
	onEnter?: (tile: TerminalTile) => void;
	onFocusChange?: (tile: TerminalTile, focused: boolean) => void;
	onReady?: (tile: TerminalTile) => void;
	resume?: boolean;
	bypassPermissions?: boolean;
	name?: string;
	onRename?: (tile: TerminalTile, name: string) => void;
	onRequestRename?: (tile: TerminalTile, currentName: string) => void;
}

/** One embedded claude terminal (xterm) bound to a sidecar session + worktree. */
export class TerminalTile {
	private term: Terminal | null = null;
	private fit: FitAddon | null = null;
	private bridge: SessionBridge | null = null;
	private el: HTMLElement | null = null;
	private resizeObs: ResizeObserver | null = null;
	private fitThrottle: FitThrottle | null = null;
	private badgeEl: HTMLElement | null = null;
	private lockBtnEl: HTMLButtonElement | null = null;
	private readyWatcher: fs.FSWatcher | null = null;
	private nameEl: HTMLElement | null = null;
	private displayName: string;
	private pasting = false;
	private selected = false;

	constructor(private opts: TerminalTileOpts) {
		this.displayName = opts.name ?? `${opts.repoName} · ${opts.worktree.branch}`;
	}

	get tileId(): number { return this.opts.tileId; }

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-term-tile' });
		const head = this.el.createDiv({ cls: 'cos-term-head' });
		this.badgeEl = head.createSpan({ cls: 'cos-term-badge' });
		this.nameEl = head.createSpan({ cls: 'cos-term-name', text: this.displayName, attr: { title: 'Double-click to rename' } });
		this.nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.opts.onRequestRename?.(this, this.displayName); });
		// Right-clustered controls: lock, minimize (hide), close.
		const btns = head.createDiv({ cls: 'cos-term-head-btns' });
		this.lockBtnEl = btns.createEl('button', { text: '🔒', cls: 'cos-term-lock', attr: { title: 'Lock to center (Alt+L) — stays centered until you switch to another terminal' } });
		this.lockBtnEl.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onLock?.(this); });
		const hide = btns.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — keeps the session running; resurface from Coordination' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onHide?.(this); });
		const close = btns.createEl('button', { text: '×', attr: { title: 'Close — deletes this worktree + its branch' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); void this.close(); });
		// Click anywhere in the tile (header or terminal body, except the × button) centers it.
		this.el.addEventListener('click', () => this.opts.onCenter?.(this));

		const body = this.el.createDiv({ cls: 'cos-term-body' });
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: true, scrollback: 5000, theme: { background: '#0e0f17' } });
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		this.term.open(body);
		// Ctrl/Cmd+click a URL (e.g. http://localhost:5173) to open it in the real browser.
		this.term.loadAddon(new WebLinksAddon(ctrlClickActivator(openExternalUrl)));
		// Ctrl/Cmd+C copies the selection if there is one (otherwise ^C falls through as an
		// interrupt to Claude); Ctrl/Cmd+V pastes from the clipboard (xterm would otherwise
		// send a literal ^V); Shift+Page/Arrow/Home/End scroll the scrollback. Everything else
		// (plain nav keys included) passes through to Claude untouched.
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
				if (this.term?.hasSelection()) {
					const sel = this.term.getSelection();
					if (sel) {
						e.preventDefault(); // copy instead of sending ^C (SIGINT)
						this.writeClipboard(sel);
						this.term.clearSelection();
						return false;
					}
				}
				return true; // no selection → let ^C through as an interrupt
			}
			if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
				e.preventDefault(); // suppress the browser's own paste so we don't double-paste
				this.pasteFromClipboard();
				return false;
			}
			const intent = scrollIntentForKey(e);
			if (!intent) return true;
			this.applyScroll(intent);
			return false;
		});
		// Right-click: copy the selection if there is one, otherwise paste.
		body.addEventListener('contextmenu', (e) => {
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
			// Propose without mutating (so the dedupe holds), then size BOTH xterm + PTY together.
			// Clamp to a readable minimum: a tiny satellite tile must NOT make claude wrap output
			// to ~30 cols — keep it ≥80 so a later centered view reads correctly (small tiles just
			// show a clipped preview).
			propose: () => this.fit?.proposeDimensions() ?? null,
			apply: (cols, rows) => { this.term?.resize(cols, rows); this.bridge?.resize(cols, rows); },
			minCols: 80,
			minRows: 20,
		});
		this.fitSoon();

		const args = this.opts.resume ? ['--continue'] : [];
		if (this.opts.bypassPermissions) args.push('--dangerously-skip-permissions');
		const ctxFile = this.writeContextFile();
		if (ctxFile) args.push('--append-system-prompt-file', ctxFile);
		const sidecarDir = path.dirname(this.opts.sidecarPath);
		const env: Record<string, string> = {
			COS_COORD_DIR: this.opts.coordDir,
			COS_TERMINAL_ID: String(this.opts.tileId),
			COS_TERMINAL_NAME: this.displayName,
			PATH: sidecarDir + path.delimiter + (process.env.PATH ?? ''),
		};
		this.bridge = new SessionBridge(this.opts.sidecarPath, this.opts.worktree.worktreePath, 'claude', args, env);
		this.bridge.onData((d) => this.term?.write(d));
		this.bridge.onExit((code) => this.term?.write(`\r\n[session ended (code ${code ?? '?'})]\r\n`));
		this.bridge.onReady(() => this.opts.onReady?.(this));
		this.term.onData((d) => {
			this.bridge?.write(d);
			if (this.pasting) return; // pasted content (incl. its newlines) is NOT a submit
			if (d.includes('\r')) this.opts.onEnter?.(this);
			else this.opts.onInput?.(this, d);
		});
		this.bridge.start();

		this.el.addEventListener('focusin', () => this.opts.onFocusChange?.(this, true));
		this.el.addEventListener('focusout', () => this.opts.onFocusChange?.(this, false));

		this.resizeObs = new ResizeObserver(() => this.fitSoon());
		this.resizeObs.observe(body);

		// Watch for the Claude-hook "ready" marker in this worktree.
		try {
			this.readyWatcher = fs.watch(this.opts.worktree.worktreePath, (_evt, file) => {
				if (file === '.cos-ready') {
					try { fs.unlinkSync(path.join(this.opts.worktree.worktreePath, '.cos-ready')); } catch { /* ignore */ }
					this.opts.onReady?.(this);
				}
			});
		} catch { /* worktree gone / watch unsupported */ }
	}

	/** Position/size the tile (absolute, in stage coords). Refits the terminal after the move. */
	setRect(r: { x: number; y: number; w: number; h: number }): void {
		if (!this.el) return;
		this.el.style.left = `${r.x}px`;
		this.el.style.top = `${r.y}px`;
		this.el.style.width = `${r.w}px`;
		this.el.style.height = `${r.h}px`;
		this.fitSoon();
	}

	/** Show/hide the Alt-overlay shortcut key on this tile. */
	setBadge(label: string | null): void {
		if (!this.badgeEl) return;
		this.badgeEl.setText(label ?? '');
		this.badgeEl.style.display = label ? 'inline-block' : 'none';
	}

	setCentered(on: boolean): void {
		this.el?.toggleClass('centered', on);
	}

	/** Reflect this tile's individual-lock state (gold ring + lit lock button). */
	setLocked(on: boolean): void {
		this.el?.toggleClass('cos-term-lockon', on);
		this.lockBtnEl?.toggleClass('on', on);
	}

	/** Dim this tile when it doesn't match the search filter. */
	setDimmed(on: boolean): void {
		this.el?.toggleClass('cos-term-dim', on);
	}

	/** Detach/re-attach the tile from the visible stage WITHOUT touching the session.
	 *  Hidden tiles keep their claude process + xterm buffer alive in the background. */
	setHidden(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? 'none' : '';
		if (!on) this.fitSoon(); // re-show: the term was display:none, so refit to the stage
	}

	/** Give this terminal keyboard focus so typing goes here. */
	focus(): void {
		this.term?.focus();
	}

	/** Drop keyboard focus so stray keystrokes can't land on a non-centered tile. */
	blur(): void {
		this.term?.blur();
	}

	/** Type a line into the session (text + Enter) — used by the chat broadcast/relay. */
	sendLine(text: string): void {
		this.bridge?.write(text);
		// Submit Enter as a SEPARATE write on a later tick. Bundling "text\r" into one PTY
		// write makes Claude's input treat the trailing \r as a pasted newline — it lands in
		// the box but does NOT submit, so the message sits there unsent. A standalone \r after
		// the text registers as a real Enter (the same reason the Approve button's lone
		// sendKeys("\r") submits a prompt). The delay forces a separate PTY read so ConPTY
		// can't coalesce the two writes back into one chunk.
		window.setTimeout(() => this.bridge?.write('\r'), 40);
	}

	/** Send raw keystrokes verbatim (no auto-Enter) — used to answer prompts from the
	 *  chat (Approve = Enter "\r", Deny = Escape "\x1b"). */
	sendKeys(raw: string): void {
		this.bridge?.write(raw);
	}

	/** Return the last ≤20 non-blank lines visible in the scrollback buffer.
	 *  Used by ChatRoom.prompt() to surface the current waiting member's prompt. */
	recentOutput(): string {
		const t = this.term;
		if (!t) return '';
		const buf = t.buffer.active;
		const lines: string[] = [];
		for (let i = buf.length - 1; i >= 0 && lines.length < 20; i--) {
			const row = buf.getLine(i);
			if (!row) continue;
			const text = row.translateToString(true).trimEnd();
			if (text.length > 0) lines.unshift(text);
		}
		return lines.join('\n');
	}

	/** This terminal's display name (matches COS_TERMINAL_NAME used by cos-coord chat). */
	get name(): string {
		return this.displayName;
	}

	get worktreePath(): string { return this.opts.worktree.worktreePath; }
	get branch(): string { return this.opts.worktree.branch; }
	get baseBranch(): string { return this.opts.baseBranch; }
	get repoName(): string { return this.opts.repoName; }

	/** Toggle the room-selection highlight. */
	setSelected(on: boolean): void {
		this.selected = on;
		this.el?.toggleClass('cos-term-selected', on);
	}

	get isSelected(): boolean {
		return this.selected;
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

	/** Electron's clipboard (reliable & synchronous in Obsidian), or null outside Electron. */
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
		if (typeof sync === 'string') { this.pasteText(sync); return; }
		// Fallback for non-Electron runtimes: the async Clipboard API.
		navigator.clipboard?.readText?.().then((txt) => this.pasteText(txt)).catch(() => { /* denied / empty */ });
	}

	/** Paste text without it counting as Enter, and mark the input box non-empty. */
	private pasteText(text: string): void {
		const t = this.term;
		if (!t || !text) return;
		this.pasting = true;
		try { t.paste(text); } finally { this.pasting = false; }
		// Pasted content fills the box → engage the typing-hold so a finishing terminal
		// can't steal the center while you review/edit it. Newlines → spaces so the
		// length bump never reads as a submit.
		this.opts.onInput?.(this, text.replace(/[\r\n]+/g, ' '));
	}

	/** Copy text to the clipboard (used by right-click when there's a selection). */
	private writeClipboard(text: string): void {
		const clip = this.electronClipboard();
		if (clip?.writeText) { clip.writeText(text); return; }
		navigator.clipboard?.writeText?.(text).catch(() => { /* denied */ });
	}

	/** Write this session's awareness context to a file (outside the worktree, so it
	 *  never dirties it) and return its path for --append-system-prompt-file. */
	private writeContextFile(): string | null {
		try {
			const dir = path.join(path.dirname(this.opts.sidecarPath), 'contexts');
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `tile-${this.opts.tileId}.md`);
			fs.writeFileSync(file, terminalSystemPrompt(this.opts.repoName, this.opts.worktree.branch, this.opts.worktree.worktreePath), 'utf8');
			return file;
		} catch {
			return null;
		}
	}

	/** Set the tile's display name (persisted via onRename). */
	setName(name: string): void {
		this.displayName = name;
		this.nameEl?.setText(name);
		this.opts.onRename?.(this, name);
	}

	/** Serializable record for persistence. */
	sessionRecord(): { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name: string } {
		return {
			worktreePath: this.opts.worktree.worktreePath,
			branch: this.opts.worktree.branch,
			repoName: this.opts.repoName,
			repoPath: this.opts.repoPath,
			baseBranch: this.opts.baseBranch,
			name: this.displayName,
		};
	}

	/** Coalesce resize bursts into a single fit + pty-resize (see FitThrottle). */
	private fitSoon(): void {
		this.fitThrottle?.schedule();
	}

	/** Tear down the session + DOM WITHOUT touching the worktree (used on page switch). */
	kill(): void {
		this.readyWatcher?.close();
		this.readyWatcher = null;
		this.resizeObs?.disconnect();
		this.fitThrottle?.dispose();
		this.fitThrottle = null;
		this.bridge?.kill();
		this.term?.dispose();
		this.el?.remove();
	}

	/** Close from the × button: tear down AND delete the worktree + its branch IMMEDIATELY —
	 *  no confirmation, dirty or not. × means "throw this away"; use Minimize (hide) to keep a
	 *  session you care about. The branch dies with it. */
	async close(): Promise<void> {
		this.kill();
		try {
			await removeWorktreeAndBranch(this.opts.repoPath, this.opts.worktree.worktreePath, this.opts.worktree.branch);
		} catch { /* best effort */ }
		this.opts.onClosed(this);
	}
}
