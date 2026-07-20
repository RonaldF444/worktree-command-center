# Alt+J Journal Shortcut & F11 Fullscreen — Design

**Date:** 2026-07-20
**Status:** Approved

## Goal

Two small quality-of-life additions to Worktree Command Center:

1. **Alt+J** opens a new journal entry tile — the keyboard equivalent of the
   📓 Journal Entry button.
2. **F11** toggles native OS fullscreen for the app window.

## 1. Alt+J — new journal entry tile

**Where:** `src/terminals/terminals-grid.ts`, inside `installKeyboard()`'s
capture-phase keydown handler.

**What:** Add a branch after the Alt+K (Kane) branch and BEFORE the
letter-badge `keyToIndex` mapping:

```ts
// Alt+J opens a new journal entry. Like Alt+K, this shadows the letter badges only
// at 22+ visible tiles (badges run F1–F12 then A…), which never happens in practice.
if (e.key === 'j' || e.key === 'J') { e.preventDefault(); this.spawnJournal(); return; }
```

**Why this shape:**

- `spawnJournal()` already creates the tile, names it (`Journal N`), centers
  it, and persists — identical path to the 📓 button. No new journal logic.
- The handler is capture-phase, so Alt+J works even while an xterm terminal
  holds keyboard focus.
- Badge collision: badges run F1–F12 then A, B, C… so the letter J is only
  assigned at 22+ visible tiles. Same accepted trade-off as Alt+K, documented
  in the same style of comment.
- Also update the 📓 button's tooltip to mention `(Alt+J)`, matching how the
  Kane button advertises `(Alt+K)`.

## 2. F11 — native fullscreen toggle

**Where:** `electron/main.ts`, inside `createWindow()` after the
`BrowserWindow` is constructed.

**What:**

```ts
// F11 toggles native fullscreen. before-input-event fires ahead of the page AND
// (via preventDefault) suppresses the default menu's own F11 accelerator, so the
// toggle can't fire twice and works no matter which tile has focus.
win.webContents.on('before-input-event', (event, input) => {
	if (input.type === 'keydown' && input.key === 'F11' && !input.isAutoRepeat && win) {
		event.preventDefault();
		win.setFullScreen(!win.isFullScreen());
	}
});
```

**Why this shape (alternatives considered):**

- **Main-process `before-input-event` (chosen):** fires before the renderer
  sees the key, so it works regardless of focus; per Electron docs,
  `event.preventDefault()` also suppresses menu accelerators, so the default
  menu's View → Toggle Full Screen (also F11) cannot double-toggle. No IPC.
- Renderer keydown + new IPC channel: more plumbing for the same result;
  fullscreen is inherently a main-process operation.
- Rely on the default Electron menu alone: unverifiable without launching the
  app, and silently breaks if the menu is ever customized/removed.

**Exiting fullscreen:** F11 again. Escape deliberately continues to pass
through to the terminals (existing behavior, documented in
`installKeyboard()`).

## Testing / verification

The existing vitest suite covers neither `terminals-grid.ts` keyboard handling
nor `electron/main.ts` (no test harness exists for either). This change
follows suit: verification is `npm run build` (tsc + esbuild) passing, plus
manual smoke-test of Alt+J and F11 by the user on next launch. Per standing
rule, the app is never launched from this session.

## Out of scope

- No changes to the default application menu.
- No new IPC channels.
- No separate OS window for journals — journals remain grid tiles.
- No Escape-to-exit-fullscreen.
