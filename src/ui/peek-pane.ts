import { openExternalUrl } from '../terminals/links';

/** A single reusable <webview> docked over the right of the stage. There is exactly ONE pane:
 *  peeking another URL swaps its src, so peeking can never pile up the way browser tabs do.
 *
 *  It overlays the stage rather than splitting the layout — a real split resizes every tile and
 *  drives xterm's fit path (see fit-throttle) on every open and close.
 *
 *  Guests are already hardened in electron/main.ts (web-contents-created): window.open and
 *  target=_blank go to the real browser, and non-web protocols are dropped. */
export class PeekPane {
	private el: HTMLElement | null = null;
	private view: HTMLElement | null = null; // <webview>
	private urlEl: HTMLElement | null = null;
	private url = '';
	private onKey: ((e: KeyboardEvent) => void) | null = null;

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'wcc-peek' });
		this.el.style.display = 'none';
		const head = this.el.createDiv({ cls: 'wcc-peek-head' });
		this.urlEl = head.createSpan({ cls: 'wcc-peek-url' });
		const btns = head.createDiv({ cls: 'wcc-peek-btns' });
		const reload = btns.createEl('button', { text: '⟳', attr: { title: 'Reload' } });
		reload.addEventListener('click', (e) => { e.stopPropagation(); this.reload(); });
		const pop = btns.createEl('button', { text: '⧉', attr: { title: 'Open in browser' } });
		pop.addEventListener('click', (e) => { e.stopPropagation(); if (this.url) openExternalUrl(this.url); });
		const close = btns.createEl('button', { text: '×', attr: { title: 'Close (Esc)' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

		// createElement, not createDiv: <webview> is a custom element, enabled by webviewTag in
		// electron/main.ts. Created once and reused for every peek.
		const view = document.createElement('webview');
		view.className = 'wcc-peek-view';
		view.setAttribute('allowpopups', ''); // so main's window-open handler fires and routes to the browser
		this.el.appendChild(view);
		this.view = view;

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
	}

	private isOpen(): boolean { return !!this.el && this.el.style.display !== 'none'; }

	show(url: string): void {
		if (!this.el || !this.view) return;
		this.url = url;
		this.urlEl?.setText(url);
		this.view.setAttribute('src', url);
		this.el.style.display = 'flex';
	}

	private reload(): void {
		// Re-setting src is enough and avoids depending on the webview's own reload() typing.
		if (this.view && this.url) this.view.setAttribute('src', this.url);
	}

	close(): void {
		if (!this.el || !this.view) return;
		this.el.style.display = 'none';
		// Drop the page so a peeked dev server is not left polling/socketing in the background.
		this.view.setAttribute('src', 'about:blank');
		this.url = '';
	}

	dispose(): void {
		if (this.onKey) document.removeEventListener('keydown', this.onKey);
		this.onKey = null;
	}
}
