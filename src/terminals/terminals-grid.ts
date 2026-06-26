import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { listBranches, createWorktree, writeReadyHook, defaultBranch, parkWorktree, reopenWorktree, type WorktreeInfo } from './worktree-manager';
import { nextWorktreeBranch, parseWorktreeList, parseStatusPorcelain, parseAheadBehind, isParkCommitSubject, formatRegistryMarkdown, type WorktreeEntry } from './worktree-registry';
import { runCommand } from '../command-runner';
import { TerminalTile } from './terminal-tile';
import { BoardView } from './board-view';
import { promptForConfirm } from '../ui/prompt-dialog';
import { ChatRoom } from './chat-room';
import { ChatTile } from './chat-tile';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex } from './bubble-layout';
import { emptyState, applyKeystroke, onReady as rqReady, onSubmit as rqSubmit, onClose as rqClose, onClick as rqClick, cycleNext as rqCycleNext, cyclePrev as rqCyclePrev } from './ready-queue';
import { decideCenter, type SpotlightState } from './focus-decider';
import { partitionByHidden } from './session-partition';
import { GodConsole } from './god-console';
import { slug as godSlug, formatFloorSnapshot, formatFloorIndex, parseOutboxMessage, resolveTellTarget, type OutboxMessage } from './god';
import { looksLikeMenu, looksErrored } from './prompt-detect';
import { looksLikePrompt } from './chat-room';
import { classifyAttention, type AttentionItem } from './attention';
import { JournalTile } from './journal-tile';
import { JournalStore } from './journal-store';
import type { StageTile } from './stage-tile';

export interface RepoConfig { name: string; path: string; remote?: string; group?: string; }
export interface RemoteTerminal { id: number; name: string; repo: string; branch: string; state: string; output: string; remoteOn: boolean; }

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
interface SessionRecord { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name?: string; hidden?: boolean; kind?: 'terminal' | 'journal'; journalSlug?: string; }

// --- Kane personality mode (toggled by his /personality command) ---
const KANE_PERSONA_ON =
	'[personality: ON] Speak as Kane the forge-master from now on — terse, gruff, dry, in command ' +
	'of the floor; the worker terminals are your smiths and their branches are iron on the anvil. ' +
	'Drop the odd forge/river turn of phrase, never flowery. Keep doing your job exactly as before ' +
	'(same tools, same restraint — you still do not run the floor unprompted), just in that voice. ' +
	'Periodically you will get a line starting "[pulse]" — answer each with ONE punchy sentence on ' +
	'the floor\'s state right now. Confirm now with a single line, in character.';
const KANE_PERSONA_OFF =
	'[personality: OFF] Drop the forge-master voice — back to your plain, neutral overseer tone. ' +
	'The "[pulse]" nudges have stopped; ignore any you still see. Acknowledge in one short line.';
const KANE_PULSE = '[pulse] One line, in character: what\'s the floor doing right now?';

/** Controls bar + a bubbling stage of embedded claude terminals, scoped to one repo group. */
export class TerminalsGrid {
	private repos: RepoConfig[] = [];
	private repoSel: HTMLSelectElement | null = null;
	private branchSel: HTMLSelectElement | null = null;
	private stageEl: HTMLElement | null = null;
	private maxBtn: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	private board: BoardView | null = null;
	private tiles: StageTile[] = [];
	private hidden: StageTile[] = [];
	private journalStore!: JournalStore;
	private journalSeq = 0;
	private nextTileId = 1;
	private pendingNewBranch: string | null = null;
	private lastEntries: WorktreeEntry[] = [];
	private centeredId: number | null = null;
	private maximized = false;
	private locked = false;
	private lockedTileId: number | null = null; // individual lock: this tile is pinned to center until you navigate away
	private searchQuery = '';
	private selecting = false;
	private selectBtn: HTMLButtonElement | null = null;
	private chatBtn: HTMLButtonElement | null = null;
	private chatTile: ChatTile | null = null;
	private chatRoom: ChatRoom | null = null;
	private godBtn: HTMLButtonElement | null = null;
	private godConsole: GodConsole | null = null;
	private godVisible = false;
	private kanePersonality = false;          // off = Kane behaves exactly as today (no persona, no pulses)
	private pulseTimer: number | null = null;
	private readonly pulseMs = 12 * 60 * 1000; // proactive floor-pulse cadence while personality is on
	private watchers: Array<{ target: string; note: string }> = [];
	private pendingTask = new Map<number, string>();
	private idleTiles = new Set<number>();
	private stageWrapEl: HTMLElement | null = null;
	private floorTimer: number | null = null;
	private godOutboxWatcher: import('fs').FSWatcher | null = null;
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
	private stageResizeObs: ResizeObserver | null = null;
	private layoutRaf: number | null = null;

	constructor(private deps: GridDeps) {
		this.sidecarPath = deps.sidecarPath;
		this.notifyScriptPath = deps.notifyScriptPath;
		this.sessionsFile = deps.sessionsFile;
		this.coordDir = deps.coordDir;
		this.coordHookPath = deps.coordHookPath;
		this.journalStore = new JournalStore(path.join(this.coordDir, 'journals'));
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

		// Select + Chat buttons intentionally not rendered — the group-chat feature is hidden,
		// and Select only existed to pick chat members. The code paths (setSelecting / openChat /
		// ChatRoom) remain intact, so uncommenting these two lines brings the chat workflow back.
		// this.selectBtn = controls.createEl('button', { text: '⊕ Select' });
		// this.selectBtn.addEventListener('click', () => this.setSelecting(!this.selecting));

		this.godBtn = controls.createEl('button', { text: '🜲 Kane', cls: 'cos-god-btn' });
		this.godBtn.setAttribute('title', 'Open the Kane overseer console — sees the whole floor, acts on request');
		this.godBtn.addEventListener('click', () => this.toggleGod());

		const viewCode = controls.createEl('button', { text: '🧩 View Code' });
		viewCode.addEventListener('click', () => this.openInVSCode());


		const refreshBtn = controls.createEl('button', { text: '⟳ Refresh' });
		refreshBtn.addEventListener('click', () => { void this.scanWorktrees().then(() => this.board?.refresh()); });

		const journalBtn = controls.createEl('button', { text: '📓 Journal Entry', cls: 'cos-journal-btn', attr: { title: 'Open a new journal entry tile' } });
		journalBtn.addEventListener('click', () => this.spawnJournal());

		if (!this.board) this.board = new BoardView(
			this.coordDir,
			(branch) => void this.reopenAndOpen(branch),
			() => this.hidden.map((t) => ({ tileId: t.tileId, name: t.name, branch: t.branch, repo: t.repoName })),
			(tileId) => this.showTile(tileId),
			(tileId) => void this.closeHiddenTile(tileId),
		);
		this.board.mount(parent);

		void this.scanWorktrees();
		this.scanTimer = window.setInterval(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, 30_000);
		try {
			this.coordWatcher = (await import('fs')).watch(this.coordDir, (_evt, filename) => {
				const fn = String(filename ?? '');
				// Our own ledger write + the GOD feed dirs must never trigger a worktree rescan loop.
				if (fn === 'worktrees.md' || fn.startsWith('floor') || fn.startsWith('god-outbox') || fn.startsWith('god-inbox')) return;
				if (this.scanDebounce !== null) window.clearTimeout(this.scanDebounce);
				this.scanDebounce = window.setTimeout(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, 500);
			});
		} catch { /* coordDir may not exist yet; the timer still covers it */ }

		if (!this.stageEl) {
			// First mount: create the stage (inside a dock row that can hold the GOD panel) +
			// restore button, restore any persisted sessions.
			this.stageWrapEl = parent.createDiv({ cls: 'cos-stage-wrap' });
			this.stageEl = this.stageWrapEl.createDiv({ cls: 'cos-terminals-stage' });
			// Keep Escape inside the terminal: xterm (the focused target) gets it first and
			// forwards it to Claude; stopping it here prevents it bubbling to Obsidian.
			this.stageEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
			// Re-lay-out on ANY stage size change, not just window resize — the Coordination board
			// growing/collapsing resizes the stage with no resize event, which otherwise leaves the
			// bottom row sized for the old (taller) stage and clipped below it.
			this.stageResizeObs = new ResizeObserver(() => this.scheduleLayout());
			this.stageResizeObs.observe(this.stageEl);
			await this.refreshBranches();
			await this.restoreSessions();
		} else {
			// Re-mount (tab switch back): re-attach the live dock row — sessions kept running.
			this.stageEl.toggleClass('cos-terminals-max', this.maximized);
			parent.appendChild(this.stageWrapEl!);
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
		if (this.layoutRaf !== null) { window.cancelAnimationFrame(this.layoutRaf); this.layoutRaf = null; }
		if (this.scanTimer !== null) { window.clearInterval(this.scanTimer); this.scanTimer = null; }
		if (this.scanDebounce !== null) { window.clearTimeout(this.scanDebounce); this.scanDebounce = null; }
		this.coordWatcher?.close(); this.coordWatcher = null;
		this.chatTile?.unmount();
		this.chatTile = null;
		this.chatRoom = null;
		this.stopFloorFeed();
		this.board?.unmount();
		// Drop the controls bar too, so re-mounting this grid (workspace switch) doesn't stack a
		// second one. The stage wrap is detached-but-retained (tiles + sidecars stay alive).
		this.controlsEl?.remove();
		this.controlsEl = null;
		// GOD survives a tab switch (like the tiles): detach with the stage wrap, keep the session.
		this.stageWrapEl?.remove();
	}

	private onResize = (): void => this.scheduleLayout();

	/** Coalesce layout requests into one applyLayout on the next frame. Fired on window resize AND
	 *  by the stage ResizeObserver — the stage shrinks whenever the Coordination board (a flex
	 *  sibling, up to 38vh) populates/expands, which emits no window-resize event. Re-running the
	 *  layout against the stage's CURRENT height keeps the bottom row from overflowing it. */
	private scheduleLayout(): void {
		if (this.layoutRaf !== null) return;
		this.layoutRaf = window.requestAnimationFrame(() => { this.layoutRaf = null; this.applyLayout(); });
	}

	private installKeyboard(): void {
		this.keydown = (e: KeyboardEvent) => {
			if (e.key === 'Alt') { this.stageEl?.toggleClass('alt-on', true); this.refreshBadges(); return; }
			// NOTE: Escape is deliberately NOT handled here — it must reach the focused
			// terminal so Claude gets it (double-Esc clears the message). Use the Minimize /
			// Restore buttons to leave fullscreen.
			if (!e.altKey) return;
			if (e.key === 'ArrowRight') { e.preventDefault(); const r = rqCycleNext(this.q); this.q = r.state; if (r.center !== null) this.doCenter(r.center); return; }
			if (e.key === 'ArrowLeft') { e.preventDefault(); const r = rqCyclePrev(this.q); this.q = r.state; if (r.center !== null) this.doCenter(r.center); return; }
			if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (this.centeredId !== null) this.toggleLockById(this.centeredId); return; }
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

	/** Update the repo list and rebuild the dropdown live; preserves the current selection if
	 *  still present, then refreshes branches for the newly-selected repo. */
	setRepos(repos: RepoConfig[]): void {
		this.repos = repos;
		if (!this.repoSel) return;
		const cur = this.repoSel.value;
		this.repoSel.empty();
		for (const r of this.repos) this.repoSel.createEl('option', { text: r.name, value: r.name });
		if (this.repos.some((r) => r.name === cur)) this.repoSel.value = cur;
		void this.refreshBranches();
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
		await this.spawnWorktree(repo, base, {});
	}

	/** Shared spawn core: create a worktree + tile, render, persist, layout. Optionally queue an
	 *  initial task to send once the new session is first ready. Returns the tile (or null). */
	private async spawnWorktree(repo: RepoConfig, base: string, opts: { task?: string }): Promise<TerminalTile | null> {
		try {
			const branches = await listBranches(repo.path);
			const branch = this.pendingNewBranch ?? nextWorktreeBranch(branches, base);
			this.pendingNewBranch = null;
			const worktree = await createWorktree(repo.path, repo.name, base, branch, this.notifyScriptPath, this.coordHookPath);
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false);
			if (opts.task) this.pendingTask.set(tile.tileId, opts.task);
			if (this.stageEl) tile.render(this.stageEl);
			this.tiles.push(tile);
			void this.persist();
			this.applyLayout();
			return tile;
		} catch (e) {
			this.deps.toast(`Worktree failed: ${(e as Error).message}`);
			return null;
		}
	}

	/** Kane asked to spawn a terminal: resolve the repo by name, default the base branch, start
	 *  it on the given task. */
	private async spawnFromKane(repoName: string, base: string | null, task: string): Promise<void> {
		const known = this.repos.some((r) => r.name === repoName || r.name.toLowerCase() === repoName.toLowerCase());
		if (!known) { this.writeGodInbox(`cannot spawn — unknown repo "${repoName}". Known: ${this.repos.map((r) => r.name).join(', ') || '(none)'}`); return; }
		await this.spawnFromName(repoName, base, task);
	}

	/** Spawn a new journal tile, center it, and persist. */
	private spawnJournal(): void {
		const tile = new JournalTile({
			tileId: this.nextTileId++,
			name: `Journal ${++this.journalSeq}`,
			store: this.journalStore,
			toast: this.deps.toast,
			onClosed: (t) => {
				const wasCentered = this.centeredId === t.tileId;
				const r = rqClose(this.q, t.tileId, wasCentered); this.q = r.state;
				this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist();
				if (r.center !== null) this.doCenter(r.center);
				else { if (wasCentered) this.centeredId = null; this.applyLayout(); }
			},
			onHide: (t) => this.hideTile(t),
			onLock: (t) => this.toggleLockById(t.tileId),
			onCenter: (t) => this.handleClick(t.tileId),
			onRequestRename: (t, cur) => {
				void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename')
					.then((name) => { if (name && name.trim()) { t.setName(name.trim()); void this.persist(); } });
			},
			onRename: () => { void this.persist(); },
		});
		if (this.stageEl) tile.render(this.stageEl);
		this.tiles.push(tile);
		this.doCenter(tile.tileId);
		void this.persist();
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
		const members = (selected as TerminalTile[]).map((t) => ({
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

	/** Every live session GOD should see / be able to message (foreground + hidden background). */
	private allSessions(): StageTile[] { return [...this.tiles, ...this.hidden]; }

	/** Number of live terminals (foreground + hidden) — for the close-workspace confirm. */
	terminalCount(): number { return this.tiles.length + this.hidden.length; }

	/** Snapshot of which terminals need attention, for the topbar queue. */
	attentionItems(): AttentionItem[] {
		return classifyAttention((this.allSessions().filter((t) => !t.isJournal) as TerminalTile[]).map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t),
			output: t.recentOutput(), idle: this.idleTiles.has(t.tileId),
		})));
	}

	/** Jump to a terminal by id: un-hide it if hidden, else center + focus it. */
	revealTile(id: number): void {
		if (this.hidden.some((t) => t.tileId === id)) { this.showTile(id); return; }
		if (this.tiles.some((t) => t.tileId === id)) { this.doCenter(id); this.focusCentered(); }
	}

	private tileState(t: StageTile): string {
		const o = t.recentOutput();
		if (looksLikePrompt(o)) return 'prompt';
		if (looksLikeMenu(o)) return 'menu';
		if (looksErrored(o)) return 'errored';
		return this.idleTiles.has(t.tileId) ? 'idle' : 'running';
	}

	/** Floor snapshot for the phone view: every session (+ Kane) with state + recent output. */
	floorState(): RemoteTerminal[] {
		const out: RemoteTerminal[] = (this.allSessions().filter((t) => !t.isJournal) as TerminalTile[]).map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch,
			state: this.tileState(t), output: t.recentOutput().split('\n').slice(-12).join('\n'), remoteOn: t.isRemoteOn,
		}));
		if (this.godConsole) {
			const ko = this.godConsole.recentOutput();
			out.unshift({
				id: -1, name: 'Kane', repo: '—', branch: '—',
				state: looksLikePrompt(ko) ? 'prompt' : looksLikeMenu(ko) ? 'menu' : 'running',
				output: ko.split('\n').slice(-12).join('\n'), remoteOn: false,
			});
		}
		return out;
	}

	repoNames(): string[] { return this.repos.map((r) => r.name); }

	/** Toggle remote-control on a terminal by id (from the phone). */
	toggleRemoteById(id: number): void {
		const t = this.allSessions().find((x) => x.tileId === id);
		if (t && !t.isJournal) (t as TerminalTile).toggleRemoteControl();
	}

	/** Spawn a worktree terminal for a repo by name, on a base, with a kickoff task. */
	async spawnFromName(repoName: string, base: string | null, task: string): Promise<TerminalTile | null> {
		const repo = this.repos.find((r) => r.name === repoName)
			?? this.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
		if (!repo) return null;
		const baseBranch = base ?? (defaultBranch(await listBranches(repo.path)) ?? 'main');
		return this.spawnWorktree(repo, baseBranch, { task });
	}

	/** Toggle the GOD console: spawn on first open, then just show/hide (session persists). */
	private toggleGod(): void {
		if (!this.godConsole) {
			const godHomeDir = path.join(this.coordDir, '..', '.god', this.deps.group);
			this.godConsole = new GodConsole(
				{ repos: this.repos.map((r) => ({ name: r.name, path: r.path })), coordDir: this.coordDir, sidecarPath: this.sidecarPath, godHomeDir },
				() => this.hideGod(),
			);
			if (this.stageWrapEl) this.godConsole.render(this.stageWrapEl);
			this.godVisible = true;
			this.startFloorFeed();
			this.godBtn?.toggleClass('cos-god-on', true);
			this.applyLayout();
			this.godConsole.focus();
			return;
		}
		if (this.godVisible) this.hideGod();
		else this.showGod();
	}

	private showGod(): void {
		this.godVisible = true;
		this.godConsole?.setVisible(true);
		this.startFloorFeed();
		this.godBtn?.toggleClass('cos-god-on', true);
		this.applyLayout();
	}

	private hideGod(): void {
		this.godVisible = false;
		this.godConsole?.setVisible(false);
		this.stopFloorFeed();
		this.godBtn?.toggleClass('cos-god-on', false);
		this.applyLayout();
	}

	private floorDir(): string { return path.join(this.coordDir, 'floor'); }
	private outboxDir(): string { return path.join(this.coordDir, 'god-outbox'); }

	/** Begin writing terminal snapshots + watching the GOD outbox while the console is open. */
	private startFloorFeed(): void {
		this.writeFloorSnapshot();
		if (this.floorTimer === null) this.floorTimer = window.setInterval(() => this.writeFloorSnapshot(), 4000);
		try {
			const out = this.outboxDir();
			fsSync.mkdirSync(out, { recursive: true });
			this.drainOutbox();
			if (!this.godOutboxWatcher) this.godOutboxWatcher = fsSync.watch(out, () => this.drainOutbox());
		} catch { /* outbox unavailable — snapshots still work */ }
	}

	private stopFloorFeed(): void {
		if (this.floorTimer !== null) { window.clearInterval(this.floorTimer); this.floorTimer = null; }
		this.godOutboxWatcher?.close(); this.godOutboxWatcher = null;
	}

	/** Dump each live session's recent output to coordDir/floor/<id>-<slug>.md + an INDEX.md;
	 *  prune snapshots for sessions that have since closed. */
	private writeFloorSnapshot(): void {
		try {
			const dir = this.floorDir();
			fsSync.mkdirSync(dir, { recursive: true });
			const now = Date.now();
			const sessions = this.allSessions();
			const live = new Set<string>(['INDEX.md']);
			for (const t of sessions) {
				if (t.isJournal) continue; // journals have no worktree snapshot
				const tt = t as TerminalTile;
				const fname = `${tt.tileId}-${godSlug(tt.name)}.md`;
				live.add(fname);
				const body = formatFloorSnapshot(
					{ name: tt.name, repo: this.repoNameFor(tt), branch: tt.branch, worktreePath: tt.worktreePath, ts: now },
					tt.recentOutput(),
				);
				fsSync.writeFileSync(path.join(dir, fname), body, 'utf8');
			}
			fsSync.writeFileSync(path.join(dir, 'INDEX.md'),
				formatFloorIndex(sessions.map((t) => ({ id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch }))), 'utf8');
			for (const f of fsSync.readdirSync(dir)) if (f.endsWith('.md') && !live.has(f)) { try { fsSync.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
		} catch { /* best effort */ }
	}

	/** The repo name a session belongs to (matches the scan/registry mapping). */
	private repoNameFor(t: StageTile): string {
		if (t.isJournal) return 'journal';
		const e = this.lastEntries.find((x) => path.resolve(x.path) === path.resolve((t as TerminalTile).worktreePath));
		return e ? e.repo : '?';
	}

	/** Deliver any pending GOD→worker messages, then archive them to .done/. */
	private drainOutbox(): void {
		const out = this.outboxDir();
		let files: string[] = [];
		try { files = fsSync.readdirSync(out).filter((f) => f.endsWith('.json')); } catch { return; }
		if (!files.length) return;
		const sessions = this.allSessions();
		const names = sessions.map((t) => t.name);
		const done = path.join(out, '.done');
		try { fsSync.mkdirSync(done, { recursive: true }); } catch { /* ignore */ }
		for (const f of files) {
			const full = path.join(out, f);
			let text = '';
			try { text = fsSync.readFileSync(full, 'utf8'); } catch { continue; }
			const msg = parseOutboxMessage(text);
			if (msg) this.dispatchOutbox(msg, names);
			try { fsSync.renameSync(full, path.join(done, f)); } catch { try { fsSync.unlinkSync(full); } catch { /* ignore */ } }
		}
	}

	/** Act on one parsed Kane command (tell a worker / register a watch / spawn a terminal). */
	private dispatchOutbox(msg: OutboxMessage, liveNames: string[]): void {
		if (msg.kind === 'tell') {
			const name = resolveTellTarget(msg.target, liveNames);
			const tile = name ? this.allSessions().find((t) => t.name === name) : undefined;
			if (tile && !tile.isJournal) (tile as TerminalTile).sendLine(msg.message);
			else this.writeGodInbox(`could not deliver to "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'watch') {
			const name = resolveTellTarget(msg.target, liveNames);
			if (name) this.watchers.push({ target: name, note: msg.note });
			else this.writeGodInbox(`cannot watch "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'personality') {
			this.togglePersonality();
		} else {
			void this.spawnFromKane(msg.repo, msg.base, msg.task);
		}
	}

	/** Flip Kane's personality mode (triggered by his `/personality` command). On = inject the
	 *  forge-master persona + start periodic floor pulses; off = revert to the plain overseer
	 *  voice + stop pulses. State is app-side so the pulse cadence is gated cleanly. */
	private togglePersonality(): void {
		this.kanePersonality = !this.kanePersonality;
		if (this.kanePersonality) {
			this.godConsole?.notify(KANE_PERSONA_ON);
			this.startPulse();
		} else {
			this.godConsole?.notify(KANE_PERSONA_OFF);
			this.stopPulse();
		}
	}

	/** Begin nudging Kane for a one-line floor pulse on a fixed cadence (only while he's visible —
	 *  no point pulsing a hidden panel). */
	private startPulse(): void {
		if (this.pulseTimer !== null) return;
		this.pulseTimer = window.setInterval(() => {
			if (this.kanePersonality && this.godVisible) this.godConsole?.notify(KANE_PULSE);
		}, this.pulseMs);
	}

	private stopPulse(): void {
		if (this.pulseTimer !== null) { window.clearInterval(this.pulseTimer); this.pulseTimer = null; }
	}

	/** Leave GOD an error note he can read back. */
	private writeGodInbox(message: string): void {
		try {
			const inbox = path.join(this.coordDir, 'god-inbox');
			fsSync.mkdirSync(inbox, { recursive: true });
			fsSync.writeFileSync(path.join(inbox, `${Date.now()}-error.md`), message + '\n', 'utf8');
		} catch { /* best effort */ }
	}

	/** Center a tile AND give its terminal keyboard focus (so typing goes there). */
	private doCenter(id: number): void {
		// Navigating to a DIFFERENT tile breaks an individual lock (the only way out of it).
		if (this.lockedTileId !== null && this.lockedTileId !== id) { this.lockedTileId = null; this.refreshLockVisuals(); }
		this.centeredId = id;
		this.applyLayout();
		this.focusCentered();
	}

	/** Toggle the individual lock for a tile: pin it to center until you switch terminals. */
	private toggleLockById(id: number): void {
		if (!this.tiles.some((t) => t.tileId === id)) return; // only real terminal tiles
		if (this.lockedTileId === id) { this.lockedTileId = null; this.refreshLockVisuals(); return; }
		this.lockedTileId = id;
		this.refreshLockVisuals();
		this.doCenter(id); // lockedTileId === id, so doCenter won't break it
	}

	private refreshLockVisuals(): void {
		this.tiles.forEach((t) => t.setLocked(t.tileId === this.lockedTileId));
	}

	/** Dim tiles whose name / repo / branch don't match the filter box (empty = all lit). */
	private refreshSearch(): void {
		const q = this.searchQuery;
		for (const t of this.tiles) {
			const hay = `${t.name} ${t.repoName} ${t.branch}`.toLowerCase();
			t.setDimmed(q !== '' && !hay.includes(q));
		}
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
		if (this.searchQuery) this.refreshSearch(); // keep newly-laid-out tiles consistent with the filter
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

	/** The tile currently in the center (if any). */
	private centeredTile(): StageTile | undefined {
		return this.centeredId === null ? undefined : this.tiles.find((t) => t.tileId === this.centeredId);
	}

	/** A visible tile's state for the spotlight decision. A permission prompt / selection menu
	 *  is "waiting for you" even mid-turn; a settled-but-errored tile outranks a clean idle one.
	 *  Anything still streaming output is `thinking` and never grabs the center on its own.
	 *  (`errored` is gated behind idle so a streaming tile that merely prints the word "error"
	 *  can't steal focus.) */
	private spotlightState(t: StageTile): SpotlightState {
		if (t.isJournal) return 'thinking'; // journals never auto-grab the spotlight; centered only on click
		const o = t.recentOutput();
		if (looksLikePrompt(o)) return 'prompt';
		if (looksLikeMenu(o)) return 'menu';
		const idle = this.idleTiles.has(t.tileId);
		if (idle && looksErrored(o)) return 'errored';
		return idle ? 'idle' : 'thinking';
	}

	/** Re-derive the spotlight from the floor's CURRENT state and apply it. The single funnel
	 *  every auto (non-click) path runs through, so the center can't get stranded on a thinking
	 *  tile: a tile that needs you wins, and when everyone is thinking the grid drops to equal
	 *  size (no spotlight). Manual clicks/cycles still set the center directly. */
	private autoCenter(): void {
		const want = decideCenter({
			tiles: this.tiles.map((t) => ({ id: t.tileId, state: this.spotlightState(t) })),
			centeredId: this.centeredId,
			readyOrder: this.q.stack,
			userTyping: this.q.composingLen > 0,
			globalLock: this.locked,
			lockedTileId: this.lockedTileId,
		});
		if (want === this.centeredId) return;          // no change → don't re-lay-out (avoids flicker)
		if (want === null) { this.centeredId = null; this.applyLayout(); return; } // equal grid
		this.doCenter(want);
	}

	private handleReady(t: TerminalTile): void {
		// Fire any one-shot watch whose target just finished — idle and NOT stalled on a prompt.
		if (this.watchers.some((w) => w.target === t.name)) {
			const out = t.recentOutput();
			if (!looksLikePrompt(out) && !looksLikeMenu(out)) {
				const fired = this.watchers.filter((w) => w.target === t.name);
				this.watchers = this.watchers.filter((w) => w.target !== t.name);
				for (const w of fired) this.godConsole?.notify(`[watch] terminal "${t.name}" finished — you asked: ${w.note}`);
			}
		}
		// Deliver a Kane-spawned terminal's initial task once it's first ready.
		const task = this.pendingTask.get(t.tileId);
		if (task !== undefined) { this.pendingTask.delete(t.tileId); t.sendLine(task); }

		this.idleTiles.add(t.tileId); // finished a turn → idle/done (also covers hidden background tiles)

		if (this.hidden.includes(t)) return; // a hidden, background session never steals the center
		if (this.chatRoom) { this.chatRoom.noteIdle(t.name); return; } // chat owns idle while open
		this.q = rqReady(this.q, t.tileId).state; // record readiness + recency on the stack
		// autoCenter re-derives the spotlight from current state — the lock / menu / typing holds
		// and the "thinking tiles never hold the center" rule all live there now.
		this.autoCenter();
	}

	private handleSubmit(t: TerminalTile): void {
		this.idleTiles.delete(t.tileId); // submitting → busy again
		if (this.hidden.includes(t)) return; // background sessions don't drive centering
		// Auto-lock: an Enter inside an on-screen selection menu is toggling an option, NOT
		// submitting a prompt — don't bubble focus away, so a multi-select can be finished in one
		// go. (The Lock button does this globally; this does it automatically for menus.)
		if (looksLikeMenu(t.recentOutput())) return;
		this.q = rqSubmit(this.q, t.tileId).state; // finished with it → off the ready stack
		// Re-derive: center the next tile that needs you, or drop to the equal grid if everyone
		// is now thinking (nobody is waiting on you).
		this.autoCenter();
	}

	/** Hide a tile: pull it off the stage but keep its session + worktree alive.
	 *  Resurface later with showTile() from the Coordination panel. */
	private hideTile(tile: StageTile): void {
		if (!this.tiles.includes(tile)) return;
		if (this.lockedTileId === tile.tileId) { this.lockedTileId = null; tile.setLocked(false); }
		const wasCentered = this.centeredId === tile.tileId;
		this.tiles = this.tiles.filter((x) => x !== tile);
		this.hidden.push(tile);
		tile.setHidden(true);
		tile.setSelected(false);          // a hidden tile is never a chat member
		this.updateChatBtn();
		const r = rqClose(this.q, tile.tileId, wasCentered); // drop from the ready-queue
		this.q = r.state;
		if (r.center !== null) this.doCenter(r.center);
		else { if (wasCentered) this.centeredId = null; this.applyLayout(); }
		void this.persist();
		this.board?.refresh();
	}

	/** Resurface a hidden tile: put it back on the stage, centered + focused. */
	private showTile(tileId: number): void {
		const tile = this.hidden.find((t) => t.tileId === tileId);
		if (!tile) return;
		this.hidden = this.hidden.filter((t) => t !== tile);
		this.tiles.push(tile);
		tile.setHidden(false);
		this.idleTiles.delete(tile.tileId); // resurfaced → you're acting on it, not "done waiting"
		this.centeredId = tile.tileId;
		this.applyLayout();
		this.focusCentered();
		void this.persist();
		this.board?.refresh();
	}

	/** Close a hidden tile from the Coordination panel: confirm, then kill its session and
	 *  remove the worktree + branch (same as the tile ×), and drop it from the hidden list. */
	private async closeHiddenTile(tileId: number): Promise<void> {
		const tile = this.hidden.find((t) => t.tileId === tileId);
		if (!tile) return;
		const ok = await promptForConfirm(
			`Close "${tile.name}"?`,
			`This kills the session and removes its worktree + branch (${tile.branch}). It can't be undone.`,
			'Close',
		);
		if (!ok) return;
		this.hidden = this.hidden.filter((t) => t !== tile);
		this.idleTiles.delete(tile.tileId);
		if (this.lockedTileId === tile.tileId) this.lockedTileId = null;
		if (tile.isJournal) { tile.kill(); }
		else { await (tile as TerminalTile).close(); } // kill + removeWorktreeAndBranch + fires onClosed
		void this.persist();
		this.board?.refresh();
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
			onClosed: (t) => { this.idleTiles.delete(t.tileId); if (this.lockedTileId === t.tileId) this.lockedTileId = null; const wasCentered = this.centeredId === t.tileId; const r = rqClose(this.q, t.tileId, wasCentered); this.q = r.state; this.tiles = this.tiles.filter((x) => x !== t); void this.persist(); if (r.center !== null) this.doCenter(r.center); else { if (wasCentered) this.centeredId = null; this.applyLayout(); } },
			onHide: (t) => this.hideTile(t),
			onLock: (t) => this.toggleLockById(t.tileId),
			onCenter: (t) => this.handleClick(t.tileId),
			onReady: (t) => this.handleReady(t),
			onInput: (t, data) => { this.idleTiles.delete(t.tileId); this.q.composingLen = applyKeystroke(this.q.composingLen, data); },
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
		const serializeTile = (t: StageTile, hidden: boolean): SessionRecord => {
			if (t.isJournal) {
				return { kind: 'journal', name: t.name, journalSlug: (t as JournalTile).journalSlug, hidden, worktreePath: '', branch: '', repoName: 'journal', repoPath: '', baseBranch: '' };
			}
			return { kind: 'terminal', ...(t as TerminalTile).sessionRecord(), hidden };
		};
		all[this.deps.group] = [
			...this.tiles.map((t) => serializeTile(t, false)),
			...this.hidden.map((t) => serializeTile(t, true)),
		];
		try { await fs.writeFile(this.sessionsFile, JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
	}

	/** On open: re-create a tile (claude --continue) for each persisted worktree that still exists. */
	private async restoreSessions(): Promise<void> {
		const all = await this.readAllSessions();
		const recs = all[this.deps.group] ?? [];
		const { visible, hidden } = partitionByHidden(recs);
		for (const rec of [...visible, ...hidden]) {
			if (rec.kind === 'journal') {
				const doc = rec.journalSlug ? this.journalStore.load(rec.journalSlug) : null;
				const tile = new JournalTile({
					tileId: this.nextTileId++, name: rec.name ?? 'Journal', store: this.journalStore,
					slug: rec.journalSlug, initialText: doc?.text ?? '', toast: this.deps.toast,
					onClosed: (t) => { const wc = this.centeredId === t.tileId; const r = rqClose(this.q, t.tileId, wc); this.q = r.state; this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist(); if (r.center !== null) this.doCenter(r.center); else { if (wc) this.centeredId = null; this.applyLayout(); } },
					onHide: (t) => this.hideTile(t), onLock: (t) => this.toggleLockById(t.tileId),
					onCenter: (t) => this.handleClick(t.tileId),
					onRequestRename: (t, cur) => { void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename').then((n) => { if (n && n.trim()) { t.setName(n.trim()); void this.persist(); } }); },
					onRename: () => { void this.persist(); },
				});
				if (this.stageEl) tile.render(this.stageEl);
				if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); } else { this.tiles.push(tile); }
				continue; // skip the terminal path for this record
			}
			let exists = false;
			try { await fs.access(rec.worktreePath); exists = true; } catch { exists = false; }
			if (!exists) continue;
			const tile = this.makeTile({ worktreePath: rec.worktreePath, branch: rec.branch }, rec.repoName, rec.repoPath, rec.baseBranch, true, rec.name);
			try { await writeReadyHook(rec.worktreePath, this.notifyScriptPath, this.coordHookPath); } catch { /* best effort */ }
			if (this.stageEl) tile.render(this.stageEl);
			if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); }
			else this.tiles.push(tile);
		}
		await this.persist(); // prune records whose worktree no longer exists
		this.applyLayout();
	}

	/** Full teardown (view close): unmount + kill all sessions. */
	dispose(): void {
		this.unmount();
		this.stageResizeObs?.disconnect(); this.stageResizeObs = null;
		this.board = null;
		this.stopPulse();
		this.godConsole?.dispose(); this.godConsole = null;
		for (const t of this.tiles) t.kill();
		for (const t of this.hidden) t.kill();
		this.tiles = [];
		this.hidden = [];
		this.stageEl = null;
		this.stageWrapEl = null;
	}

	/** Park every dirty worktree of every live tile (plugin unload: accidental teardown / reload).
	 *  Called from the plugin's onunload — NOT from unmount(), which is a tab-switch that keeps
	 *  sessions + their live agents running. */
	public async parkAll(): Promise<void> {
		const iso = new Date().toISOString();
		for (const t of [...this.tiles, ...this.hidden]) {
			if (t.isJournal) continue; // journals have no worktree to park
			const tt = t as TerminalTile;
			try {
				const action = await parkWorktree(tt.worktreePath, iso);
				if (action === 'parked') {
					await fs.appendFile(path.join(this.coordDir, 'board.md'),
						`${Date.now()}\t${tt.name}\t-\tNOTE\tauto-parked on teardown\n`, 'utf8').catch(() => {});
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
				const tile = ([...this.tiles, ...this.hidden].filter((t) => !t.isJournal) as TerminalTile[]).find((t) => path.resolve(t.worktreePath) === path.resolve(wt.path));
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
		if (this.tiles.some((t) => !t.isJournal && path.resolve((t as TerminalTile).worktreePath) === path.resolve(entry.path))) return;
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
