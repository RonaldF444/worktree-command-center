import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
import { discoverRepos, mergeRepos } from './workspace';
import { UsageProbe } from './terminals/usage-probe';
import { UsageWidget } from './ui/usage-widget';
import { AttentionWidget } from './ui/attention-widget';
import * as path from 'path';

declare global {
	interface Window {
		wcc: {
			paths(): Promise<{ sidecarDir: string; userData: string }>;
			getConfig(): Promise<any>;
			setConfig(c: any): Promise<boolean>;
			addFolder(): Promise<string | null>;
		};
	}
}

let repos: RepoConfig[] = [];

async function main(): Promise<void> {
	try {
		installDomShim();

		const { sidecarDir, userData } = await window.wcc.paths();
		const cfg = await window.wcc.getConfig();
		repos = Array.isArray(cfg.repos) ? cfg.repos : [];

		const deps: GridDeps = {
			repos,
			group: 'default',
			coordDir: path.join(userData, '.coordination', 'default'),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile: path.join(userData, '.terminal-sessions.json'),
			bypassPermissions: true,
			toast,
			promptForTopic,
		};

		const appEl = document.getElementById('app')!;

		// Construct the grid early so topbar widgets can reference it; mounted into the grid
		// container further below.
		const grid = new TerminalsGrid(deps);

		// Top bar (styled via app.css). Sits above the grid and is never wiped by grid.mount().
		const topBar = appEl.createDiv({ cls: 'wcc-topbar' });
		topBar.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center' });
		const addFolderBtn = topBar.createEl('button', { cls: 'wcc-add', text: '➕ Add folder' });
		const statusSpan = topBar.createSpan({ cls: 'wcc-status', text: `${repos.length} repos` });

		// Usage battery (manual ⟳ refresh; scrapes /usage from a hidden, reused claude session).
		const usageProbe = new UsageProbe({
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			cwd: repos[0]?.path ?? userData,
		});
		new UsageWidget(usageProbe).render(topBar);
		window.addEventListener('beforeunload', () => usageProbe.dispose());

		// Attention queue: which terminals need you (prompt / menu / errored / idle).
		const attention = new AttentionWidget(() => grid.attentionItems(), (id) => grid.revealTile(id));
		attention.render(topBar);
		window.addEventListener('beforeunload', () => attention.dispose());

		// Grid container: grid.mount() builds into this div (app.css gives it a column flex so
		// the terminal stage gets real height).
		const gridContainer = appEl.createDiv({ cls: 'wcc-grid-container' });

		await grid.mount(gridContainer);

		addFolderBtn.addEventListener('click', () => {
			void (async () => {
				const folder = await window.wcc.addFolder();
				if (!folder) return;
				const found = discoverRepos(folder);
				repos = mergeRepos(repos, found);
				grid.setRepos(repos);
				await window.wcc.setConfig({ ...cfg, repos });
				statusSpan.textContent = `${repos.length} repos · ${found.length} just added`;
				toast(`Added ${found.length} repo(s)`);
			})();
		});
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
