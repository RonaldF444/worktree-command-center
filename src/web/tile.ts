import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { scrollIntentForKey } from '../terminals/scroll-keys';
import { activeTerminalFont } from '../terminals/theme-store';

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

/** One mirrored terminal. The xterm is sized to the DESKTOP's PTY (setSize); the tile box scales
 *  around it — the browser never resizes the PTY, so the two screens cannot fight. */
export class WebTile {
	private el: HTMLElement | null = null;
	private nameEl: HTMLElement | null = null;
	private stateEl: HTMLElement | null = null;
	private badgeEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private off: (() => void) | null = null;
	private centered = false;

	constructor(private deps: WebTileDeps) {}

	render(parent: HTMLElement, head: { name: string; repo: string; branch: string; isKane?: boolean }): void {
		this.el = parent.createDiv({ cls: 'cos-term-tile web-tile' });
		const h = this.el.createDiv({ cls: 'cos-term-head' });
		this.badgeEl = h.createSpan({ cls: 'cos-term-badge' });
		this.nameEl = h.createSpan({ cls: 'cos-term-name', text: head.name, attr: { title: 'Double-click to rename' } });
		this.nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); const n = prompt('Rename terminal', this.nameEl?.textContent ?? ''); if (n && n.trim()) this.deps.onRename(n.trim()); });
		h.createSpan({ cls: 'web-tile-repo', text: `${head.repo} · ${head.branch}` });
		this.stateEl = h.createSpan({ cls: 'web-tile-state' });
		const btns = h.createDiv({ cls: 'cos-term-head-btns' });
		const hideBtn = btns.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — keeps the session running; restore from Coordination' } });
		hideBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deps.onHide(); });
		const killBtn = btns.createEl('button', { text: '×', attr: { title: 'Close — deletes this worktree + its branch' } });
		killBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(`Close "${this.nameEl?.textContent ?? head.name}"? Deletes its worktree + branch.`)) this.deps.onKill(); });
		if (head.isKane) btns.style.display = 'none';
		this.el.addEventListener('click', () => this.deps.onClick());
		const body = this.el.createDiv({ cls: 'cos-term-body' });
		body.addEventListener('mousedown', (e) => { if (!this.centered) { e.preventDefault(); e.stopImmediatePropagation(); this.deps.onClick(); } }, true);
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: false, scrollback: 5000, ...activeTerminalFont(), linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); } } });
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
	}
	setCentered(on: boolean): void { this.centered = on; this.el?.toggleClass('centered', on); }
	setSize(cols: number, rows: number): void { if (this.term && (this.term.cols !== cols || this.term.rows !== rows)) this.term.resize(cols, rows); }
	setHead(name: string, state: string, locked: boolean): void { this.nameEl?.setText(name); this.stateEl?.setText(state); this.el?.toggleClass('cos-term-lockon', locked); this.el?.setAttr('data-state', state); }
	setBadge(text: string | null): void { if (!this.badgeEl) return; this.badgeEl.setText(text ?? ''); this.badgeEl.style.display = text ? 'inline-block' : 'none'; }
	setPalette(p: Record<string, string>): void {
		if (!this.term) return;
		this.term.options.theme = p;
		const f = activeTerminalFont();
		this.term.options.fontWeight = f.fontWeight as never;
		this.term.options.fontWeightBold = f.fontWeightBold as never;
		this.term.options.minimumContrastRatio = f.minimumContrastRatio;
	}

	/** Snapshot FIRST, then subscribe — nothing missed, nothing doubled. */
	async attach(): Promise<void> {
		const snap = await this.deps.snapshot();
		this.term?.write(snap);
		this.off?.();
		this.off = this.deps.onData((chunk) => this.term?.write(chunk));
	}
	/** Reconnect: replace the whole buffer with a fresh snapshot (the stream may have gaps). */
	async resume(): Promise<void> {
		const snap = await this.deps.snapshot();
		this.term?.reset();
		this.term?.write(snap);
	}
	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }
	dispose(): void { this.off?.(); this.off = null; this.term?.dispose(); this.term = null; this.el?.remove(); this.el = null; }
}
