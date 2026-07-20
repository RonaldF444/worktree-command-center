# Alt+J Journal Shortcut & F11 Fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alt+J spawns a new journal entry tile from the keyboard; F11 toggles native OS fullscreen for the app window.

**Architecture:** Two independent, tiny changes. Alt+J is a new branch in the renderer's existing capture-phase keydown handler in `TerminalsGrid.installKeyboard()`, calling the existing `spawnJournal()` (the same path as the 📓 button). F11 is a `before-input-event` handler on the window's `webContents` in the Electron main process — it fires before the page sees the key and its `preventDefault()` also suppresses the default menu's own F11 accelerator, so no double-toggle and no IPC.

**Tech Stack:** TypeScript, Electron 33 (main process + renderer), esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-alt-j-journal-f11-fullscreen-design.md`

## Global Constraints

- NEVER launch the app or any GUI — verification is `npm run build` and `npm test` only; the user smoke-tests Alt+J and F11 themselves on next launch.
- No new tests: the existing vitest suite covers neither `terminals-grid.ts` keyboard handling nor `electron/main.ts`, and no test harness exists for either (spec: "Testing / verification"). The existing suite must stay green.
- No changes to the default application menu, no new IPC channels, no Escape-to-exit-fullscreen (spec: "Out of scope").
- Tabs for indentation (repo convention in both files).
- Commit messages follow repo convention `feat(scope): ...` and end with the Co-Authored-By line shown in each commit step.

---

### Task 1: Alt+J opens a new journal entry tile

**Files:**
- Modify: `src/terminals/terminals-grid.ts:216` (📓 button tooltip)
- Modify: `src/terminals/terminals-grid.ts:335-336` (keydown handler in `installKeyboard()`)

**Interfaces:**
- Consumes: `private spawnJournal(): void` (already exists at `src/terminals/terminals-grid.ts:437` — creates a `JournalTile`, renders it, centers it via `this.doCenter(tile.tileId)`, persists). Also `this.keydown`, the capture-phase handler installed by `installKeyboard()`.
- Produces: nothing consumed by later tasks (Task 2 is independent).

- [ ] **Step 1: Add the Alt+J branch to the keydown handler**

In `src/terminals/terminals-grid.ts`, inside `installKeyboard()`, the handler currently reads (lines 332-338):

```ts
			if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (this.centeredId !== null) this.toggleLockById(this.centeredId); return; }
			// Alt+K opens/focuses Kane. Kane wins this key — the letter-badge jumps only reach 'K'
			// with 23+ visible tiles, which never happens in practice.
			if (e.key === 'k' || e.key === 'K') { e.preventDefault(); this.openKane(); return; }
			const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
			const idx = keyToIndex(norm);
			if (idx !== null && this.tiles[idx]) { e.preventDefault(); this.handleClick(this.tiles[idx]!.tileId); }
```

Insert a new branch between the Alt+K line and the `const norm` line, so it becomes:

```ts
			if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (this.centeredId !== null) this.toggleLockById(this.centeredId); return; }
			// Alt+K opens/focuses Kane. Kane wins this key — the letter-badge jumps only reach 'K'
			// with 23+ visible tiles, which never happens in practice.
			if (e.key === 'k' || e.key === 'K') { e.preventDefault(); this.openKane(); return; }
			// Alt+J opens a new journal entry. Like Alt+K, this shadows the letter badges only
			// at 22+ visible tiles (badges run F1–F12 then A…), which never happens in practice.
			if (e.key === 'j' || e.key === 'J') { e.preventDefault(); this.spawnJournal(); return; }
			const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
			const idx = keyToIndex(norm);
			if (idx !== null && this.tiles[idx]) { e.preventDefault(); this.handleClick(this.tiles[idx]!.tileId); }
```

- [ ] **Step 2: Advertise the shortcut in the 📓 button tooltip**

Line 216 currently reads:

```ts
		const journalBtn = controls.createEl('button', { text: '📓 Journal Entry', cls: 'cos-journal-btn', attr: { title: 'Open a new journal entry tile' } });
```

Change the title only:

```ts
		const journalBtn = controls.createEl('button', { text: '📓 Journal Entry', cls: 'cos-journal-btn', attr: { title: 'Open a new journal entry tile (Alt+J)' } });
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0 (tsc type-check then esbuild bundle, no errors printed).

- [ ] **Step 4: Run the existing test suite**

Run: `npm test`
Expected: all existing vitest tests PASS (nothing in the suite touches `installKeyboard`; this guards against accidental breakage elsewhere).

- [ ] **Step 5: Commit**

```bash
git add src/terminals/terminals-grid.ts
git commit -m "feat(journal): Alt+J opens a new journal entry tile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: F11 toggles native fullscreen

**Files:**
- Modify: `electron/main.ts:37` (after `win.loadFile(...)` in `createWindow()`)

**Interfaces:**
- Consumes: module-level `let win: BrowserWindow | null` (`electron/main.ts:9`), assigned in `createWindow()`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the before-input-event handler**

In `electron/main.ts`, `createWindow()` currently reads (lines 35-40):

```ts
	});

	win.loadFile(path.join(__dirname, '..', 'index.html'));

	// IPC: return resolved paths
	ipcMain.handle('paths', () => ({ sidecarDir, userData }));
```

Insert the handler between `win.loadFile(...)` and the `// IPC: return resolved paths` comment:

```ts
	});

	win.loadFile(path.join(__dirname, '..', 'index.html'));

	// F11 toggles native fullscreen. before-input-event fires ahead of the page AND
	// (via preventDefault) suppresses the default menu's own F11 accelerator, so the
	// toggle can't fire twice and works no matter which tile has focus.
	win.webContents.on('before-input-event', (event, input) => {
		if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat && win) {
			event.preventDefault();
			win.setFullScreen(!win.isFullScreen());
		}
	});

	// IPC: return resolved paths
	ipcMain.handle('paths', () => ({ sidecarDir, userData }));
```

Notes for the implementer:
- `input.type` is `'keyDown'` (camelCase) in Electron's `Input` type — NOT the DOM's lowercase `'keydown'`. The spec's illustrative snippet used lowercase; this plan is the corrected, authoritative version.
- The `&& win` guard exists because the callback fires long after `createWindow()` returns, and module-level `win` is `null` only before the first `createWindow()`; the guard also satisfies TypeScript's null narrowing inside the closure.
- `!input.isAutoRepeat` stops a held F11 key from flickering fullscreen on/off.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Run the existing test suite**

Run: `npm test`
Expected: all existing vitest tests PASS (unchanged from Task 1's run; confirms no cross-file breakage).

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(app): F11 toggles native fullscreen

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
