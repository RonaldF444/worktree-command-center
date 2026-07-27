import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic, promptForConfirm } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
import { parseLinearConvertConfig } from './terminals/linear-convert-probe';
import { parseGodSelfImprove } from './terminals/god';
import { discoverRepos, mergeRepos } from './workspace';
import { UsageProbe } from './terminals/usage-probe';
import { UsageWidget } from './ui/usage-widget';
import { PerfMonitor } from './ui/perf-monitor';
import { AttentionWidget } from './ui/attention-widget';
import { WorkspaceBar } from './ui/workspace-bar';
import { normalizeWorkspaces, addWorkspace, closeWorkspace, nextActiveAfter, type Workspace } from './terminals/workspace-store';
import { THEMES, normalizeTheme, setActiveTheme, activeTerminalPalette } from './terminals/theme-store';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { registerPrivateFeatures } from 'wcc-private';
import type { SessionEnvProvider } from './private-api';

declare global {
	interface Window {
		wcc: {
			paths(): Promise<{ sidecarDir: string; userData: string }>;
			clipboardRead(): Promise<string>;
			clipboardWrite(text: string): Promise<boolean>;
			getConfig(): Promise<any>;
			setConfig(c: any): Promise<boolean>;
			addFolder(): Promise<string | null>;
			pushFloorState(s: unknown): void;
			onRemoteAction(cb: (a: { type: string; id?: number; repo?: string; base?: string | null; task?: string }) => void): void;
			remoteInfo(): Promise<{ token: string; port: number; urls: string[] }>;
			onShellDigit(cb: (n: number) => void): void;
		};
	}
}

let repos: RepoConfig[] = [];

async function main(): Promise<void> {
	try {
		installDomShim();

		const { sidecarDir, userData } = await window.wcc.paths();
		const cfg = await window.wcc.getConfig();

		// Renderer-aging telemetry (perf-log.jsonl in userData) — long-lived instances degrade;
		// this gives the next investigation data instead of guesses.
		const perfMon = new PerfMonitor(path.join(userData, 'perf-log.jsonl'));
		perfMon.begin();
		window.addEventListener('beforeunload', () => perfMon.dispose());
		repos = Array.isArray(cfg.repos) ? cfg.repos : [];

		// Shell theme (2026-07-24 themes spec): applied before any UI builds so the first
		// paint is already themed. 'default' = the :root palette, no attribute needed either
		// way but setting it keeps the switcher and DOM state in lockstep.
		let themeId = normalizeTheme(cfg.theme);
		document.documentElement.dataset.theme = themeId;
		setActiveTheme(themeId); // terminals created from here on take the theme's well palette

		const appEl = document.getElementById('app')!;

		// --- shell slots: generic mount points for the private overlay's portal surfaces
		// (PrivateApi.shellHosts) — `stripHost` above the whole terminal UI, `viewsHost`
		// beneath it. The terminal surface lives in terminalRoot as one swappable unit;
		// both slot divs stay empty unless an overlay populates them. ---
		const stripHost = appEl.createDiv();
		const terminalRoot = appEl.createDiv({ cls: 'wcc-terminal-root' });
		const viewsHost = appEl.createDiv();

		// --- top bar (persistent above the tabs + grid; never wiped by grid.mount()) ---
		const topBar = terminalRoot.createDiv({ cls: 'wcc-topbar' });
		topBar.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center' });
		const addFolderBtn = topBar.createEl('button', { cls: 'wcc-add', text: '➕ Add folder' });
		const statusSpan = topBar.createSpan({ cls: 'wcc-status', text: `${repos.length} repos` });

		// Theme switcher: applies instantly, persists via the merge below.
		const themeSel = topBar.createEl('select', { cls: 'wcc-theme-sel', attr: { title: 'Shell theme' } });
		for (const t of THEMES) themeSel.createEl('option', { text: t.label, value: t.id });
		themeSel.value = themeId;
		themeSel.addEventListener('change', () => {
			themeId = normalizeTheme(themeSel.value);
			document.documentElement.dataset.theme = themeId;
			setActiveTheme(themeId);
			// Re-tint every live terminal well in every workspace (new ones self-apply).
			const palette = activeTerminalPalette();
			for (const g of grids.values()) g.applyTerminalPalette(palette);
			persist();
		});

		// --- workspaces ---
		let workspaces: Workspace[] = normalizeWorkspaces(cfg.workspaces);
		let activeId = workspaces.some((w) => w.id === cfg.activeWorkspace) ? (cfg.activeWorkspace as string) : workspaces[0]!.id;
		const grids = new Map<string, TerminalsGrid>();

		// Session-env provider (see docs/superpowers/specs/2026-07-13-session-env-provider-design.md).
		// Overlay-replaceable; consulted lazily at each spawn through safeSessionEnv at the call sites.
		let sessionEnvProvider: SessionEnvProvider = () => ({});
		const wsSwitchCbs: Array<(id: string) => void> = [];

		// Usage battery (follows the ACTIVE workspace's session env; restartable by the overlay).
		const usageHost = topBar.createDiv({ cls: 'wcc-usage-host' });
		let usageProbe: UsageProbe | null = null;
		let usageWidget: UsageWidget | null = null;
		const startUsageProbe = (): void => {
			usageWidget?.dispose(); usageProbe?.dispose();
			usageHost.empty();
			// Dedicated cwd: the probe spawns a session per refresh, and those must not litter a
			// real repo's `claude --resume` history (the old repos[0] cwd did exactly that).
			const probeCwd = path.join(userData, 'usage-probe');
			try { fs.mkdirSync(probeCwd, { recursive: true }); } catch { /* best effort */ }
			usageProbe = new UsageProbe({
				sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
				cwd: probeCwd,
				sessionEnv: () => sessionEnvProvider({ workspaceId: activeId }),
			});
			usageWidget = new UsageWidget(usageProbe);
			usageWidget.render(usageHost);
		};
		startUsageProbe();
		window.addEventListener('beforeunload', () => { usageWidget?.dispose(); usageProbe?.dispose(); });

		// Kane self-improvement (see docs/superpowers/specs/2026-07-15-kane-self-improvement-design.md):
		// config names the app's own source repo; toolsDir defaults beside the user's home.
		const siCfg = parseGodSelfImprove(cfg.god);
		const godSelfImprove = siCfg ? { sourceRepo: siCfg.sourceRepo, toolsDir: siCfg.toolsDir ?? path.join(os.homedir(), 'kane-tools') } : undefined;

		const depsFor = (id: string): GridDeps => ({
			repos,
			group: id,
			coordDir: path.join(userData, '.coordination', id),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile: path.join(userData, '.terminal-sessions.json'),
			bypassPermissions: true,
			linearConvert: parseLinearConvertConfig(cfg.linearConvert),
			godSelfImprove,
			sessionEnv: () => sessionEnvProvider({ workspaceId: id }),
			toast,
			promptForTopic,
		});
		const gridFor = (id: string): TerminalsGrid => {
			let g = grids.get(id);
			if (!g) { g = new TerminalsGrid(depsFor(id)); grids.set(id, g); }
			return g;
		};
		let activeGrid = gridFor(activeId);

		// Merge over a FRESH read: other writers (e.g. the private overlay via PrivateApi.config.set)
		// must not have their keys clobbered by this startup-snapshot spread.
		const persist = (): void => void window.wcc.getConfig().then((fresh) => window.wcc.setConfig({ ...fresh, repos, workspaces, activeWorkspace: activeId, theme: themeId }));

		// Attention queue reads whichever grid is ACTIVE (closures over the mutable activeGrid).
		const attention = new AttentionWidget(() => activeGrid.attentionItems(), (tileId) => activeGrid.revealTile(tileId));
		attention.render(topBar);
		window.addEventListener('beforeunload', () => attention.dispose());

		const phoneBtn = topBar.createEl('button', { cls: 'wcc-phone', text: '📱 Phone' });

		// --- workspace tab bar ---
		const bar = new WorkspaceBar({
			list: () => workspaces,
			activeId: () => activeId,
			onSwitch: (id) => void switchTo(id),
			onAdd: () => void onAdd(),
			onClose: (id) => onClose(id),
		});
		bar.render(terminalRoot);

		// Grid container: the active grid mounts its controls + board + stage into here.
		const gridContainer = terminalRoot.createDiv({ cls: 'wcc-grid-container' });

		async function switchTo(id: string): Promise<void> {
			if (id === activeId || !workspaces.some((w) => w.id === id)) return;
			activeGrid.unmount();
			activeId = id;
			activeGrid = gridFor(id);
			await activeGrid.mount(gridContainer);
			bar.refresh();
			persist();
			for (const cb of wsSwitchCbs) { try { cb(id); } catch { /* overlay callback must not break switching */ } }
		}

		// Terminal-surface visibility, controlled by the overlay (PrivateApi.hideTerminal /
		// showTerminal). Hiding rides the workspace-switch machinery: the grid unmounts, so
		// every tile suspends its output parsing while something else owns the window.
		let terminalShown = true;
		const hideTerminal = (): void => {
			if (!terminalShown) return;
			terminalShown = false;
			activeGrid.unmount();
			terminalRoot.style.display = 'none';
		};
		const showTerminal = async (): Promise<void> => {
			if (terminalShown) return;
			terminalShown = true;
			terminalRoot.style.display = '';
			await activeGrid.mount(gridContainer); // resume tiles (the workspace-switch path)
		};

		async function onAdd(): Promise<void> {
			const name = await promptForTopic('New workspace', 'workspace name', '', 'Create');
			if (!name || !name.trim()) return;
			const r = addWorkspace(workspaces, name);
			if (!r) return;
			workspaces = r.list;
			persist();
			bar.refresh();
			await switchTo(r.id);
		}

		function onClose(id: string): void {
			if (workspaces.length <= 1) return;
			const ws = workspaces.find((w) => w.id === id);
			const g = grids.get(id);
			const count = g ? g.terminalCount() : 0;
			if (count > 0 && !window.confirm(`Close workspace "${ws?.name ?? id}"? Its ${count} terminal(s) will be stopped.`)) return;
			const target = nextActiveAfter(workspaces, id, activeId);
			g?.dispose();
			grids.delete(id);
			workspaces = closeWorkspace(workspaces, id);
			if (id === activeId) { void switchTo(target); } else { persist(); bar.refresh(); }
		}

		// Private overlay (see README "Private extensions"): must never take down the app.
		// Runs BEFORE the first mount so a provider set here applies to restored sessions.
		try {
			registerPrivateFeatures({
				topBar,
				shellHosts: { above: stripHost, terminalRoot, below: viewsHost },
				hideTerminal,
				showTerminal,
				terminalVisible: () => terminalShown,
				activeGrid: () => activeGrid,
				config: { get: () => window.wcc.getConfig(), set: (c) => window.wcc.setConfig(c) },
				initialConfig: cfg,
				toast,
				promptForTopic,
				promptForConfirm,
				userData,
				sidecarDir,
				setSessionEnv: (p) => { sessionEnvProvider = p; },
				activeWorkspaceId: () => activeId,
				onWorkspaceSwitch: (cb) => { wsSwitchCbs.push(cb); },
				restartUsageProbe: () => startUsageProbe(),
				workspaceIds: () => workspaces.map((w) => w.id),
				restartSessions: (ids) => { for (const id of ids) grids.get(id)?.restartSessions(); },
			});
		} catch (e) {
			toast('Private features failed to load: ' + e);
		}

		await activeGrid.mount(gridContainer);

		// Alt+↑ / Alt+↓ cycle WORKSPACES (Alt+←/→ cycle terminals within the active workspace).
		// Capture-phase so it beats the terminal; only acts when there's more than one workspace.
		document.addEventListener('keydown', (e) => {
			if (!terminalShown) return; // an overlay surface is up: the terminal UI is hidden
			if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
			if (workspaces.length < 2) return;
			e.preventDefault();
			const i = Math.max(0, workspaces.findIndex((w) => w.id === activeId));
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			void switchTo(workspaces[(i + dir + workspaces.length) % workspaces.length]!.id);
		}, true);

		// Phone floor view: push the active workspace's floor to the main-process server every 2s,
		// and run actions the phone sends back (toggle remote-control / spawn).
		window.setInterval(() => window.wcc.pushFloorState({ terminals: activeGrid.floorState(), repos: activeGrid.repoNames() }), 2000);
		window.wcc.onRemoteAction((a) => {
			if (a.type === 'remote' && typeof a.id === 'number') activeGrid.toggleRemoteById(a.id);
			else if (a.type === 'spawn' && a.repo && a.task) void activeGrid.spawnFromName(a.repo, a.base ?? null, a.task);
		});

		// 📱 Phone button → panel with the Tailscale URLs to open on your phone.
		let phonePanel: HTMLElement | null = null;
		phoneBtn.addEventListener('click', () => {
			if (phonePanel) { phonePanel.remove(); phonePanel = null; return; }
			void window.wcc.remoteInfo().then((info) => {
				phonePanel = appEl.createDiv({ cls: 'wcc-phone-panel' });
				const btnRect = phoneBtn.getBoundingClientRect();
				phonePanel.style.top = `${Math.round(btnRect.bottom + 6)}px`;
				phonePanel.createDiv({ cls: 'wcc-phone-h', text: '📱 Phone floor view' });
				phonePanel.createDiv({ cls: 'wcc-phone-sub', text: 'Open one of these on your phone (same Tailscale network):' });
				for (const u of info.urls) phonePanel.createEl('div', { cls: 'wcc-phone-url', text: u });
				const close = phonePanel.createEl('button', { cls: 'wcc-phone-close', text: 'Close' });
				close.addEventListener('click', () => { phonePanel?.remove(); phonePanel = null; });
			});
		});

		addFolderBtn.addEventListener('click', () => {
			void (async () => {
				const folder = await window.wcc.addFolder();
				if (!folder) return;
				const found = discoverRepos(folder);
				repos = mergeRepos(repos, found);
				grids.forEach((g) => g.setRepos(repos)); // every workspace shares the repo list
				persist();
				statusSpan.textContent = `${repos.length} repos · ${found.length} just added`;
				toast(`Added ${found.length} repo(s)`);
			})();
		});
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
