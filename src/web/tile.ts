import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { scrollIntentForKey } from '../terminals/scroll-keys';
import { activeTerminalFont } from '../terminals/theme-store';
import { fitFontSize, repoLabel } from './fit';

const BASE_FONT = 12;
// Preview floor. 4px is unreadable on purpose: side tiles are previews, and a smaller floor means
// they shrink further instead of CLIPPING their right edge when the box gets tight.
const MIN_FONT = 4;
// Bounds mirroring electron/remote-actions.ts — a fill-mode grid never leaves this window.
const MIN_COLS = 20, MAX_COLS = 400, MIN_ROWS = 5, MAX_ROWS = 200;
const RESIZE_SEND_MS = 200;

export interface WebTileDeps {
	key: string;
	snapshot: () => Promise<string>;
	write: (data: string) => void;
	onData: (cb: (chunk: string) => void) => () => void;
	onClick: () => void;
	onRename: (name: string) => void;
	onHide: () => void;
	onKill: () => void;
	/** Fill mode only: push the browser-chosen PTY shape to the desktop (kane:/tile:resize). */
	resize?: (cols: number, rows: number) => void;
	/** Ship a pasted image to the host, which saves it and types its path into the session. */
	pasteImage?: (dataBase64: string, mime: string) => void;
	/** ⟳ — restart the session in place (kill + relaunch with --continue), like the desk tile. */
	onRefresh?: () => void;
}

/** Image types we forward on paste — must match PASTE_MIMES in electron/remote-actions.ts. */
const PASTE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** One mirrored terminal, in one of two modes.
 *  PREVIEW (default): the xterm keeps the DESKTOP's PTY size (setSize) and the FONT shrinks to
 *  fit the box (fit.ts), down to MIN_FONT — the two screens cannot fight over the size.
 *  FILL (Kane + the spotlight tile, while this browser drives): the font is fixed at BASE_FONT
 *  and the GRID is computed from the box instead, pushed to the desktop via deps.resize — a
 *  wide-short desktop grid can never fill a tall-narrow browser box at a readable font, so for
 *  the terminals the user is actually reading, the browser's geometry wins. The desktop
 *  suppresses its own fit for those PTYs until release/disconnect. */
export class WebTile {
	private el: HTMLElement | null = null;
	private nameEl: HTMLElement | null = null;
	private stateEl: HTMLElement | null = null;
	private headEl: HTMLElement | null = null;
	private repoEl: HTMLElement | null = null;
	private repo = '';
	private branch = '';
	/** Character cell at BASE_FONT, measured once from the live xterm; reset when the font changes. */
	private baseCell: { w: number; h: number } | null = null;
	/** Outer tile box the terminal must fit (the layout's target rect, not the mid-transition size). */
	private box: { w: number; h: number } | null = null;
	private badgeEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private off: (() => void) | null = null;
	private centered = false;
	/** Kane is docked beside the stage, never on it — so he is never `centered`, and every
	 *  stage-tile interaction that keys off `centered` has to be skipped for him. */
	private isKane = false;
	private fillMode = false;
	private sendTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSent: { cols: number; rows: number } | null = null;
	/** Fill mode uses xterm's OWN measurer for the grid. Hand-computing it from a scaled cell
	 *  underestimated the character height and produced ~92 rows inside a 252px box (the terminal
	 *  overflowed its tile). proposeDimensions() measures the live element the same way the
	 *  desktop's FitThrottle does. */
	private fitAddon: FitAddon | null = null;

	constructor(private deps: WebTileDeps) {}

	render(parent: HTMLElement, head: { name: string; repo: string; branch: string; isKane?: boolean }): void {
		this.el = parent.createDiv({ cls: 'cos-term-tile web-tile' });
		const h = this.el.createDiv({ cls: 'cos-term-head' });
		this.headEl = h;
		this.repo = head.repo;
		this.branch = head.branch;
		this.isKane = head.isKane === true;
		this.badgeEl = h.createSpan({ cls: 'cos-term-badge' });
		this.nameEl = h.createSpan({ cls: 'cos-term-name', text: head.name, attr: this.isKane ? {} : { title: 'Double-click to rename' } });
		// Kane cannot be renamed (his onRename is a no-op), so don't offer a prompt that does nothing.
		if (!this.isKane) this.nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); const n = prompt('Rename terminal', this.nameEl?.textContent ?? ''); if (n && n.trim()) this.deps.onRename(n.trim()); });
		this.repoEl = h.createSpan({ cls: 'web-tile-repo' });
		this.applyRepoLabel(head.name);
		this.stateEl = h.createSpan({ cls: 'web-tile-state' });
		const btns = h.createDiv({ cls: 'cos-term-head-btns' });
		const refreshBtn = btns.createEl('button', { text: '⟳', cls: 'cos-term-refresh', attr: { title: 'Refresh — reload this session with --continue (keeps the conversation)' } });
		refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(`Refresh "${this.nameEl?.textContent ?? head.name}"? Reloads the session with --continue.`)) this.deps.onRefresh?.(); });
		const hideBtn = btns.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — keeps the session running; restore from Coordination' } });
		hideBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deps.onHide(); });
		const killBtn = btns.createEl('button', { text: '×', attr: { title: 'Close — deletes this worktree + its branch' } });
		killBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(`Close "${this.nameEl?.textContent ?? head.name}"? Deletes its worktree + branch.`)) this.deps.onKill(); });
		if (this.isKane) btns.style.display = 'none';
		if (!this.isKane) this.el.addEventListener('click', () => this.deps.onClick());
		const body = this.el.createDiv({ cls: 'cos-term-body' });
		// Clicking a tile that is NOT the spotlight centres it instead of typing into it. Kane is
		// docked beside the stage and is never centred, so for him this guard would fire on EVERY
		// click — cancelling focus and stopping xterm's own mousedown outright, which made him
		// impossible to click into, focus, or select text in. Stage tiles only.
		if (!this.isKane) body.addEventListener('mousedown', (e) => { if (!this.centered) { e.preventDefault(); e.stopImmediatePropagation(); this.deps.onClick(); } }, true);
		this.term = new Terminal({ fontSize: BASE_FONT, convertEol: false, cursorBlink: false, scrollback: 5000, ...activeTerminalFont(), linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); } } });
		this.term.open(body);
		this.fitAddon = new FitAddon();
		this.term.loadAddon(this.fitAddon);
		try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); this.term.loadAddon(gl); } catch { /* DOM renderer */ }
		this.term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); }));
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && this.term?.hasSelection()) { void navigator.clipboard?.writeText(this.term.getSelection()); return false; }
			if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) { void navigator.clipboard?.readText().then((t) => { if (t) this.deps.write(t); }); return false; }
			const intent = scrollIntentForKey(e);
			if (intent) { if (intent.kind === 'lines') this.term?.scrollLines(intent.amount); else if (intent.kind === 'pages') this.term?.scrollPages(intent.amount); else if (intent.kind === 'top') this.term?.scrollToTop(); else this.term?.scrollToBottom(); return false; }
			return true;
		});
		this.term.onData((d) => this.deps.write(d)); // everything forwarded, like the desktop (focus/DSR replies included)
		// A real paste event is the ONLY place the clipboard's IMAGE is reachable: the Ctrl+V key
		// handler above can read text via navigator.clipboard, but reading an image that way needs
		// a permission the browser will not grant for a keystroke. Images go to the host (which is
		// where claude runs); text falls through to xterm's own paste.
		body.addEventListener('paste', (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items || !this.deps.pasteImage) return;
			for (const it of Array.from(items)) {
				if (it.kind !== 'file' || !PASTE_MIMES.has(it.type)) continue;
				const file = it.getAsFile();
				if (!file) continue;
				e.preventDefault();
				e.stopImmediatePropagation();
				const mime = it.type;
				void file.arrayBuffer().then((buf) => {
					// btoa needs a binary string; chunk it so a multi-MB image can't blow the
					// argument limit of String.fromCharCode.
					const bytes = new Uint8Array(buf);
					let bin = '';
					for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
					this.deps.pasteImage?.(btoa(bin), mime);
				}).catch(() => { /* unreadable clipboard file — nothing to send */ });
				return;
			}
		}, true);
	}

	setRect(r: { x: number; y: number; w: number; h: number }): void {
		if (!this.el) return;
		this.el.style.left = `${r.x}px`; this.el.style.top = `${r.y}px`; this.el.style.width = `${r.w}px`; this.el.style.height = `${r.h}px`;
		this.box = { w: r.w, h: r.h };
		this.fit();
	}
	/** For a tile sized by CSS rather than the layout (the Kane dock): fit whatever box it has now. */
	fitToSelf(): void {
		if (!this.el) return;
		this.box = { w: this.el.clientWidth, h: this.el.clientHeight };
		this.fit();
	}
	setCentered(on: boolean): void { this.centered = on; this.el?.toggleClass('centered', on); }
	setSize(cols: number, rows: number): void {
		// Fill mode owns the grid: a floor:state echo just repeats the dims WE set (or a stale
		// value from the race right after taking over) — applying it would fight our own resize.
		if (this.fillMode) return;
		if (!this.term || (this.term.cols === cols && this.term.rows === rows)) return;
		this.term.resize(cols, rows);
		this.fit();
	}
	/** FILL mode on/off (Kane, and the spotlight tile while this browser drives). On: font fixed
	 *  at BASE_FONT, the grid tracks the box, and each new shape is pushed via deps.resize. Off:
	 *  back to preview (desktop-owned size, font shrinks); the next floor:state echo re-applies
	 *  the desktop's dims through setSize. */
	setFill(on: boolean): void {
		if (this.fillMode === on) return;
		this.fillMode = on;
		this.lastSent = null;
		if (this.sendTimer !== null) { clearTimeout(this.sendTimer); this.sendTimer = null; }
		if (on && this.term && this.term.options.fontSize !== BASE_FONT) this.term.options.fontSize = BASE_FONT;
		this.fit();
	}
	setHead(name: string, state: string, locked: boolean): void { this.nameEl?.setText(name); this.stateEl?.setText(state); this.el?.toggleClass('cos-term-lockon', locked); this.el?.setAttr('data-state', state); this.applyRepoLabel(name); }
	private applyRepoLabel(name: string): void {
		if (!this.repoEl) return;
		const label = repoLabel(name, this.repo, this.branch);
		this.repoEl.setText(label ?? '');
		this.repoEl.style.display = label ? '' : 'none';
	}
	/** Cell size at BASE_FONT from the xterm's own screen element (cols × cell wide). Null until
	 *  xterm has measured (attached + font ready); callers just try again on the next fit. */
	private measureBaseCell(): { w: number; h: number } | null {
		if (this.baseCell) return this.baseCell;
		if (!this.term || !this.el) return null;
		const screen = this.el.querySelector<HTMLElement>('.xterm-screen');
		if (!screen) return null;
		const fs = this.term.options.fontSize ?? BASE_FONT;
		const w = screen.offsetWidth / this.term.cols, h = screen.offsetHeight / this.term.rows;
		if (!(w > 0) || !(h > 0)) return null;
		this.baseCell = { w: (w * BASE_FONT) / fs, h: (h * BASE_FONT) / fs };
		return this.baseCell;
	}
	private fit(): void {
		if (!this.term || !this.box) return;
		// Fill mode measures the live element itself (refill), so it must not depend on the
		// scaled-cell estimate below — which is also unavailable until xterm has laid out once.
		if (this.fillMode) { this.refill(); return; }
		const cell = this.measureBaseCell();
		if (!cell) return;
		// Tile border 1px a side; .cos-term-body padding 4px a side (styles.css); head above the body.
		const headH = this.headEl?.offsetHeight ?? 0;
		const availW = this.box.w - 2 - 8, availH = this.box.h - 2 - headH - 8;
		const size = fitFontSize({ cols: this.term.cols, rows: this.term.rows, boxW: availW, boxH: availH, cell, base: BASE_FONT, min: MIN_FONT });
		if (this.term.options.fontSize !== size) this.term.options.fontSize = size;
	}
	/** Fill mode: the grid comes from xterm's own measurement of the live element at BASE_FONT
	 *  (clamped to the window the server accepts), applied locally at once and pushed to the
	 *  desktop debounced+deduped — a grip drag fires dozens of box changes, and every PTY resize
	 *  makes ConPTY repaint the whole screen. */
	private refill(): void {
		if (!this.term) return;
		if (this.term.options.fontSize !== BASE_FONT) this.term.options.fontSize = BASE_FONT;
		const proposed = this.fitAddon?.proposeDimensions();
		if (!proposed || !(proposed.cols > 0) || !(proposed.rows > 0)) return;
		const cols = Math.min(Math.max(proposed.cols, MIN_COLS), MAX_COLS);
		const rows = Math.min(Math.max(proposed.rows, MIN_ROWS), MAX_ROWS);
		if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
		if (this.lastSent && this.lastSent.cols === cols && this.lastSent.rows === rows) return;
		if (this.sendTimer !== null) clearTimeout(this.sendTimer);
		this.sendTimer = setTimeout(() => {
			this.sendTimer = null;
			if (!this.fillMode || !this.term) return;
			const c = this.term.cols, r = this.term.rows;
			if (this.lastSent && this.lastSent.cols === c && this.lastSent.rows === r) return;
			this.lastSent = { cols: c, rows: r };
			this.deps.resize?.(c, r);
		}, RESIZE_SEND_MS);
	}
	setBadge(text: string | null): void { if (!this.badgeEl) return; this.badgeEl.setText(text ?? ''); this.badgeEl.style.display = text ? 'inline-block' : 'none'; }
	setPalette(p: Record<string, string>): void {
		if (!this.term) return;
		this.term.options.theme = p;
		const f = activeTerminalFont();
		this.term.options.fontWeight = f.fontWeight as never;
		this.term.options.fontWeightBold = f.fontWeightBold as never;
		this.term.options.minimumContrastRatio = f.minimumContrastRatio;
		this.baseCell = null; // weight/family may change the cell — re-measure on the next fit
		this.fit();
	}

	/** Subscribe FIRST, then snapshot — nothing missed, nothing doubled, and the live feed
	 *  survives a snapshot that never arrives. Subscribing after the await (as this used to)
	 *  meant ANY snapshot rejection — a 30s invoke timeout, main's 10s renderer-rpc timeout, or
	 *  the socket dropping and failing every in-flight invoke — left the tile blank forever with
	 *  no stream and nothing to retry it. Chunks that land during the round trip are buffered and
	 *  replayed after the snapshot, so ordering is preserved either way. */
	async attach(): Promise<void> {
		if (this.off) return; // already attached
		const early: string[] = [];
		let painted = false;
		this.off = this.deps.onData((chunk) => { if (painted) this.term?.write(chunk); else early.push(chunk); });
		try {
			const snap = await this.deps.snapshot();
			// Re-fit once the snapshot has actually rendered. The first fit ran before xterm could
			// measure its cell (font not laid out yet), so the tile — the spotlight especially — could
			// be stuck at BASE_FONT in an undersized box, clipping its newest rows with no scrollbar.
			this.term?.write(snap, () => this.fit());
		} catch {
			// No scrollback, but the live stream below still works — far better than a dead tile.
			this.term?.write('\r\n\x1b[2m— scrollback unavailable; live output follows —\x1b[0m\r\n');
		}
		painted = true;
		for (const c of early.splice(0)) this.term?.write(c);
		this.fit();
	}
	/** Reconnect: replace the whole buffer with a fresh snapshot (the stream may have gaps).
	 *  Re-subscribes if the subscription was lost, and re-fits like attach() does. */
	async resume(): Promise<void> {
		if (!this.off) { await this.attach(); return; }
		try {
			const snap = await this.deps.snapshot();
			this.term?.reset();
			this.term?.write(snap, () => this.fit());
		} catch { /* keep what is on screen; the live stream keeps it moving */ }
	}
	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }
	dispose(): void { if (this.sendTimer !== null) { clearTimeout(this.sendTimer); this.sendTimer = null; } this.off?.(); this.off = null; this.term?.dispose(); this.term = null; this.el?.remove(); this.el = null; }
}
