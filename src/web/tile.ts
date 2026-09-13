import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { scrollIntentForKey } from '../terminals/scroll-keys';
import { activeTerminalFont } from '../terminals/theme-store';
import { fitFontSize, repoLabel } from './fit';

const BASE_FONT = 12;
const MIN_FONT = 6;

export interface WebTileDeps {
	key: string;
	snapshot: () => Promise<string>;
	write: (data: string) => void;
	onData: (cb: (chunk: string) => void) => () => void;
	onClick: () => void;
	onRename: (name: string) => void;
	onHide: () => void;
	onKill: () => void;
}

/** One mirrored terminal. The xterm keeps the DESKTOP's PTY size (setSize) — the browser never
 *  resizes the PTY, so the two screens cannot fight. To fit the tile box the FONT shrinks instead
 *  (see fit.ts), down to MIN_FONT; past that it clips bottom-right like the desktop. */
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
		if (!this.term || (this.term.cols === cols && this.term.rows === rows)) return;
		this.term.resize(cols, rows);
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
		const cell = this.measureBaseCell();
		if (!cell) return;
		// Tile border 1px a side; .cos-term-body padding 4px a side (styles.css); head above the body.
		const headH = this.headEl?.offsetHeight ?? 0;
		const size = fitFontSize({ cols: this.term.cols, rows: this.term.rows, boxW: this.box.w - 2 - 8, boxH: this.box.h - 2 - headH - 8, cell, base: BASE_FONT, min: MIN_FONT });
		if (this.term.options.fontSize !== size) this.term.options.fontSize = size;
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
	dispose(): void { this.off?.(); this.off = null; this.term?.dispose(); this.term = null; this.el?.remove(); this.el = null; }
}
