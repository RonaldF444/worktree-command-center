import { openExternalUrl } from '../terminals/links';
import {
	applyDrag, applyResize, clampToViewport, defaultGeometry, normalizeGeometry,
	type Geometry, type ResizeEdge, type Viewport,
} from './pane-geometry';

const GEOM_KEY = 'wcc.peek.geom';
const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** A single reusable <webview> floating over the stage: drag the header to move it, drag any
 *  edge or corner to resize, ─ to collapse it to its header, □ to fill the stage. There is
 *  exactly ONE pane — peeking another URL swaps its src, so peeks can never pile up the way
 *  browser tabs do.
 *
 *  It overlays the stage rather than splitting the layout — a real split resizes every tile and
 *  drives xterm's fit path (see fit-throttle) on every open, close and drag.
 *
 *  Guests are already hardened in electron/main.ts (web-contents-created): window.open and
 *  target=_blank go to the real browser, and non-web protocols are dropped. */
export class PeekPane {
	private host: HTMLElement | null = null;
	private el: HTMLElement | null = null;
	private view: HTMLElement | null = null; // <webview>
	private urlEl: HTMLElement | null = null;
	private url = '';
	private geom: Geometry = { left: 0, top: 0, width: 0, height: 0 };
	private restoreGeom: Geometry | null = null; // set only while maximized
	private minimized = false;
	private onKey: ((e: KeyboardEvent) => void) | null = null;
	private onResize: (() => void) | null = null;

	mount(parent: HTMLElement): void {
		this.host = parent;
		this.el = parent.createDiv({ cls: 'wcc-peek' });
		this.el.style.display = 'none';

		const head = this.el.createDiv({ cls: 'wcc-peek-head' });
		this.urlEl = head.createSpan({ cls: 'wcc-peek-url' });
		const btns = head.createDiv({ cls: 'wcc-peek-btns' });
		const reload = btns.createEl('button', { text: '⟳', attr: { title: 'Reload' } });
		reload.addEventListener('click', (e) => { e.stopPropagation(); this.reload(); });
		const pop = btns.createEl('button', { text: '⧉', attr: { title: 'Open in browser' } });
		pop.addEventListener('click', (e) => { e.stopPropagation(); if (this.url) openExternalUrl(this.url); });
		const min = btns.createEl('button', { text: '─', attr: { title: 'Minimize' } });
		min.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMinimize(); });
		const max = btns.createEl('button', { text: '□', attr: { title: 'Maximize / restore' } });
		max.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMaximize(); });
		const close = btns.createEl('button', { text: '×', attr: { title: 'Close (Esc)' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

		// createElement, not createDiv: <webview> is a custom element, enabled by webviewTag in
		// electron/main.ts. Created once and reused for every peek.
		const view = document.createElement('webview');
		view.className = 'wcc-peek-view';
		view.setAttribute('allowpopups', ''); // so main's window-open handler fires and routes to the browser
		this.el.appendChild(view);
		this.view = view;

		for (const edge of EDGES) {
			const h = this.el.createDiv({ cls: `wcc-peek-h wcc-peek-h-${edge}` });
			h.addEventListener('pointerdown', (e) => {
				if (this.minimized || this.restoreGeom) return; // nothing to resize when collapsed or filling the stage
				this.gesture(h, e, (dx, dy, start) => applyResize(start, edge, dx, dy));
			});
		}

		head.addEventListener('pointerdown', (e) => {
			if ((e.target as HTMLElement).closest('button')) return; // buttons are not drag handles
			if (this.restoreGeom) return; // maximized: nowhere to move it
			this.gesture(head, e, (dx, dy, start) => applyDrag(start, dx, dy));
		});
		head.addEventListener('dblclick', (e) => {
			if ((e.target as HTMLElement).closest('button')) return;
			this.toggleMaximize();
		});

		// The header must track what the guest is actually showing, not the URL the pane was
		// opened with — a dev server can redirect (/ -> /login), bounce through OAuth, or the
		// user can click an in-page link. Without this the ⧉ button would reopen a stale URL
		// instead of the page on screen, defeating the "peek graduates into a real tab" point.
		// 'about:blank' is close()'s own reset sentinel, never a page a user peeked at, so it
		// must not resurrect the header after the pane has already been closed.
		const onNavigate = (e: Event) => {
			const url = (e as Event & { url: string }).url;
			if (url === 'about:blank') return;
			this.url = url;
			this.urlEl?.setText(this.url);
		};
		view.addEventListener('did-navigate', onNavigate);
		// Most dev servers client-side route (hash changes, pushState/replaceState), which never
		// fires did-navigate — only this event does, so it needs the same handler to keep up.
		view.addEventListener('did-navigate-in-page', onNavigate);

		// Esc closes — but only when focus is OUTSIDE the guest. A focused webview swallows keys
		// before the host sees them (main.ts mirrors F11/Ctrl+digit for exactly this reason), so
		// the × button is the reliable close once you have clicked into the page.
		this.onKey = (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); };
		document.addEventListener('keydown', this.onKey);

		// A shrinking window (or a monitor change) must not strand the pane out of reach.
		this.onResize = () => { if (this.isOpen()) this.setGeom(this.geom); };
		window.addEventListener('resize', this.onResize);

		this.geom = normalizeGeometry(this.loadGeom(), this.viewport()) ?? defaultGeometry(this.viewport());
		this.applyGeom();
	}

	private viewport(): Viewport {
		const h = this.host;
		return { width: h?.clientWidth || window.innerWidth, height: h?.clientHeight || window.innerHeight };
	}

	private setGeom(g: Geometry): void {
		this.geom = clampToViewport(g, this.viewport());
		this.applyGeom();
	}

	private applyGeom(): void {
		const { el, geom } = this;
		if (!el) return;
		el.style.left = `${geom.left}px`;
		el.style.top = `${geom.top}px`;
		el.style.width = `${geom.width}px`;
		// Collapsed panes are header-height; CSS drives that so the restore size stays in geom.
		if (!this.minimized) el.style.height = `${geom.height}px`;
	}

	/** Run a pointer drag: capture the pointer, feed deltas through a pure geometry update, and
	 *  shield the guest while it lasts. Without the shield the <webview> eats pointermove the
	 *  instant the cursor crosses into the page, and the gesture dies mid-drag. */
	private gesture(el: HTMLElement, e: PointerEvent, update: (dx: number, dy: number, start: Geometry) => Geometry): void {
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		const start = this.geom;
		el.setPointerCapture(e.pointerId);
		if (this.view) this.view.style.pointerEvents = 'none';
		const move = (ev: PointerEvent) => this.setGeom(update(ev.clientX - startX, ev.clientY - startY, start));
		const up = (ev: PointerEvent) => {
			el.releasePointerCapture(ev.pointerId);
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			if (this.view) this.view.style.pointerEvents = '';
			this.saveGeom();
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	private toggleMinimize(): void {
		this.minimized = !this.minimized;
		this.el?.toggleClass('is-min', this.minimized);
		if (!this.minimized) this.applyGeom(); // restore the remembered height
		else if (this.el) this.el.style.height = '';
	}

	private toggleMaximize(): void {
		if (this.restoreGeom) {
			const g = this.restoreGeom;
			this.restoreGeom = null;
			this.el?.toggleClass('is-max', false);
			this.setGeom(g);
			return;
		}
		if (this.minimized) this.toggleMinimize(); // maximizing a collapsed pane should show it
		this.restoreGeom = this.geom;
		this.el?.toggleClass('is-max', true);
		const vp = this.viewport();
		this.setGeom({ left: 0, top: 0, width: vp.width, height: vp.height });
	}

	private loadGeom(): unknown {
		try { return JSON.parse(window.localStorage.getItem(GEOM_KEY) ?? 'null'); } catch { return null; }
	}

	private saveGeom(): void {
		// Only the restore geometry is worth keeping — a maximized pane's rect is just the stage.
		const g = this.restoreGeom ?? this.geom;
		try { window.localStorage.setItem(GEOM_KEY, JSON.stringify(g)); } catch { /* storage full or blocked */ }
	}

	private isOpen(): boolean { return !!this.el && this.el.style.display !== 'none'; }

	show(url: string): void {
		if (!this.el || !this.view) return;
		this.url = url;
		this.urlEl?.setText(url);
		this.view.setAttribute('src', url);
		this.el.style.display = 'flex';
		// Re-clamp on open: the window may have changed size since the geometry was last set.
		this.setGeom(this.geom);
	}

	private reload(): void {
		// Re-setting src is enough and avoids depending on the webview's own reload() typing.
		if (this.view && this.url) this.view.setAttribute('src', this.url);
	}

	close(): void {
		if (!this.el || !this.view) return;
		this.el.style.display = 'none';
		// Drop the page so a peeked dev server is not left polling/socketing in the background.
		// (Minimize deliberately does NOT do this — a collapsed peek stays loaded so restoring
		// it is instant.)
		this.view.setAttribute('src', 'about:blank');
		this.url = '';
	}

	dispose(): void {
		if (this.onKey) document.removeEventListener('keydown', this.onKey);
		if (this.onResize) window.removeEventListener('resize', this.onResize);
		this.onKey = null;
		this.onResize = null;
	}
}
