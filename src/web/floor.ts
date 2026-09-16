import type { Bridge } from './bridge';
import { WebTile } from './tile';
import { diffIds } from './diff';
import { WebPortsWidget } from './ports';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex } from '../terminals/bubble-layout';
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

	// Left-edge drag grip to resize the Kane dock — a full-height strip, mirroring the desktop
	// (god-console.ts). The old approach was CSS `resize: horizontal`, whose grip sits at the
	// dock's bottom-right corner; on a viewport-tall dock that corner is at the very bottom of the
	// screen, so the dock could not be narrowed and Kane crushed the stage (cutting the spotlight
	// terminal in half). Width is persisted and clamped to [280px, 70vw].
	const GOD_WIDTH_KEY = 'cos-web-god-width';
	const clampWidth = (w: number): number => Math.min(Math.max(280, Math.round(w)), Math.round(window.innerWidth * 0.7));
	const applyDockWidth = (w: number): void => { dock.style.flex = `0 0 ${clampWidth(w)}px`; };
	{
		const saved = Number(localStorage.getItem(GOD_WIDTH_KEY));
		if (Number.isFinite(saved) && saved >= 280) applyDockWidth(saved);
	}
	const grip = dock.createDiv({ cls: 'web-kane-grip', attr: { title: 'Drag to resize Kane' } });
	grip.addEventListener('pointerdown', (e: PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = dock.getBoundingClientRect().width;
		grip.setPointerCapture(e.pointerId);
		grip.classList.add('dragging');
		const move = (ev: PointerEvent): void => { applyDockWidth(startW + (startX - ev.clientX)); kane?.fitToSelf(); };
		const up = (ev: PointerEvent): void => {
			grip.classList.remove('dragging');
			grip.removeEventListener('pointermove', move);
			grip.removeEventListener('pointerup', up);
			grip.removeEventListener('pointercancel', up);
			try { grip.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
			try { localStorage.setItem(GOD_WIDTH_KEY, String(Math.round(dock.getBoundingClientRect().width))); } catch { /* storage blocked */ }
			kane?.fitToSelf();
		};
		grip.addEventListener('pointermove', move);
		grip.addEventListener('pointerup', up);
		grip.addEventListener('pointercancel', up);
	});

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
		onRefresh: () => { if (id !== 'kane') void bridge.invoke('tile:refresh', { id }).catch(() => toast('Refresh failed')); },
		// Fill mode (Kane + the spotlight tile): this browser's geometry becomes the PTY's shape.
		resize: (cols: number, rows: number) => { void bridge.invoke(id === 'kane' ? 'kane:resize' : 'tile:resize', id === 'kane' ? { cols, rows } : { id, cols, rows }).catch(() => {}); },
		// Pasted image: the bytes go to the host, which saves them and types the path into the
		// session (claude reads images by path, and it runs there, not here).
		pasteImage: (data: string, mime: string) => {
			void bridge.invoke(id === 'kane' ? 'kane:image' : 'tile:image', id === 'kane' ? { data, mime } : { id, data, mime })
				.then((ok) => { if (ok === false) toast('Could not paste the image'); })
				.catch(() => toast('Could not paste the image'));
		},
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

	/** Build the Kane tile if the dock is open and the desktop has a Kane to mirror. Safe to call
	 *  repeatedly: it is also driven from applyState, so a Kane that appears AFTER the dock was
	 *  opened (or is rebuilt after a workspace switch) fills the dock on its own instead of
	 *  leaving it blank until the user toggles twice. */
	function ensureKane(): void {
		if (!kaneOpen || kane || !state?.kane) return;
		kane = new WebTile(tileDeps('kane'));
		kane.render(dock, { name: state.kane.name, repo: 'overseer', branch: '', isKane: true });
		kane.setSize(state.kane.cols, state.kane.rows);
		kane.setPalette(activeTerminalPalette());
		// Kane is a console the user READS: fill the dock at a readable font and reshape his PTY
		// to it, instead of shrinking 100+ desktop columns into an unreadable strip at the top.
		kane.setFill(true);
		void kane.attach().catch(() => toast('Kane failed to load'));
	}

	function toggleKane(): void {
		kaneOpen = !kaneOpen;
		dock.style.display = kaneOpen ? '' : 'none';
		kaneBtn.toggleClass('cos-god-on', kaneOpen);
		// No Kane on the desktop yet: ask for one (the desk's own Alt+K creates him). He arrives
		// on the next floor:state and ensureKane() fills the dock.
		if (kaneOpen && !state?.kane) void bridge.invoke('kane:open').catch(() => toast('Could not open Kane'));
		ensureKane();
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

	let reloading = false;
	function applyState(next: FloorState): void {
		// The server is running a newer build than this page: reload once to fetch it. This is the
		// safety net for a tab left open across an update — it auto-reconnects its WebSocket but
		// never reloads on its own, so without this it runs stale JS against a new server (which is
		// exactly how a shipped browser fix appeared to do nothing). Cache-Control:no-cache on the
		// gateway makes the reload fetch fresh code, not the cached copy.
		if (!reloading && next.buildId && next.buildId !== __WCC_BUILD__) {
			// Reload at most once per distinct server build. If a reload didn't pick up the new
			// bundle (a proxy still serving stale JS), running stale-but-working beats an infinite
			// reload loop — so remember which server build we already reloaded for.
			let already: string | null = null;
			try { already = sessionStorage.getItem('wcc.reloadedFor'); } catch { /* storage blocked */ }
			if (already !== next.buildId) {
				reloading = true;
				try { sessionStorage.setItem('wcc.reloadedFor', next.buildId); } catch { /* storage blocked */ }
				try { location.reload(); } catch { /* reload blocked — fall through and run as-is */ reloading = false; }
				if (reloading) return;
			}
		}
		const prevWs = state?.workspaceId;
		const prevCenteredId = state?.centeredId ?? null;
		state = next;
		// A workspace switch replaces every session, so the old tiles AND the old Kane go. Kane is
		// rebuilt below by ensureKane() if the new workspace has one; the dock stays open either
		// way so the toggle state survives the switch.
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
		// Stage tiles are ALWAYS previews (desktop-owned size, font shrinks to fit). Only Kane
		// runs in fill mode: his dock is stable, so his shape changes only when the user drags
		// the grip. The spotlight tile briefly ran in fill mode too (2026-09-13..15) and it was
		// a disaster: FIFO auto-centering moves the spotlight constantly, so every bubble fired
		// a browser-shape resize + a desk-shape refit — two full ConPTY repaints per move, on a
		// 26-session floor. The floor turned into a glitching, lagging repaint storm, historical
		// output stayed wrapped at whatever width it was printed under, and the constant repaints
		// made every tile look busy so the ready-queue never rotated (FIFO "stopped"). Never
		// auto-reshape a PTY whose spotlight the desk moves on its own.
		// A Kane created on the desk after the dock was opened — or rebuilt after a workspace
		// switch disposed the old one — has no other path into the dock.
		ensureKane();
		// Never disable the button while the dock is OPEN: that used to strand an empty 420px dock
		// with no way to close it on any workspace whose grid has no Kane.
		kaneBtn.disabled = !next.kane && !kaneOpen;
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
	//
	// The callback re-fits fonts, which resizes content INSIDE the observed boxes — so it can feed
	// itself. web.css kills the known loop (see `scrollbar-gutter`), and this guard is the backstop:
	// a layout only runs when an observed box's integer size actually changed, so any future
	// self-feeding style change degrades into one wasted frame instead of a frozen tab.
	const lastSize = new WeakMap<Element, string>();
	const ro = new ResizeObserver((entries) => {
		let changed = false;
		for (const e of entries) {
			const size = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
			if (lastSize.get(e.target) !== size) { lastSize.set(e.target, size); changed = true; }
		}
		if (changed) layout();
	});
	ro.observe(stage); ro.observe(dock);

	/** Every keyboard action is a request to the DESKTOP — it owns the floor, and its reply comes
	 *  back as a floor:state event. A silent rejection reads as "the keybind is broken", so say so. */
	const act = (channel: string, payload?: unknown): void => {
		void bridge.invoke(channel, payload).catch(() => toast(`${channel} failed`));
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Alt') { altDown = true; layout(); return; }
		if (!e.altKey || !state) return;
		const visible = state.terminals.filter((t) => !t.hidden).map((t) => t.id);
		// Alt+←/→ asks the DESKTOP to step its own spotlight rather than computing a target here.
		// Computing it here was broken: nextSpotlight's ring includes a `null` stop (the equal-grid,
		// no-spotlight position) which this dropped on the floor, so at either end of the ring the
		// key became a permanent no-op. The desk's ring also includes tiles the browser never sees
		// (the chat tile) and it applies the right spotlight-hold for a cycle vs a click.
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); act('tile:cycle', { dir: e.key === 'ArrowRight' ? 1 : -1 }); return; }
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); const ws = state.workspaces; if (ws.length < 2) return; const i = Math.max(0, ws.findIndex((w) => w.active)); const n = ws[(i + (e.key === 'ArrowDown' ? 1 : -1) + ws.length) % ws.length]!; act('workspace:switch', { id: n.id }); return; }
		if (e.key === 'k' || e.key === 'K') { e.preventDefault(); e.stopPropagation(); if (!kaneOpen) toggleKane(); else kane?.focus(); return; }
		if (e.key === 'l' || e.key === 'L') { e.preventDefault(); e.stopPropagation(); if (state.centeredId !== null) act('tile:lock', { id: state.centeredId }); return; }
		const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
		const idx = keyToIndex(norm);
		if (idx !== null && visible[idx] !== undefined) { e.preventDefault(); e.stopPropagation(); act('tile:center', { id: visible[idx] }); }
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
