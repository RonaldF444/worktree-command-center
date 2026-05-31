import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { listBranches, createWorktree, writeReadyHook, defaultBranch, parkWorktree, reopenWorktree, type WorktreeInfo } from './worktree-manager';
import { nextWorktreeBranch, parseWorktreeList, parseStatusPorcelain, parseAheadBehind, isParkCommitSubject, formatRegistryMarkdown, type WorktreeEntry } from './worktree-registry';
import { runCommand } from '../command-runner';
import { TerminalTile } from './terminal-tile';
import { BoardView } from './board-view';
import { ChatRoom } from './chat-room';
import { ChatTile } from './chat-tile';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex } from './bubble-layout';
import { emptyState, applyKeystroke, onReady as rqReady, onSubmit as rqSubmit, onClose as rqClose, onClick as rqClick, cycleNext as rqCycleNext, cyclePrev as rqCyclePrev } from './ready-queue';

export interface RepoConfig { name: string; path: string; remote?: string; group?: string; }

export interface GridDeps {
	repos: RepoConfig[];
	coordDir: string;
	sidecarPath: string;
	notifyScriptPath: string;
	coordHookPath: string;
	sessionsFile: string;
	group: string;
	bypassPermissions: boolean;
	toast: (msg: string) => void;
	promptForTopic: (title: string, placeholder: string, initial?: string, okLabel?: string) => Promise<string | null>;
}
interface SessionRecord { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name?: string; }

/** Controls bar + a bubbling stage of embedded claude terminals, scoped to one repo group. */
export class TerminalsGrid {
	private repos: RepoConfig[] = [];
	private repoSel: HTMLSelectElement | null = null;
	private branchSel: HTMLSelectElement | null = null;
	private stageEl: HTMLElement | null = null;
	private maxBtn: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	private board: BoardView | null = null;
	private tiles: TerminalTile[] = [];
	private nextTileId = 1;
	private pendingNewBranch: string | null = null;
	private lastEntries: WorktreeEntry[] = [];
	private centeredId: number | null = null;
	private maximized = false;
	private locked = false;
	private selecting = false;
	private selectBtn: HTMLButtonElement | null = null;
	private chatBtn: HTMLButtonElement | null = null;
	private chatTile: ChatTile | null = null;
	private chatRoom: ChatRoom | null = null;
	private parentEl: HTMLElement | null = null;
	private readonly sidecarPath: string;
	private readonly notifyScriptPath: string;
	private readonly sessionsFile: string;
	private readonly coordDir: string;
	private readonly coordHookPath: string;
	private q = emptyState();
	private keydown: ((e: KeyboardEvent) => void) | null = null;
	private keyup: ((e: KeyboardEvent) => void) | null = null;
	private onWinFocus: (() => void) | null = null;
	private onWinBlur: (() => void) | null = null;
	private scanTimer: number | null = null;
	private coordWatcher: import('fs').FSWatcher | null = null;
	private scanDebounce: number | null = null;

	constructor(private deps: GridDeps) {
		this.sidecarPath = deps.sidecarPath;
		this.notifyScriptPath = deps.notifyScriptPath;
		this.sessionsFile = deps.sessionsFile;
		this.coordDir = deps.coordDir;
		this.coordHookPath = deps.coordHookPath;
	}

	/** Mount the grid into a page container. Sessions PERSIST across mounts (tab switches):
	 *  the stage + tiles + sidecar processes are created once and re-attached, never killed. */
	async mount(parent: HTMLElement): Promise<void> {
		await this.loadRepos();
		const controls = parent.createDiv({ cls: 'cos-terminals-controls' });
		this.controlsEl = controls;
		this.parentEl = parent;

		this.repoSel = controls.createEl('select');
		for (const r of this.repos) this.repoSel.createEl('option', { text: r.name, value: r.name });
		this.repoSel.addEventListener('change', () => void this.refreshBranches());

		this.branchSel = controls.createEl('select');

		const newBranchBtn = controls.createEl('button', { text: '+ New branch' });
		newBranchBtn.addEventListener('click', () => {
			void this.deps.promptForTopic('New branch', 'branch name (based on the selected branch)', '', 'Create').then((name) => {
				if (name && name.trim()) { this.pendingNewBranch = name.trim(); this.deps.toast(`Next Play creates branch "${name.trim()}"`); }
			});
		});

		const play = controls.createEl('button', { text: '▶ Play', cls: 'cos-play-btn' });
		play.addEventListener('click', () => void this.play());

		const lockBtn = controls.createEl('button', { text: this.locked ? '🔒 Locked' : '🔓 Lock', cls: 'cos-lock-btn' });
		lockBtn.toggleClass('cos-lock-on', this.locked);
		lockBtn.setAttribute('title', 'When locked, terminals never auto-center — only your click or Alt+F-key centers one');
		lockBtn.addEventListener('click', () => {
			this.locked = !this.locked;
			lockBtn.setText(this.locked ? '🔒 Locked' : '🔓 Lock');
			lockBtn.toggleClass('cos-lock-on', this.locked);
		});

		this.selectBtn = controls.createEl('button', { text: '⊕ Select' });
		this.selectBtn.addEventListener('click', () => this.setSelecting(!this.selecting));

		this.chatBtn = controls.createEl('button', { text: '💬 Chat', cls: 'cos-chat-btn' });
		this.chatBtn.disabled = true;
		this.chatBtn.addEventListener('click', () => this.openChat());

		const viewCode = controls.createEl('button', { text: '🧩 View Code' });
		viewCode.addEventListener('click', () => this.openInVSCode());

		this.maxBtn = controls.createEl('button', { text: this.maximized ? '⛶ Restore' : '⛶ Maximize', cls: 'cos-maximize-btn' });
		this.maxBtn.addEventListener('click', () => this.setMaximized(!this.maximized));

		const refreshBtn = controls.createEl('button', { text: '⟳ Refresh' });
		refreshBtn.addEventListener('click', () => { void this.scanWorktrees().then(() => this.board?.refresh()); });

		if (!this.board) this.board = new BoardView(this.coordDir, (branch) => void this.reopenAndOpen(branch));
		this.board.mount(parent);

		void this.scanWorktrees();
		this.scanTimer = window.setInterval(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, 30_000);
		try {
			this.coordWatcher = (await import('fs')).watch(this.coordDir, (_evt, filename) => {
				if (filename === 'worktrees.md') return; // our own ledger write — don't rescan-loop
				if (this.scanDebounce !== null) window.clearTimeout(this.scanDebounce);
				this.scanDebounce = window.setTimeout(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, 500);
			});
		} catch { /* coordDir may not exist yet; the timer still covers it */ }

		if (!this.stageEl) {
			// First mount: create the stage + restore button, restore any persisted sessions.
			this.stageEl = parent.createDiv({ cls: 'cos-terminals-stage' });
			// Keep Escape inside the terminal: xterm (the focused target) gets it first and
			// forwards it to Claude; stopping it here prevents it bubbling to Obsidian.
			this.stageEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
			const restoreBtn = this.stageEl.createEl('button', { text: '⤡ Minimize', cls: 'cos-stage-restore' });
			restoreBtn.addEventListener('click', () => this.setMaximized(false));
			await this.refreshBranches();
			await this.restoreSessions();
		} else {
			// Re-mount (tab switch back): re-attach the live stage — sessions kept running.
			this.stageEl.toggleClass('cos-terminals-max', this.maximized);
			parent.appendChild(this.stageEl);
			await this.refreshBranches();
			this.applyLayout();
			this.focusCentered(); // returning to the tab puts the cursor back in the centered terminal
		}

		this.applyMaximizeChrome();
		this.installKeyboard();
		window.addEventListener('resize', this.onResize);
	}

	/** Tab switch away: detach the stage + drop listeners, but KEEP sessions running. */
	unmount(): void {
		if (this.keydown) document.removeEventListener('keydown', this.keydown, true);
		if (this.keyup) document.removeEventListener('keyup', this.keyup, true);
		if (this.onWinFocus) window.removeEventListener('focus', this.onWinFocus);
		if (this.onWinBlur) window.removeEventListener('blur', this.onWinBlur);
		window.removeEventListener('resize', this.onResize);
		if (this.scanTimer !== null) { window.clearInterval(this.scanTimer); this.scanTimer = null; }
		if (this.scanDebounce !== null) { window.clearTimeout(this.scanDebounce); this.scanDebounce = null; }
		this.coordWatcher?.close(); this.coordWatcher = null;
		this.chatTile?.unmount();
		this.chatTile = null;
		this.chatRoom = null;
		this.board?.unmount();
		this.stageEl?.remove(); // detached but retained in memory (tiles + sidecars stay alive)
	}

	private onResize = (): void => this.applyLayout();

	private installKeyboard(): void {
		this.keydown = (e: KeyboardEvent) => {
			if (e.key === 'Alt') { this.stageEl?.toggleClass('alt-on', true); this.refreshBadges(); return; }
			// NOTE: Escape is deliberately NOT handled here — it must reach the focused
			// terminal so Claude gets it (double-Esc clears the message). Use the Minimize /
			// Restore buttons to leave fullscreen.
			if (!e.altKey) return;
			if (e.key === 'ArrowRight') { e.preventDefault(); const r = rqCycleNext(this.q); this.q = r.state; if (r.center !== null) this.doCenter(r.center); return; }
			if (e.key === 'ArrowLeft') { e.preventDefault(); const r = rqCyclePrev(this.q); this.q = r.state; if (r.center !== null) this.doCenter(r.center); return; }
			const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
			const idx = keyToIndex(norm);
			if (idx !== null && this.tiles[idx]) { e.preventDefault(); this.handleClick(this.tiles[idx]!.tileId); }
		};
		this.keyup = (e: KeyboardEvent) => { if (e.key === 'Alt') { this.stageEl?.toggleClass('alt-on', false); this.tiles.forEach((t) => t.setBadge(null)); } };
		document.addEventListener('keydown', this.keydown, true);
		document.addEventListener('keyup', this.keyup, true);
		// When the OS window regains focus (alt-tab back in), put the cursor back into the
		// centered terminal — Electron otherwise restores it to whatever tile had it before.
		this.onWinFocus = () => this.focusCentered();
		window.addEventListener('focus', this.onWinFocus);
		// Leaving Obsidian entirely (alt-tab to another app) also releases the typing-hold,
		// so terminals keep bubbling while you're working elsewhere.
		this.onWinBlur = () => { this.q.composingLen = 0; };
		window.addEventListener('blur', this.onWinBlur);
	}

	private refreshBadges(): void {
		this.tiles.forEach((t, i) => t.setBadge(keyForIndex(i)));
	}

	private async loadRepos(): Promise<void> {
		this.repos = this.deps.repos;
	}

	private selectedRepo(): RepoConfig | undefined {
		return this.repos.find((r) => r.name === this.repoSel?.value);
	}

	private async refreshBranches(): Promise<void> {
		if (!this.branchSel) return;
		this.branchSel.empty();
		const repo = this.selectedRepo();
		if (!repo) return;
		const branches = await listBranches(repo.path);
		for (const b of branches) this.branchSel.createEl('option', { text: b, value: b });
		const def = defaultBranch(branches); // default to main / master, not git's first-listed
		if (def) this.branchSel.value = def;
	}

	private async play(): Promise<void> {
		const repo = this.selectedRepo();
		const base = this.branchSel?.value;
		if (!repo || !base) { this.deps.toast('Pick a repo and branch first'); return; }
		const branches = await listBranches(repo.path);
		const branch = this.pendingNewBranch ?? nextWorktreeBranch(branches, base);
		this.pendingNewBranch = null;
		try {
			const worktree = await createWorktree(repo.path, repo.name, base, branch, this.notifyScriptPath, this.coordHookPath);
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false);
			if (this.stageEl) tile.render(this.stageEl);
			this.tiles.push(tile);
			void this.persist();
			this.applyLayout();
		} catch (e) {
			this.deps.toast(`Worktree failed: ${(e as Error).message}`);
		}
	}

	/** Open the repo selected in the dropdown in a VS Code window. */
	private openInVSCode(): void {
		const repo = this.selectedRepo();
		if (!repo) { this.deps.toast('Pick a repo first'); return; }
		try {
			spawn('code', [repo.path], { shell: true, windowsHide: true });
			this.deps.toast(`Opening ${repo.name} in VS Code…`);
		} catch (e) {
			this.deps.toast(`View Code failed: ${(e as Error).message}`);
		}
	}

	/** Manual click / Alt-key: in select mode toggle room membership; otherwise center. */
	private handleClick(id: number): void {
		if (this.selecting) {
			const tile = this.tiles.find((t) => t.tileId === id);
			if (tile) { tile.setSelected(!tile.isSelected); this.updateChatBtn(); }
			return;
		}
		const r = rqClick(this.q, id);
		this.q = r.state;
		this.q.composingLen = 0;
		this.doCenter(r.center);
	}

	private updateChatBtn(): void {
		const n = this.tiles.filter((t) => t.isSelected).length;
		if (this.chatBtn) this.chatBtn.disabled = n < 2;
	}

	/** Toggle select mode + reflect it on the button label ("⊕ Selecting…"). */
	private setSelecting(on: boolean): void {
		this.selecting = on;
		this.selectBtn?.setText(on ? '⊕ Selecting…' : '⊕ Select');
		this.selectBtn?.toggleClass('cos-select-on', on);
		if (!on) this.tiles.forEach((t) => t.setSelected(false));
		this.updateChatBtn();
	}

	/** Open a chat tile in the stage over the selected terminals. */
	private openChat(): void {
		const selected = this.tiles.filter((t) => t.isSelected);
		if (selected.length < 2) { this.deps.toast('Select at least 2 terminals first'); return; }
		const members = selected.map((t) => ({
			name: t.name,
			sendLine: (s: string) => t.sendLine(s),
			sendKeys: (s: string) => t.sendKeys(s),
			isAlive: () => this.tiles.includes(t),
			recentOutput: () => t.recentOutput(),
		}));
		this.chatTile?.unmount();
		// Bypass-permission groups never see a real Claude approval prompt, so
		// don't surface input-request cards there — they'd all be phantoms from conversation.
		const room = new ChatRoom(this.coordDir, members, !this.deps.bypassPermissions);
		this.chatRoom = room;
		const id = this.nextTileId++;
		this.chatTile = new ChatTile(id, room, () => this.closeChat(), () => this.centerChat());
		if (this.stageEl) this.chatTile.render(this.stageEl);
		this.centeredId = id; // open centered, but it's now a normal movable tile (click any tile to move focus)
		this.setSelecting(false);
		this.applyLayout();
		this.chatTile.focus();
	}

	/** Center the chat tile (clicking it, like clicking a terminal, brings it to the middle). */
	private centerChat(): void {
		if (!this.chatTile) return;
		this.centeredId = this.chatTile.tileId;
		this.applyLayout();
		this.chatTile.focus();
	}

	private closeChat(): void {
		this.chatTile?.unmount();
		this.chatTile = null;
		this.chatRoom = null;
		this.applyLayout();
	}

	/** Center a tile AND give its terminal keyboard focus (so typing goes there). */
	private doCenter(id: number): void {
		this.centeredId = id;
		this.applyLayout();
		this.focusCentered();
	}

	/** Focus the centered tile and blur every other one, so a stray keystroke can never
	 *  land on a stale terminal (the root cause of "I typed but the previous one got it"). */
	private focusCentered(): void {
		if (this.centeredId === null) return;
		if (this.chatTile && this.chatTile.tileId === this.centeredId) {
			for (const t of this.tiles) t.blur();
			this.chatTile.focus();
			return;
		}
		const tile = this.tiles.find((t) => t.tileId === this.centeredId);
		if (!tile) return;
		for (const t of this.tiles) if (t.tileId !== this.centeredId) t.blur();
		tile.focus();
	}

	private applyLayout(): void {
		if (!this.stageEl || (this.tiles.length === 0 && !this.chatTile)) return;
		const W = this.stageEl.clientWidth || 800;
		const H = this.stageEl.clientHeight || 500;
		const chatId = this.chatTile?.tileId;
		const ids = [...this.tiles.map((t) => t.tileId), ...(chatId !== undefined ? [chatId] : [])];
		// The chat tile is a normal movable participant — centered only when it IS centeredId.
		const centerId = this.centeredId !== null && ids.includes(this.centeredId) ? this.centeredId : null;
		const rects = centerId !== null ? centeredLayout(ids, W, H, 8, centerId) : settledLayout(ids, W, H, 8);
		for (const t of this.tiles) {
			const r = rects.find((x) => x.id === t.tileId);
			if (r) t.setRect(r);
			t.setCentered(t.tileId === centerId);
		}
		if (this.chatTile && chatId !== undefined) {
			const r = rects.find((x) => x.id === chatId);
			if (r) this.chatTile.setRect(r);
			this.chatTile.setCentered(chatId === centerId);
		}
		if (this.stageEl.classList.contains('alt-on')) this.refreshBadges();
	}

	private setMaximized(on: boolean): void {
		this.maximized = on;
		this.stageEl?.toggleClass('cos-terminals-max', on);
		this.maxBtn?.setText(on ? '⛶ Restore' : '⛶ Maximize');
		window.setTimeout(() => { this.applyMaximizeChrome(); this.applyLayout(); }, 40);
	}

	/** Keep the controls bar (dropdown, Play, View Code, …) visible above the fullscreen
	 *  stage when maximized, and push the stage down by the bar's height so they don't overlap. */
	private applyMaximizeChrome(): void {
		this.controlsEl?.toggleClass('cos-controls-max', this.maximized);
		if (this.stageEl) this.stageEl.style.top = this.maximized && this.controlsEl ? `${this.controlsEl.offsetHeight}px` : '';
	}

	private handleReady(t: TerminalTile): void {
		if (this.chatRoom) { this.chatRoom.noteIdle(t.name); return; } // chat owns idle while open
		const r = rqReady(this.q, t.tileId);
		this.q = r.state;
		if (!this.locked && r.center !== null) this.doCenter(r.center);
	}

	private handleSubmit(t: TerminalTile): void {
		const r = rqSubmit(this.q, t.tileId);
		this.q = r.state;
		// Locked: submitting doesn't pull the next terminal to center — centering stays manual.
		if (!this.locked && r.center !== null) this.doCenter(r.center);
	}

	/** Build a tile with all the grid callbacks wired. `resume` → claude --continue. */
	private makeTile(worktree: WorktreeInfo, repoName: string, repoPath: string, baseBranch: string, resume: boolean, name?: string): TerminalTile {
		return new TerminalTile({
			tileId: this.nextTileId++,
			repoName, repoPath, baseBranch, worktree,
			sidecarPath: this.sidecarPath,
			coordDir: this.coordDir,
			resume,
			bypassPermissions: this.deps.bypassPermissions,
			name,
			onRename: () => { void this.persist(); },
			onRequestRename: (t, cur) => {
				void this.deps.promptForTopic('Rename terminal', 'New name', cur, 'Rename').then((name) => { if (name && name.trim()) t.setName(name.trim()); });
			},
			onClosed: (t) => { const wasCentered = this.centeredId === t.tileId; const r = rqClose(this.q, t.tileId, wasCentered); this.q = r.state; this.tiles = this.tiles.filter((x) => x !== t); void this.persist(); if (r.center !== null) this.doCenter(r.center); else { if (wasCentered) this.centeredId = null; this.applyLayout(); } },
			onCenter: (t) => this.handleClick(t.tileId),
			onReady: (t) => this.handleReady(t),
			onInput: (t, data) => { this.q.composingLen = applyKeystroke(this.q.composingLen, data); },
			onEnter: (t) => this.handleSubmit(t),
			// Reset the typing-hold on ANY focus change: gaining focus starts a fresh box,
			// and leaving a terminal means you're no longer typing — so finished terminals
			// should resume shifting instead of being held forever.
			onFocusChange: () => { this.q.composingLen = 0; },
		});
	}

	private async readAllSessions(): Promise<Record<string, SessionRecord[]>> {
		try { return JSON.parse(await fs.readFile(this.sessionsFile, 'utf8')) as Record<string, SessionRecord[]>; } catch { return {}; }
	}

	/** Persist THIS group's currently-open sessions (called on play + on close). */
	private async persist(): Promise<void> {
		const all = await this.readAllSessions();
		all[this.deps.group] = this.tiles.map((t) => t.sessionRecord());
		try { await fs.writeFile(this.sessionsFile, JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
	}

	/** On open: re-create a tile (claude --continue) for each persisted worktree that still exists. */
	private async restoreSessions(): Promise<void> {
		const all = await this.readAllSessions();
		const recs = all[this.deps.group] ?? [];
		for (const rec of recs) {
			let exists = false;
			try { await fs.access(rec.worktreePath); exists = true; } catch { exists = false; }
			if (!exists) continue;
			const tile = this.makeTile({ worktreePath: rec.worktreePath, branch: rec.branch }, rec.repoName, rec.repoPath, rec.baseBranch, true, rec.name);
			try { await writeReadyHook(rec.worktreePath, this.notifyScriptPath, this.coordHookPath); } catch { /* best effort */ }
			if (this.stageEl) tile.render(this.stageEl);
			this.tiles.push(tile);
		}
		await this.persist(); // prune records whose worktree no longer exists
		this.applyLayout();
	}

	/** Full teardown (view close): unmount + kill all sessions. */
	dispose(): void {
		this.unmount();
		this.board = null;
		for (const t of this.tiles) t.kill();
		this.tiles = [];
		this.stageEl = null;
	}

	/** Park every dirty worktree of every live tile (plugin unload: accidental teardown / reload).
	 *  Called from the plugin's onunload — NOT from unmount(), which is a tab-switch that keeps
	 *  sessions + their live agents running. */
	public async parkAll(): Promise<void> {
		const iso = new Date().toISOString();
		for (const t of this.tiles) {
			try {
				const action = await parkWorktree(t.worktreePath, iso);
				if (action === 'parked') {
					await fs.appendFile(path.join(this.coordDir, 'board.md'),
						`${Date.now()}\t${t.name}\t-\tNOTE\tauto-parked on teardown\n`, 'utf8').catch(() => {});
				}
			} catch { /* never block teardown */ }
		}
	}

	private registryPath(): string { return path.join(this.coordDir, 'worktrees.md'); }

	/** Scan every added repo's worktrees, map ownership from live tiles, write worktrees.md.
	 *  Best-effort: any git failure degrades that entry and never throws. */
	private async scanWorktrees(): Promise<void> {
		const entries: WorktreeEntry[] = [];
		const now = Date.now();
		for (const repo of this.repos) {
			const wl = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repo.path, timeoutMs: 8000 });
			if (wl.code !== 0) continue;
			for (const wt of parseWorktreeList(wl.stdout)) {
				if (path.resolve(wt.path) === path.resolve(repo.path)) continue; // skip the primary checkout
				const status = await runCommand('git', ['status', '--porcelain'], { cwd: wt.path, timeoutMs: 8000 });
				const tile = this.tiles.find((t) => path.resolve(t.worktreePath) === path.resolve(wt.path));
				const baseRef = tile ? tile.baseBranch : this.baseOf(wt.branch);
				const ab = await runCommand('git', ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], { cwd: wt.path, timeoutMs: 8000 });
				const subj = await runCommand('git', ['log', '-1', '--pretty=%s'], { cwd: wt.path, timeoutMs: 8000 });
				const counts = parseAheadBehind(ab.code === 0 ? ab.stdout : '');
				entries.push({
					repo: repo.name, branch: wt.branch, path: wt.path,
					terminal: tile ? tile.name : null,
					dirtyFiles: status.code === 0 ? parseStatusPorcelain(status.stdout) : [],
					ahead: counts.ahead, behind: counts.behind,
					parked: subj.code === 0 ? isParkCommitSubject(subj.stdout.trim()) : false,
					lastActivity: now,
				});
			}
		}
		this.lastEntries = entries; // persisted so Reopen (Task 11) can resolve repo+path by branch
		try {
			await fs.mkdir(this.coordDir, { recursive: true });
			await fs.writeFile(this.registryPath(), formatRegistryMarkdown(entries, now), 'utf8');
		} catch { /* best effort */ }
	}

	/** The base branch a wt/<base>-N was cut from, for ahead/behind. Falls back to 'HEAD~0'
	 *  semantics by comparing against the repo's default branch name embedded in the slug. */
	private baseOf(branch: string): string {
		const m = branch.match(/^wt\/(.+)-\d+$/);
		return m ? m[1]! : branch;
	}

	/** Un-park a parked worktree (soft-reset / recreate folder) and attach a new tile for it. */
	private async reopenAndOpen(branch: string): Promise<void> {
		const entry = this.lastEntries.find((e) => e.branch === branch);
		if (!entry) { this.deps.toast(`No scanned worktree for ${branch} — hit Refresh`); return; }
		const repo = this.repos.find((r) => r.name === entry.repo);
		if (!repo) return;
		// Skip if a tile is already attached to this worktree.
		if (this.tiles.some((t) => path.resolve(t.worktreePath) === path.resolve(entry.path))) return;
		await reopenWorktree(repo.path, entry.path, branch);
		try { await writeReadyHook(entry.path, this.notifyScriptPath, this.coordHookPath); } catch { /* best effort */ }
		const tile = this.makeTile({ worktreePath: entry.path, branch }, repo.name, repo.path, this.baseOf(branch), false);
		if (this.stageEl) tile.render(this.stageEl);
		this.tiles.push(tile);
		this.centeredId = tile.tileId;
		this.applyLayout();
		void this.scanWorktrees().then(() => this.board?.refresh());
	}
}
