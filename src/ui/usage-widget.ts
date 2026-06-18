import { UsageProbe } from '../terminals/usage-probe';
import type { UsageReadout } from '../terminals/usage-parse';

const AUTO_MS = 60_000; // auto-refresh cadence when enabled

/** Topbar usage battery: session % + reset and weekly % inline; ⟳ manual refresh; an auto-
 *  refresh toggle; and a click-to-expand popover with session / week / credits detail. */
export class UsageWidget {
	private battEl: HTMLElement | null = null;
	private battFill: HTMLElement | null = null;
	private sessionLabel: HTMLElement | null = null;
	private weekLabel: HTMLElement | null = null;
	private refreshBtn: HTMLButtonElement | null = null;
	private autoBtn: HTMLButtonElement | null = null;
	private pop: HTMLElement | null = null;
	private busy = false;
	private auto = false;
	private autoTimer: number | null = null;
	private last: UsageReadout | null = null;
	private onDocClick: ((e: MouseEvent) => void) | null = null;

	constructor(private probe: UsageProbe) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-usage' });
		this.battEl = el.createDiv({ cls: 'wcc-batt', attr: { title: 'Current session (5-hour window). Click for detail. Approximate · this machine only.' } });
		this.battFill = this.battEl.createDiv({ cls: 'wcc-batt-fill' });
		this.battEl.addEventListener('click', (e) => { e.stopPropagation(); this.togglePop(); });
		this.sessionLabel = el.createSpan({ cls: 'wcc-usage-session', text: 'tap ⟳ for usage' });
		this.weekLabel = el.createSpan({ cls: 'wcc-usage-week', text: '' });
		this.autoBtn = el.createEl('button', { cls: 'wcc-usage-auto', text: '⏱', attr: { title: 'Auto-refresh every 60s (off)' } });
		this.autoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAuto(); });
		this.refreshBtn = el.createEl('button', { cls: 'wcc-usage-refresh', text: '⟳', attr: { title: 'Refresh usage' } });
		this.refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.refresh(); });
		this.pop = el.createDiv({ cls: 'wcc-usage-pop' });
		this.pop.style.display = 'none';
		this.onDocClick = () => this.togglePop(false);
		document.addEventListener('click', this.onDocClick);
	}

	private togglePop(force?: boolean): void {
		if (!this.pop) return;
		const open = force ?? this.pop.style.display === 'none';
		this.pop.style.display = open ? 'block' : 'none';
		if (open) this.renderPop();
	}

	private async refresh(): Promise<void> {
		if (this.busy || !this.refreshBtn) return;
		this.busy = true;
		this.refreshBtn.textContent = '…';
		this.refreshBtn.disabled = true;
		try {
			this.last = await this.probe.refresh();
			this.apply(this.last);
		} catch {
			this.sessionLabel!.textContent = "couldn't read usage — try again";
		} finally {
			this.busy = false;
			this.refreshBtn.textContent = '⟳';
			this.refreshBtn.disabled = false;
		}
	}

	private apply(r: UsageReadout): void {
		// Battery = REMAINING (full when unused, drains as you use), like a real battery.
		const left = r.sessionPct === null ? null : Math.max(0, 100 - r.sessionPct);
		if (this.battFill) {
			this.battFill.style.width = `${left ?? 0}%`;
			// low battery → red.
			this.battFill.dataset.level = left === null ? '' : left >= 50 ? 'ok' : left >= 20 ? 'warn' : 'crit';
		}
		this.sessionLabel!.textContent = left === null
			? 'usage unavailable'
			: `${left}% left${r.sessionReset ? ` · resets ${r.sessionReset}` : ''}`;
		this.weekLabel!.textContent = r.weekPct === null ? '' : `Week ${Math.max(0, 100 - r.weekPct)}% left`;
		if (this.pop && this.pop.style.display !== 'none') this.renderPop();
	}

	private renderPop(): void {
		if (!this.pop) return;
		this.pop.empty();
		const r = this.last;
		if (!r) { this.pop.createDiv({ cls: 'wcc-usage-poprow', text: 'Tap ⟳ to load usage.' }); return; }
		const row = (label: string, value: string) => {
			const d = this.pop!.createDiv({ cls: 'wcc-usage-poprow' });
			d.createSpan({ cls: 'wcc-usage-poplabel', text: label });
			d.createSpan({ cls: 'wcc-usage-popval', text: value });
		};
		const leftOf = (p: number | null) => (p === null ? '—' : `${Math.max(0, 100 - p)}% left`);
		row('Session', r.sessionPct === null ? '—' : `${leftOf(r.sessionPct)}${r.sessionReset ? ` · resets ${r.sessionReset}` : ''}`);
		row('Week', r.weekPct === null ? '—' : `${leftOf(r.weekPct)}${r.weekReset ? ` · resets ${r.weekReset}` : ''}`);
		row('Credits', r.creditsSpent ? `${r.creditsSpent}${r.creditsReset ? ` · resets ${r.creditsReset}` : ''}` : (r.creditsPct === null ? '—' : `${r.creditsPct}% used`));
		this.pop.createDiv({ cls: 'wcc-usage-popnote', text: 'approx · this machine only' });
	}

	private toggleAuto(): void {
		this.auto = !this.auto;
		this.autoBtn?.toggleClass('on', this.auto);
		this.autoBtn?.setAttribute('title', `Auto-refresh every 60s (${this.auto ? 'on' : 'off'})`);
		if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
		if (this.auto) { void this.refresh(); this.autoTimer = window.setInterval(() => void this.refresh(), AUTO_MS); }
	}

	dispose(): void {
		if (this.autoTimer !== null) { window.clearInterval(this.autoTimer); this.autoTimer = null; }
		if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
	}
}
