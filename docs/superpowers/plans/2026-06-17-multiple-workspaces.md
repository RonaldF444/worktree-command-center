# Multiple Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab-switchable workspaces, each its own independent `TerminalsGrid` (group + coordDir), sharing the global repos.

**Architecture:** A pure `workspace-store` (id/list logic), a `WorkspaceBar` tab UI, a one-line `grid.unmount()` fix so re-mount is clean, and an `app.ts` manager holding a `Map<id, TerminalsGrid>` that unmounts/mounts grids on switch and points the attention widget at the active grid.

**Tech Stack:** TypeScript, Electron renderer, vitest.

Spec: `docs/superpowers/specs/2026-06-17-multiple-workspaces-design.md`

---

## Task 1: `workspace-store` (pure)

**Files:** Create `src/terminals/workspace-store.ts`; Test `tests/workspace-store.test.ts`.

- [ ] **Step 1: Failing test** — `tests/workspace-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugId, uniqueId, addWorkspace, closeWorkspace, nextActiveAfter, normalizeWorkspaces } from '../src/terminals/workspace-store';

describe('slugId', () => {
  it('makes a filesystem-safe id', () => {
    expect(slugId('Card Tzar!')).toBe('card-tzar');
    expect(slugId('   ')).toBe('workspace');
  });
});
describe('uniqueId', () => {
  it('suffixes on collision', () => {
    expect(uniqueId('a', [])).toBe('a');
    expect(uniqueId('a', ['a'])).toBe('a-2');
    expect(uniqueId('a', ['a', 'a-2'])).toBe('a-3');
  });
});
describe('addWorkspace', () => {
  it('appends with a unique id; rejects blank', () => {
    const r = addWorkspace([{ id: 'default', name: 'default' }], 'cardtzar');
    expect(r).not.toBeNull();
    expect(r!.id).toBe('cardtzar');
    expect(r!.list.map((w) => w.id)).toEqual(['default', 'cardtzar']);
    expect(addWorkspace([], '   ')).toBeNull();
    const dup = addWorkspace([{ id: 'cardtzar', name: 'cardtzar' }], 'cardtzar');
    expect(dup!.id).toBe('cardtzar-2');
  });
});
describe('closeWorkspace', () => {
  it('removes a workspace but never the last', () => {
    expect(closeWorkspace([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], 'a').map((w) => w.id)).toEqual(['b']);
    expect(closeWorkspace([{ id: 'a', name: 'a' }], 'a').map((w) => w.id)).toEqual(['a']);
  });
});
describe('nextActiveAfter', () => {
  it('picks a surviving neighbor', () => {
    const list = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }];
    expect(nextActiveAfter(list, 'b', 'b')).toBe('a'); // previous if it exists
    expect(nextActiveAfter(list, 'a', 'a')).toBe('b'); // else next
  });
});
describe('normalizeWorkspaces', () => {
  it('defaults junk to a single default workspace and dedupes', () => {
    expect(normalizeWorkspaces(undefined)).toEqual([{ id: 'default', name: 'default' }]);
    expect(normalizeWorkspaces('nope')).toEqual([{ id: 'default', name: 'default' }]);
    expect(normalizeWorkspaces([{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }])).toEqual([{ id: 'a', name: 'A' }]);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/workspace-store.test.ts`.

- [ ] **Step 3: Implement** — `src/terminals/workspace-store.ts`:

```ts
export interface Workspace { id: string; name: string; }

export function slugId(name: string): string {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

export function uniqueId(base: string, taken: string[]): string {
	if (!taken.includes(base)) return base;
	let n = 2;
	while (taken.includes(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export function addWorkspace(list: Workspace[], name: string): { list: Workspace[]; id: string } | null {
	const trimmed = String(name).trim();
	if (!trimmed) return null;
	const id = uniqueId(slugId(trimmed), list.map((w) => w.id));
	return { list: [...list, { id, name: trimmed }], id };
}

export function closeWorkspace(list: Workspace[], id: string): Workspace[] {
	if (list.length <= 1) return list;
	const next = list.filter((w) => w.id !== id);
	return next.length ? next : list;
}

export function nextActiveAfter(list: Workspace[], closingId: string, active: string): string {
	if (active !== closingId) return active;
	const i = list.findIndex((w) => w.id === closingId);
	const survivors = list.filter((w) => w.id !== closingId);
	if (!survivors.length) return active;
	return (i > 0 ? list[i - 1]!.id : survivors[0]!.id);
}

export function normalizeWorkspaces(raw: unknown): Workspace[] {
	const out: Workspace[] = [];
	if (Array.isArray(raw)) {
		for (const w of raw) {
			if (w && typeof (w as Workspace).id === 'string' && typeof (w as Workspace).name === 'string'
				&& (w as Workspace).id && !out.some((x) => x.id === (w as Workspace).id)) {
				out.push({ id: (w as Workspace).id, name: (w as Workspace).name });
			}
		}
	}
	return out.length ? out : [{ id: 'default', name: 'default' }];
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/workspace-store.test.ts`.

- [ ] **Step 5: Commit.** `git add src/terminals/workspace-store.ts tests/workspace-store.test.ts && git commit -m "feat(workspaces): pure workspace-store (id/list logic)"`

---

## Task 2: grid `unmount()` fix

**Files:** Modify `src/terminals/terminals-grid.ts`.

- [ ] **Step 1: Remove the controls bar on unmount.** In `unmount()`, after `this.board?.unmount();` add:

```ts
		this.controlsEl?.remove();
		this.controlsEl = null;
```

- [ ] **Step 2: Type-check.** `npx tsc -noEmit -skipLibCheck` → clean.

- [ ] **Step 3: Commit.** `git add src/terminals/terminals-grid.ts && git commit -m "fix(grid): drop the controls bar on unmount so re-mount doesn't duplicate it"`

---

## Task 3: `WorkspaceBar` UI

**Files:** Create `src/ui/workspace-bar.ts`.

- [ ] **Step 1: Implement** — `src/ui/workspace-bar.ts`:

```ts
import type { Workspace } from '../terminals/workspace-store';

export interface WorkspaceBarDeps {
	list: () => Workspace[];
	activeId: () => string;
	onSwitch: (id: string) => void;
	onAdd: () => void;
	onClose: (id: string) => void;
}

/** A tab row of workspaces: click to switch, × to close (hidden when only one), + to add. */
export class WorkspaceBar {
	private el: HTMLElement | null = null;
	constructor(private deps: WorkspaceBarDeps) {}

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'wcc-tabs' });
		this.refresh();
	}

	refresh(): void {
		if (!this.el) return;
		this.el.empty();
		const list = this.deps.list();
		const active = this.deps.activeId();
		for (const w of list) {
			const tab = this.el.createDiv({ cls: 'wcc-tab' });
			tab.toggleClass('active', w.id === active);
			tab.createSpan({ cls: 'wcc-tab-name', text: w.name });
			tab.addEventListener('click', () => this.deps.onSwitch(w.id));
			if (list.length > 1) {
				const x = tab.createEl('button', { cls: 'wcc-tab-close', text: '×', attr: { title: `Close ${w.name}` } });
				x.addEventListener('click', (e) => { e.stopPropagation(); this.deps.onClose(w.id); });
			}
		}
		const add = this.el.createEl('button', { cls: 'wcc-tab-add', text: '+ add' });
		add.addEventListener('click', () => this.deps.onAdd());
	}
}
```

- [ ] **Step 2: Type-check.** `npx tsc -noEmit -skipLibCheck` → clean.

- [ ] **Step 3: Commit.** `git add src/ui/workspace-bar.ts && git commit -m "feat(workspaces): WorkspaceBar tab UI"`

---

## Task 4: App workspace manager

**Files:** Modify `src/app.ts`.

- [ ] **Step 1: Imports.** Add:

```ts
import { WorkspaceBar } from './ui/workspace-bar';
import { normalizeWorkspaces, addWorkspace, closeWorkspace, nextActiveAfter, type Workspace } from './terminals/workspace-store';
```

- [ ] **Step 2: Replace the grid construction + mount + addFolder block.** Replace everything from
`const deps: GridDeps = { … }` through the end of the `addFolderBtn.addEventListener(…)` block with the
manager below. (Keep the `installDomShim()`, `paths()`, `getConfig()`, `repos` lines, the `appEl`, the
topbar `brand`/`addFolderBtn`/`statusSpan`, and the usage-battery block as-is.)

```ts
		// --- workspaces ---
		let workspaces: Workspace[] = normalizeWorkspaces(cfg.workspaces);
		let activeId = workspaces.some((w) => w.id === cfg.activeWorkspace) ? cfg.activeWorkspace as string : workspaces[0]!.id;
		const grids = new Map<string, TerminalsGrid>();

		const depsFor = (id: string): GridDeps => ({
			repos,
			group: id,
			coordDir: path.join(userData, '.coordination', id),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile: path.join(userData, '.terminal-sessions.json'),
			bypassPermissions: true,
			toast,
			promptForTopic,
		});
		const gridFor = (id: string): TerminalsGrid => {
			let g = grids.get(id);
			if (!g) { g = new TerminalsGrid(depsFor(id)); grids.set(id, g); }
			return g;
		};
		let activeGrid = gridFor(activeId);

		const persist = () => void window.wcc.setConfig({ ...cfg, repos, workspaces, activeWorkspace: activeId });

		// Attention widget reads the ACTIVE grid (closures over the mutable activeGrid).
		const attention = new AttentionWidget(() => activeGrid.attentionItems(), (tileId) => activeGrid.revealTile(tileId));
		attention.render(topBar);
		window.addEventListener('beforeunload', () => attention.dispose());

		const bar = new WorkspaceBar({
			list: () => workspaces,
			activeId: () => activeId,
			onSwitch: (id) => void switchTo(id),
			onAdd: () => void onAdd(),
			onClose: (id) => onClose(id),
		});
		bar.render(appEl);

		const gridContainer = appEl.createDiv({ cls: 'wcc-grid-container' });

		async function switchTo(id: string): Promise<void> {
			if (id === activeId || !workspaces.some((w) => w.id === id)) return;
			activeGrid.unmount();
			activeId = id;
			activeGrid = gridFor(id);
			await activeGrid.mount(gridContainer);
			bar.refresh();
			persist();
		}

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
			const hasTiles = !!g && g.terminalCount() > 0;
			if (hasTiles && !window.confirm(`Close workspace "${ws?.name ?? id}"? Its ${g!.terminalCount()} terminal(s) will be stopped.`)) return;
			g?.dispose();
			grids.delete(id);
			const target = nextActiveAfter(workspaces, id, activeId);
			workspaces = closeWorkspace(workspaces, id);
			if (id === activeId) { void switchTo(target); } else { persist(); bar.refresh(); }
		}

		await activeGrid.mount(gridContainer);

		addFolderBtn.addEventListener('click', () => {
			void (async () => {
				const folder = await window.wcc.addFolder();
				if (!folder) return;
				const found = discoverRepos(folder);
				repos = mergeRepos(repos, found);
				grids.forEach((g) => g.setRepos(repos));
				persist();
				statusSpan.textContent = `${repos.length} repos · ${found.length} just added`;
				toast(`Added ${found.length} repo(s)`);
			})();
		});
```

Also **delete** the now-replaced earlier lines: the old `const deps: GridDeps = {…}`, `const grid = new TerminalsGrid(deps)`, the old `const attention = new AttentionWidget(() => grid.attentionItems(), …)` block, the old `const gridContainer = …`, and `await grid.mount(gridContainer)`. (The manager above supplies all of these.)

- [ ] **Step 3: Add `terminalCount()` to the grid** (`src/terminals/terminals-grid.ts`) — near `attentionItems()`:

```ts
	/** Number of live terminals (foreground + hidden) — for the close-workspace confirm. */
	terminalCount(): number { return this.tiles.length + this.hidden.length; }
```

- [ ] **Step 4: Type-check + full test.** `npx tsc -noEmit -skipLibCheck && npx vitest run` → clean, all pass.

- [ ] **Step 5: Commit.** `git add src/app.ts src/terminals/terminals-grid.ts && git commit -m "feat(workspaces): app manager — tabbed grids, lazy build, active-grid attention"`

---

## Task 5: Styling + build

**Files:** Modify `app.css`.

- [ ] **Step 1: Append** to `app.css`:

```css
/* Workspace tab bar. */
.wcc-tabs { display: flex; align-items: stretch; gap: 4px; padding: 6px 12px 0; flex: 0 0 auto; flex-wrap: wrap; }
.wcc-tab { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border: 1px solid var(--background-modifier-border); border-bottom: none; border-radius: 7px 7px 0 0; background: var(--background-secondary); color: var(--text-muted); cursor: pointer; font-size: 12px; }
.wcc-tab:hover { color: var(--text-normal); }
.wcc-tab.active { background: var(--background-primary); color: var(--text-normal); font-weight: 600; }
.wcc-tab-close { background: transparent; border: none; color: var(--text-faint); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.wcc-tab-close:hover { color: var(--text-normal); }
.wcc-tab-add { background: transparent; border: 1px dashed var(--background-modifier-border); border-radius: 7px; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 5px 10px; }
.wcc-tab-add:hover { color: var(--text-normal); border-color: var(--text-muted); }
```

- [ ] **Step 2: Build + full test.** `npm run build && npm test` → clean, all green.

- [ ] **Step 3: Commit.** `git add app.css && git commit -m "style(workspaces): tab bar"`

- [ ] **Step 4: Manual (`npm start`).** Default tab shows existing terminals. **+ add** → name → new empty workspace with its own controls/board. Switch tabs → each keeps its own terminals (sessions stay alive in the background; Kane per workspace). Close a non-active workspace → confirm → its terminals stop. Close the active one → switches to a neighbor. The attention badge reflects the active workspace. Restart → tabs + active persist.

---

## Self-Review

- **Spec coverage:** §3 grid fix → T2. §4.1 store → T1. §4.2 bar → T3. §4.3 manager → T4. §5 styling → T5.
- **Type consistency:** `Workspace` from `workspace-store` used by `WorkspaceBar` (T3) and app (T4). `addWorkspace`/`closeWorkspace`/`nextActiveAfter`/`normalizeWorkspaces` signatures match call sites. `terminalCount()` defined T4 Step 3, called in `onClose`. `gridFor`/`switchTo`/`activeGrid` consistent. `GridDeps` shape matches the existing interface.
- **Placeholder scan:** none.
- **Note:** T4 is a real rewrite of `app.ts`'s body — the engineer must delete the superseded grid/attention/container lines as called out, not leave both.
