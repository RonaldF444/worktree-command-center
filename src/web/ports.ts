/** The browser's copy of the desktop's ports badge (src/ui/ports-widget.ts): every localhost URL
 *  the sessions printed, from `floor:state`. A row opens through the desktop's Tailscale-only
 *  tunnel (electron/port-forward.ts) — same port, host swapped for the one this page came from. */
import type { FloorPort } from '../terminals/floor-state';
export { portsSignature } from '../terminals/floor-state';

/** `http://localhost:3000/x` seen from another device: the desktop's address, same port. LAN
 *  addresses are left alone — there is no tunnel for them. */
export function openUrlFor(url: string, pageHost: string): string {
	let u: URL;
	try { u = new URL(url); } catch { return url; }
	if (u.hostname !== 'localhost') return url;
	u.hostname = pageHost;
	return u.toString();
}

export interface WebPortsDeps { onCenter: (tileId: number) => void; pageHost: () => string }

export class WebPortsWidget {
	private btn: HTMLButtonElement | null = null;
	private menu: HTMLElement | null = null;
	private open = false;
	private items: FloorPort[] = [];
	private onDocClick: (() => void) | null = null;

	constructor(private deps: WebPortsDeps) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-ports web-ports' });
		this.btn = el.createEl('button', { cls: 'wcc-ports-btn', text: '⇢', attr: { title: 'Dev servers the terminals have printed — opens through the desktop' } });
		this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
		this.menu = el.createDiv({ cls: 'wcc-ports-menu' });
		this.menu.style.display = 'none';
		this.menu.addEventListener('click', (e) => e.stopPropagation());
		this.onDocClick = () => { if (this.open) this.toggle(false); };
		document.addEventListener('click', this.onDocClick);
	}

	update(items: FloorPort[]): void {
		this.items = items;
		if (this.btn) this.btn.setText(items.length > 0 ? `⇢ ${items.length}` : '⇢');
		if (this.open) this.renderMenu();
	}

	private toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		if (this.menu) this.menu.style.display = this.open ? 'block' : 'none';
		if (this.open) this.renderMenu();
	}

	private renderMenu(): void {
		if (!this.menu) return;
		this.menu.empty();
		if (!this.items.length) { this.menu.createDiv({ cls: 'wcc-ports-empty', text: 'No servers running' }); return; }
		let lastRepo = '';
		for (const it of this.items) {
			if (it.repo !== lastRepo) { this.menu.createDiv({ cls: 'wcc-ports-group', text: it.repo }); lastRepo = it.repo; }
			const row = this.menu.createDiv({ cls: 'wcc-ports-row' });
			row.createSpan({ cls: 'wcc-ports-port', text: `:${it.port}` });
			row.createSpan({ cls: 'wcc-ports-path', text: it.path || '/' });
			const name = row.createSpan({ cls: 'wcc-ports-name', text: it.name, attr: { title: 'Jump to the terminal that printed this' } });
			name.addEventListener('click', (e) => { e.stopPropagation(); this.deps.onCenter(it.tileId); this.toggle(false); });
			// Row click opens through the tunnel; Ctrl/Cmd+click copies the tunnel URL instead.
			row.addEventListener('click', (e) => {
				e.stopPropagation();
				const url = openUrlFor(it.url, this.deps.pageHost());
				if (e.ctrlKey || e.metaKey) { void navigator.clipboard?.writeText(url); return; }
				window.open(url, '_blank', 'noopener');
				this.toggle(false);
			});
		}
	}

	dispose(): void {
		if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
		this.onDocClick = null;
	}
}
