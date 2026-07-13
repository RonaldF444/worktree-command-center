import * as fs from 'fs';
import * as path from 'path';
import { parseBoardLine, lockStatus, mergeEvents, isEvent, POLL_MS, type BoardEvent, type RawLine, type LockHolder } from './coordination';

const COORD_COLLAPSE_KEY = 'cos-coord-collapsed';

/** Whether the Coordination panel should start collapsed, given the persisted preference.
 *  Default (nothing stored) = collapsed, so it never pops open on a workspace switch; only an
 *  explicit '0' (the user expanded it) keeps it open. */
export function coordBoardStartsCollapsed(stored: string | null): boolean {
	return stored !== '0';
}

/** A collapsible panel showing the group's active locks + recent board feed, polled live. */
export class BoardView {
	private el: HTMLElement | null = null;
	private registryEl: HTMLElement | null = null;
	private locksEl: HTMLElement | null = null;
	private feedEl: HTMLElement | null = null;
	private hiddenEl: HTMLElement | null = null;
	private timer: number | null = null;

	constructor(
		private coordDir: string,
		private onReopen: (branch: string) => void = () => {},
		private hiddenProvider: () => Array<{ tileId: number; name: string; branch: string; repo: string }> = () => [],
		private onShow: (tileId: number) => void = () => {},
		private onClose: (tileId: number) => void = () => {},
	) {}

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-coord-board' });
		// Start as the user last left it (collapsed by default). mount() runs on every workspace
		// switch, which otherwise re-created the panel with no 'collapsed' class → it popped open
		// every time. Persist the toggle so the choice sticks across switches.
		let stored: string | null = null;
		try { stored = window.localStorage.getItem(COORD_COLLAPSE_KEY); } catch { /* no storage */ }
		if (coordBoardStartsCollapsed(stored)) this.el.classList.add('collapsed');
		const head = this.el.createDiv({ cls: 'cos-coord-head', text: '🛰 Coordination' });
		head.addEventListener('click', () => {
			const collapse = !this.el!.classList.contains('collapsed');
			this.el?.toggleClass('collapsed', collapse);
			try { window.localStorage.setItem(COORD_COLLAPSE_KEY, collapse ? '1' : '0'); } catch { /* no storage */ }
		});
		this.hiddenEl = this.el.createDiv({ cls: 'cos-coord-hidden' });
		this.registryEl = this.el.createDiv({ cls: 'cos-coord-registry' });
		this.locksEl = this.el.createDiv({ cls: 'cos-coord-locks' });
		this.feedEl = this.el.createDiv({ cls: 'cos-coord-feed' });
		this.renderAll();
		this.timer = window.setInterval(() => this.renderAll(), POLL_MS);
	}

	unmount(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		this.el?.remove();
		this.el = this.registryEl = this.locksEl = this.feedEl = this.hiddenEl = null;
	}

	/** Re-read worktrees.md + board.md and re-render everything. */
	public refresh(): void {
		this.renderAll();
	}

	private readRegistry(): string[] {
		try { return fs.readFileSync(path.join(this.coordDir, 'worktrees.md'), 'utf8').split('\n'); } catch { return []; }
	}

	private readLocks(): LockHolder[] {
		const dir = path.join(this.coordDir, 'locks');
		let names: string[] = [];
		try { names = fs.readdirSync(dir); } catch { return []; }
		const out: LockHolder[] = [];
		for (const n of names) {
			if (!n.endsWith('.json')) continue;
			try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as LockHolder); } catch { /* skip */ }
		}
		return out;
	}

	private readFeed(): Array<BoardEvent | RawLine> {
		let text = '';
		try { text = fs.readFileSync(path.join(this.coordDir, 'board.md'), 'utf8'); } catch { return []; }
		const parsed = text.split('\n').map(parseBoardLine).filter((x): x is BoardEvent | RawLine => x !== null);
		return mergeEvents(parsed as Array<{ ts?: number }>).slice(0, 50) as Array<BoardEvent | RawLine>;
	}

	private renderAll(): void {
		if (!this.registryEl || !this.locksEl || !this.feedEl || !this.hiddenEl) return;
		const now = Date.now();

		// Hidden-terminals section (in-memory, provided by the grid). Resurface with Show.
		this.hiddenEl.empty();
		const hiddenList = this.hiddenProvider();
		if (hiddenList.length) {
			this.hiddenEl.createDiv({ cls: 'cos-reg-repo', text: 'Hidden' });
			for (const h of hiddenList) {
				const row = this.hiddenEl.createDiv({ cls: 'cos-reg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: h.name });
				if (h.repo) row.createSpan({ cls: 'cos-reg-repo-tag', text: h.repo });
				if (h.branch && h.branch !== h.name) row.createSpan({ cls: 'cos-reg-detail', text: h.branch });
				const btn = row.createEl('button', { text: 'Show', cls: 'cos-reopen-btn' });
				btn.addEventListener('click', (e) => { e.stopPropagation(); this.onShow(h.tileId); });
				const x = row.createEl('button', { text: '✕', cls: 'cos-close-btn', attr: { title: 'Close — removes the worktree + branch' } });
				x.addEventListener('click', (e) => { e.stopPropagation(); this.onClose(h.tileId); });
			}
		}

		// Registry section (worktrees.md) — parse the markdown into clean styled rows
		// (a repo heading per `## repo`, a row per `- <branch> <badge> …`), not raw text.
		this.registryEl.empty();
		for (const raw of this.readRegistry()) {
			const t = raw.trim();
			if (!t || t === '# Worktrees') continue;            // skip the H1 (the panel head covers it)
			if (t.startsWith('## ')) {                           // repo heading
				this.registryEl.createDiv({ cls: 'cos-reg-repo', text: t.slice(3) });
				continue;
			}
			if (t.startsWith('_')) {                             // _No active worktrees._
				this.registryEl.createSpan({ cls: 'cos-coord-empty', text: t.replace(/_/g, '') });
				continue;
			}
			if (t.startsWith('- ')) {                            // a worktree row
				const body = t.slice(2);
				const branch = (body.match(/^(\S+)/)?.[1]) ?? body;
				const state = body.includes('[DIRTY]') ? 'dirty'
					: body.includes('[PARKED]') ? 'parked'
					: body.includes('[ahead]') ? 'ahead' : 'clean';
				const detail = body.slice(branch.length).trim()
					.replace(/^\[(DIRTY|PARKED|ahead)\]\s*/i, '')
					.replace(/^clean\s*/, '')
					.replace(/^·\s*/, '')
					.trim();
				const row = this.registryEl.createDiv({ cls: 'cos-reg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: branch });
				row.createSpan({ cls: `cos-reg-badge ${state}`, text: state });
				if (detail) row.createSpan({ cls: 'cos-reg-detail', text: detail });
				if (state === 'parked') {
					const btn = row.createEl('button', { text: 'Reopen', cls: 'cos-reopen-btn' });
					btn.addEventListener('click', (e) => { e.stopPropagation(); this.onReopen(branch); });
				}
			}
		}

		// Locks section.
		const locks = this.readLocks();
		this.locksEl.empty();
		if (!locks.length) {
			this.locksEl.createSpan({ cls: 'cos-coord-empty', text: 'no active locks' });
		}
		for (const l of locks) {
			const st = lockStatus(l, now);
			const age = Math.max(0, Math.round((now - l.ts) / 1000));
			const badge = this.locksEl.createSpan({ cls: `cos-coord-lock ${st}` });
			badge.setText(`🔒 ${l.resource} · ${l.holder}${l.reason ? ` · ${l.reason}` : ''} · ${age < 90 ? age + 's' : Math.round(age / 60) + 'm'}`);
		}

		// Event log feed.
		this.feedEl.empty();
		for (const e of this.readFeed()) {
			const row = this.feedEl.createDiv({ cls: 'cos-coord-row' });
			if (isEvent(e)) row.setText(`${e.terminal} · ${e.resource} ${e.status}${e.detail ? ' · ' + e.detail : ''}`);
			else row.setText(e.raw);
		}
	}
}
