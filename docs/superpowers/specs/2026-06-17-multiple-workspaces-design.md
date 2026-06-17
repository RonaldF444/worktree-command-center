# Multiple Workspaces — Design

> Status: approved design, pre-implementation. Date: 2026-06-17.

## 1. Goal

Multiple independent workspaces, switchable via a tab bar. Each workspace has its own terminals,
worktree registry, coordination board, and Kane console; they share the global repo list. The
existing single workspace stays `group: 'default'` so current sessions are untouched.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Switcher UI | A tab bar between the topbar and the grid: tabs per workspace, active highlighted, **+ add**, **× close**. |
| Repos | **Shared** globally across workspaces. |
| A workspace IS | Its own `TerminalsGrid` (distinct `group` id + `coordDir = /.coordination/<id>`), sessions/board/Kane independent. |
| Switching | `active.unmount()` (keeps its sessions + Kane alive) → `target.mount(container)`. Grids built lazily, reused. |
| Close | Confirm if it has terminals (kills them via `grid.dispose()`); can't close the last; closing the active one switches to a neighbor. |
| Persistence | `config.workspaces: {id,name}[]` + `config.activeWorkspace`, via existing `setConfig`. |
| v1 scope | add / close / switch only — no rename, no per-workspace repos, no drag-reorder. |

## 3. Required grid fix

`TerminalsGrid.mount()` builds a fresh controls bar each call; `unmount()` removes the board
(`BoardView.unmount` → `el.remove()`) and detaches the stage wrap, but **not** the controls bar.
Re-mounting the same grid (which tab-switching does) would therefore stack duplicate controls
bars. Fix: `unmount()` also does `this.controlsEl?.remove(); this.controlsEl = null;`. (This is a
latent dupe bug today; the workspace switcher just exercises it.) No other grid change is needed —
keyboard listeners are added/removed per mount, and tiles/sidecars are retained across `unmount`.

## 4. Architecture — units

### 4.1 `workspace-store.ts` — pure (`src/terminals/workspace-store.ts`)

```ts
export interface Workspace { id: string; name: string; }

export function slugId(name: string): string;                 // filesystem-safe id from a name
export function uniqueId(base: string, taken: string[]): string; // base, base-2, base-3, …
export function addWorkspace(list: Workspace[], name: string): { list: Workspace[]; id: string } | null; // null on blank name
export function closeWorkspace(list: Workspace[], id: string): Workspace[];        // remove (no-op if absent / last)
export function nextActiveAfter(list: Workspace[], closingId: string, active: string): string; // id to activate after a close
export function normalizeWorkspaces(raw: unknown): Workspace[]; // from config; defaults to [{id:'default',name:'default'}]
```

- `slugId`: lowercase, non-alphanumerics → `-`, trimmed; falls back to `'workspace'`.
- `addWorkspace`: trims the name; null if empty; id = `uniqueId(slugId(name), existingIds)`; returns the
  appended list + new id.
- `closeWorkspace`: returns the list without `id`, but **never empties** the list (returns unchanged if
  it would remove the last one).
- `normalizeWorkspaces`: accepts the config value, validates each `{id,name}` string pair, dedupes by id,
  and guarantees at least `[{id:'default',name:'default'}]`.

Unit-tested.

### 4.2 `WorkspaceBar` — UI (`src/ui/workspace-bar.ts`)

```ts
export class WorkspaceBar {
  constructor(deps: {
    list: () => Workspace[];
    activeId: () => string;
    onSwitch: (id: string) => void;
    onAdd: () => void;
    onClose: (id: string) => void;
  });
  render(parent: HTMLElement): void;  // builds the tab row
  refresh(): void;                    // rebuild tabs from list()/activeId()
}
```

- A `.wcc-tabs` row. For each workspace: a `.wcc-tab` (active gets `.active`) with the name (click →
  `onSwitch`) and a `×` (click → `onClose`, `stopPropagation`). The `×` is omitted when only one
  workspace exists (can't close the last). A trailing **+ add** button → `onAdd`.
- `refresh()` empties and rebuilds the row.

### 4.3 App workspace manager (`src/app.ts`)

Rework `main()` into a manager:

- Load `cfg`; `repos` global as today. `workspaces = normalizeWorkspaces(cfg.workspaces)`;
  `activeId = cfg.activeWorkspace` if present in `workspaces` else `workspaces[0].id`.
- `const grids = new Map<string, TerminalsGrid>()`; `let activeGrid: TerminalsGrid`.
- `gridFor(id)`: lazily construct with deps `{ ...shared, group: id, coordDir: join(userData,'.coordination',id) }`
  (sidecar/notify/coordHook paths, sessionsFile, repos, bypassPermissions, toast, promptForTopic shared);
  cache in `grids`. Returns the grid (not mounted).
- `switchTo(id)`: if `id === activeId` no-op; else `activeGrid.unmount()`, `activeId = id`,
  `activeGrid = gridFor(id)`, `await activeGrid.mount(gridContainer)`, `bar.refresh()`, persist.
- Topbar order: brand · add-folder · status · usage battery · attention queue. Then the **WorkspaceBar**,
  then the `gridContainer`.
- **Attention widget points at the active grid**: `new AttentionWidget(() => activeGrid.attentionItems(), (id) => activeGrid.revealTile(id))` — the closures read the mutable `activeGrid`, so switching tabs updates the badge.
- `onAdd`: `promptForTopic('New workspace', 'name')` → `addWorkspace(workspaces, name)`; if non-null, set
  `workspaces`, persist, `switchTo(newId)`.
- `onClose(id)`: if it's the only workspace, ignore. If `grids.get(id)` has terminals, `window.confirm`
  ("Close workspace <name>? Its terminals will be stopped."); on yes → `grids.get(id)?.dispose()`,
  `grids.delete(id)`, `workspaces = closeWorkspace(workspaces, id)`, persist; if `id === activeId`
  → `switchTo(nextActiveAfter(...))`; else `bar.refresh()`.
- `addFolder`: after merging repos, `grids.forEach((g) => g.setRepos(repos))` and persist `{...cfg, repos, workspaces, activeWorkspace}`.
- `persist()`: `setConfig({ ...cfg, repos, workspaces, activeWorkspace: activeId })`.
- Initial: `activeGrid = gridFor(activeId)`; `await activeGrid.mount(gridContainer)`.

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Re-mount duplicates the controls bar | §3 fix: `unmount()` removes `controlsEl`. |
| Closing the last workspace | `closeWorkspace` no-ops on last; the `×` is hidden when one remains. |
| Closing the active workspace | `nextActiveAfter` picks a neighbor; switch to it. |
| Name → unsafe path | `slugId` for the id (path); display name kept separately. |
| Two workspaces, same coordDir | ids are unique (`uniqueId`), so coordDirs differ. |
| Stale `activeWorkspace` in config | falls back to `workspaces[0].id`. |
| Existing sessions under group 'default' | default workspace keeps id `'default'` → its `coordDir` + sessions key unchanged. |
| Switching while a grid is mid-mount | `switchTo` awaits `mount`; rapid switches resolve in order (acceptable). |

## 6. Testing

- **`tests/workspace-store.test.ts`** — `slugId` (spaces/symbols → safe, empty → 'workspace'),
  `uniqueId` (collision → -2/-3), `addWorkspace` (blank → null; unique id), `closeWorkspace` (removes;
  no-op on last), `nextActiveAfter` (neighbor selection), `normalizeWorkspaces` (junk → default; dedupe).
- WorkspaceBar + app manager are DOM/IO — verified by build + manual (add a workspace, switch, confirm
  each tab has its own terminals/board, close one, restart and the list + active persist).

## 7. Out of scope (v1)

- Rename a workspace, per-workspace repos, drag-reorder tabs, per-workspace usage.
