import type { Bridge } from './bridge';
import { WebTile } from './tile';
import { diffIds } from './diff';
import { WebPortsWidget } from './ports';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, nextSpotlight } from '../terminals/bubble-layout';
import { SPAWN_MODELS, SPAWN_EFFORTS } from '../terminals/spawn-options';
import { normalizeTheme, setActiveTheme, activeTerminalPalette } from '../terminals/theme-store';
import type { FloorState } from '../terminals/floor-state';
import { toast } from '../ui/toast';

const GAP = 8;

/** The mirrored floor: renders from `floor:state`, sends every action to the desktop. One source
 *  of truth — the desktop's centeredId is the browser's centeredId. */
export function mountFloor(root: HTMLElement, bridge: Bridge): () => void {
	root.empty();
	let state: FloorState | null = null;
	const tiles = new Map<number, WebTile>();
	let kane: WebTile | null = null;
	let kaneOpen = false;
	let altDown = false;

	// --- chrome ---
	const top = root.createDiv({ cls: 'wcc-topbar' });
	top.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center · browser' });
	const status = top.createSpan({ cls: 'wcc-status', text: '' });
	const usage = top.createSpan({ cls: 'wcc-usage-session web-usage', text: '' });
	const ports = new WebPortsWidget({ onCenter: (id) => void bridge.invoke('tile:center', { id }), pageHost: () => location.hostname });
	ports.render(top);
	const logout = top.createEl('button', { text: 'Sign out' });
	logout.addEventListener('click', () => bridge.logout());
	const tabs = root.createDiv({ cls: 'wcc-tabs' });
	const container = root.createDiv({ cls: 'wcc-grid-container' });
	const controls = container.createDiv({ cls: 'cos-terminals-controls' });
	const repoSel = controls.createEl('select');
	const modelSel = controls.createEl('select'); for (const m of SPAWN_MODELS) modelSel.createEl('option', { text: m.label, value: m.value });
	modelSel.value = SPAWN_MODELS.find((m) => m.label.startsWith('Opus'))?.value ?? '';
	const effortSel = controls.createEl('select'); for (const e of SPAWN_EFFORTS) effortSel.createEl('option', { text: e.label, value: e.value });
	const task = controls.createEl('input', { type: 'text', placeholder: 'Task for the new terminal', cls: 'web-task' });
	const play = controls.createEl('button', { text: '▶ Play', cls: 'cos-play-btn' });
	play.addEventListener('click', () => {
		if (!repoSel.value || !task.value.trim()) { toast('Pick a repo and type a task'); return; }
		void bridge.invoke('tile:spawn', { repo: repoSel.value, task: task.value.trim(), model: modelSel.value || null, effort: effortSel.value || null }).then((ok) => { if (ok) task.value = ''; else toast('Spawn failed'); }, () => toast('Spawn failed'));
	});
	const kaneBtn = controls.createEl('button', { text: '🜲 Kane', cls: 'cos-god-btn' });
	kaneBtn.addEventListener('click', () => toggleKane());
	const boardBtn = controls.createEl('button', { text: '📋 Coordination' });
	const board = container.createDiv({ cls: 'web-board' }); board.style.display = 'none';
	boardBtn.addEventListener('click', () => { board.style.display = board.style.display === 'none' ? '' : 'none'; if (board.style.display !== 'none') void refreshBoard(); });
	const wrap = container.createDiv({ cls: 'cos-stage-wrap' });
	const stage = wrap.createDiv({ cls: 'cos-terminals-stage' });
	const dock = wrap.createDiv({ cls: 'cos-god-panel web-kane' }); dock.style.display = 'none';

	// --- helpers ---
	const key = (id: number | 'kane'): string => `${state?.workspaceId ?? ''}:${id}`;
	const tileDeps = (id: number | 'kane') => ({
		key: key(id),
		snapshot: () => bridge.invoke<string>(id === 'kane' ? 'kane:snapshot' : 'tile:snapshot', id === 'kane' ? undefined : { id }),
		write: (data: string) => { void bridge.invoke(id === 'kane' ? 'kane:write' : 'tile:write', id === 'kane' ? { data } : { id, data }).catch(() => {}); },
		onData: (cb: (chunk: string) => void) => bridge.on('tile:data', (p) => { const m = p as { key: string; chunk: string }; if (m.key === key(id)) cb(m.chunk); }),
		onClick: () => { if (id !== 'kane') void bridge.invoke('tile:center', { id }); },
		onRename: (name: string) => { if (id !== 'kane') void bridge.invoke('tile:rename', { id, name }); },
		onHide: () => { if (id !== 'kane') void bridge.invoke('tile:hide', { id }); },
		onKill: () => { if (id !== 'kane') void bridge.invoke('tile:kill', { id }); },
	});

	async function refreshBoard(): Promise<void> {
		const b = await bridge.invoke<{ hidden: Array<{ id: number; name: string; branch: string; repo: string }>; registry: string }>('board:get').catch(() => null);
		board.empty();
		if (!b) { board.createDiv({ text: 'Board unavailable' }); return; }
		board.createDiv({ cls: 'web-board-h', text: `Hidden sessions (${b.hidden.length})` });
		for (const h of b.hidden) {
			const row = board.createDiv({ cls: 'web-board-row' });
			row.createSpan({ text: `${h.name} · ${h.repo} · ${h.branch}` });
			const show = row.createEl('button', { text: 'Show' }); show.addEventListener('click', () => void bridge.invoke('tile:show', { id: h.id }).then(refreshBoard));
			const kill = row.createEl('button', { text: '×' }); kill.addEventListener('click', () => { if (confirm(`Close "${h.name}"? Deletes its worktree + branch.`)) void bridge.invoke('tile:kill', { id: h.id }).then(refreshBoard); });
		}
		board.createEl('pre', { cls: 'web-board-reg', text: b.registry });
	}

	function toggleKane(): void {
		kaneOpen = !kaneOpen;
		dock.style.display = kaneOpen ? '' : 'none';
		kaneBtn.toggleClass('cos-god-on', kaneOpen);
		if (kaneOpen && !kane && state?.kane) {
			kane = new WebTile(tileDeps('kane'));
			kane.render(dock, { name: state.kane.name, repo: 'overseer', branch: '', isKane: true });
			kane.setSize(state.kane.cols, state.kane.rows);
			kane.setPalette(activeTerminalPalette());
			void kane.attach();
		}
		if (kaneOpen) kane?.focus();
		layout();
	}

	function layout(): void {
		if (!state) return;
		const W = stage.clientWidth || 800, H = stage.clientHeight || 500;
		const visible = state.terminals.filter((t) => !t.hidden).map((t) => t.id);
		const center = state.centeredId !== null && visible.includes(state.centeredId) ? state.centeredId : null;
		const rects = center !== null ? centeredLayout(visible, W, H, GAP, center) : settledLayout(visible, W, H, GAP);
		for (const [id, tile] of tiles) {
			const r = rects.find((x) => x.id === id);
			if (r) tile.setRect(r);
			tile.setCentered(id === center);
		}
		if (altDown) visible.forEach((id, i) => tiles.get(id)?.setBadge(keyForIndex(i)));
		if (kaneOpen) kane?.fitToSelf();
	}

	function applyState(next: FloorState): void {
		const prevWs = state?.workspaceId;
		const prevCenteredId = state?.centeredId ?? null;
		state = next;
		if (prevWs !== undefined && prevWs !== next.workspaceId) { for (const t of tiles.values()) t.dispose(); tiles.clear(); kane?.dispose(); kane = null; }
		// theme
		const themeId = normalizeTheme(next.theme);
		if (document.documentElement.dataset.theme !== themeId) { document.documentElement.dataset.theme = themeId; setActiveTheme(themeId); const p = activeTerminalPalette(); for (const t of tiles.values()) t.setPalette(p); kane?.setPalette(p); }
		// tabs
		tabs.empty();
		for (const w of next.workspaces) { const tab = tabs.createDiv({ cls: 'wcc-tab' }); tab.toggleClass('active', w.active); tab.createSpan({ cls: 'wcc-tab-name', text: w.name }); tab.addEventListener('click', () => void bridge.invoke('workspace:switch', { id: w.id })); }
		// repos
		const cur = repoSel.value; repoSel.empty(); for (const r of next.repos) repoSel.createEl('option', { text: r, value: r }); if (next.repos.includes(cur)) repoSel.value = cur;
		// usage
		if (next.usage && next.usage.sessionPct !== null) {
			let t = `session ${next.usage.sessionPct}% · week ${next.usage.weekPct ?? '?'}%`;
			if (next.usage.fablePct !== null) t += ` · fable ${next.usage.fablePct}%`;
			usage.setText(t);
		} else {
			usage.setText('');
		}
		status.setText(`${next.terminals.length} sessions`);
		ports.update(next.ports ?? []);
		// tiles
		const wanted = next.terminals.filter((t) => !t.hidden).map((t) => t.id);
		const { added, removed } = diffIds([...tiles.keys()], wanted);
		for (const id of removed) { tiles.get(id)?.dispose(); tiles.delete(id); }
		for (const id of added) {
			const info = next.terminals.find((t) => t.id === id)!;
			const tile = new WebTile(tileDeps(id));
			tile.render(stage, { name: info.name, repo: info.repo, branch: info.branch });
			tile.setPalette(activeTerminalPalette());
			tiles.set(id, tile);
			void tile.attach();
		}
		for (const info of next.terminals) { const t = tiles.get(info.id); if (!t) continue; t.setSize(info.cols, info.rows); t.setHead(info.name, info.state, info.locked); }
		if (next.kane && kane) kane.setSize(next.kane.cols, next.kane.rows);
		kaneBtn.disabled = !next.kane;
		layout();
		if (next.centeredId !== prevCenteredId && next.centeredId !== null) {
			const ae = document.activeElement;
			const typing = ae instanceof HTMLInputElement || ae instanceof HTMLSelectElement || (ae instanceof HTMLTextAreaElement && !ae.classList.contains('xterm-helper-textarea'));
			if (!typing) tiles.get(next.centeredId)?.focus();
		}
	}

	// --- wiring ---
	const offState = bridge.on('floor:state', (p) => applyState(p as FloorState));
	const offExit = bridge.on('tile:exit', (p) => { const k = (p as { key: string }).key; for (const [id, t] of tiles) if (key(id) === k) { t.dispose(); tiles.delete(id); } layout(); });
	const offStatus = bridge.onStatus((s) => {
		if (s !== 'open') return;
		void bridge.invoke<FloorState>('floor:state').then((st) => { applyState(st); for (const t of tiles.values()) void t.resume(); void kane?.resume(); });
	});
	void bridge.invoke<FloorState>('floor:state').then(applyState).catch(() => toast('Could not load the floor'));
	const onResize = (): void => layout();
	window.addEventListener('resize', onResize);
	// Observe the stage AND the Kane dock: the dock is user-resizable (CSS `resize` in web.css),
	// and a drag must re-fit Kane's font to the new width so nothing is left clipped.
	const ro = new ResizeObserver(onResize); ro.observe(stage); ro.observe(dock);

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Alt') { altDown = true; layout(); return; }
		if (!e.altKey || !state) return;
		const visible = state.terminals.filter((t) => !t.hidden).map((t) => t.id);
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); const want = nextSpotlight(visible, state.centeredId, e.key === 'ArrowRight' ? 1 : -1); if (want !== null) void bridge.invoke('tile:center', { id: want }); return; }
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); const ws = state.workspaces; if (ws.length < 2) return; const i = Math.max(0, ws.findIndex((w) => w.active)); const n = ws[(i + (e.key === 'ArrowDown' ? 1 : -1) + ws.length) % ws.length]!; void bridge.invoke('workspace:switch', { id: n.id }); return; }
		if (e.key === 'k' || e.key === 'K') { if (!state.kane) return; e.preventDefault(); e.stopPropagation(); if (!kaneOpen) toggleKane(); else kane?.focus(); return; }
		const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
		const idx = keyToIndex(norm);
		if (idx !== null && visible[idx] !== undefined) { e.preventDefault(); e.stopPropagation(); void bridge.invoke('tile:center', { id: visible[idx] }); }
	};
	const onKeyUp = (e: KeyboardEvent): void => { if (e.key === 'Alt') { altDown = false; for (const t of tiles.values()) t.setBadge(null); } };
	document.addEventListener('keydown', onKeyDown, true);
	document.addEventListener('keyup', onKeyUp, true);

	return () => {
		offState(); offExit(); offStatus();
		window.removeEventListener('resize', onResize); ro.disconnect();
		document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('keyup', onKeyUp, true);
		for (const t of tiles.values()) t.dispose(); tiles.clear(); kane?.dispose();
		ports.dispose();
		root.empty();
	};
}
