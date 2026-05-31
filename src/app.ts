import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
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

async function main(): Promise<void> {
	try {
		installDomShim();

		const { sidecarDir, userData } = await window.wcc.paths();
		const cfg = await window.wcc.getConfig();
		const repos: RepoConfig[] = Array.isArray(cfg.repos) ? cfg.repos : [];

		const deps: GridDeps = {
			repos,
			group: 'default',
			coordDir: path.join(userData, '.coordination', 'default'),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile: path.join(userData, '.terminal-sessions.json'),
			bypassPermissions: false,
			toast,
			promptForTopic,
		};

		const grid = new TerminalsGrid(deps);
		await grid.mount(document.getElementById('app')!);
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
