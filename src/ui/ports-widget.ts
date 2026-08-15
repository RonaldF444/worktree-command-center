import type { PortItem } from '../terminals/port-registry';
import { openExternalUrl } from '../terminals/links';
import { writeClipboardText } from '../terminals/clipboard';

/** Topbar ports badge + dropdown: every localhost URL the sessions have printed, grouped by
 *  repo. Structural sibling of AttentionWidget — same poll/dismiss/dispose shape. */
export class PortsWidget {
	private btn: HTMLButtonElement | null = null;
	private menu: HTMLElement | null = null;
	private open = false;
	private timer: number | null = null;
	private onDocClick: ((e: MouseEvent) => void) | null = null;

	constructor(
		private provider: () => PortItem[],
		private onReveal: (tileId: number) => void,
		private onPeek: (url: string) => void,
	) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-ports' });
		this.btn = el.createEl('button', { cls: 'wcc-ports-btn', text: '⇢', attr: { title: 'Dev servers these terminals have printed' } });
		this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
		this.menu = el.createDiv({ cls: 'wcc-ports-menu' });
		this.menu.style.display = 'none';
		this.onDocClick = () => { if (this.open) this.toggle(false); };
		document.addEventListener('click', this.onDocClick);
		this.tick();
		this.timer = window.setInterval(() => this.tick(), 1500);
	}

	private tick(): void {
		const items = this.provider();
		if (this.btn) this.btn.setText(items.length > 0 ? `⇢ ${items.length}` : '⇢');
		if (this.open) this.renderMenu(items);
	}

	private toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		if (this.menu) this.menu.style.display = this.open ? 'block' : 'none';
		if (this.open) this.renderMenu(this.provider());
	}

	private renderMenu(items: PortItem[]): void {
		if (!this.menu) return;
		this.menu.empty();
		if (!items.length) { this.menu.createDiv({ cls: 'wcc-ports-empty', text: 'No servers running' }); return; }
		let lastRepo = '';
		for (const it of items) {
			// portItems() is sorted by repo, then tile, then port — so a repo's rows are
			// contiguous and a heading only needs emitting when the repo changes.
			if (it.repo !== lastRepo) { this.menu.createDiv({ cls: 'wcc-ports-group', text: it.repo }); lastRepo = it.repo; }
			this.renderRow(this.menu.createDiv({ cls: 'wcc-ports-row' }), it);
		}
	}

	private renderRow(row: HTMLElement, it: PortItem): void {
		row.createSpan({ cls: 'wcc-ports-port', text: `:${it.port}` });
		row.createSpan({ cls: 'wcc-ports-path', text: it.path || '/' });
		const name = row.createSpan({ cls: 'wcc-ports-name', text: it.name, attr: { title: 'Jump to the terminal that printed this' } });
		name.addEventListener('click', (e) => { e.stopPropagation(); this.onReveal(it.tileId); this.toggle(false); });
		const peek = row.createEl('button', { cls: 'wcc-ports-peek', text: '▣', attr: { title: 'Peek inside WCC — no browser tab' } });
		peek.addEventListener('click', (e) => { e.stopPropagation(); this.onPeek(it.url); this.toggle(false); });
		// Row click opens for real; Ctrl/Cmd+click copies instead, for pasting into a script.
		row.addEventListener('click', (e) => {
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) { writeClipboardText(it.url); return; } // sync, returns void
			openExternalUrl(it.url);
			this.toggle(false);
		});
	}

	dispose(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
	}
}
