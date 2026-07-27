# WCC themes — Olympus / Hades / Olis (ported from Sargent)

**Date:** 2026-07-24
**Status:** approved scope (user: keep current look as Default; four themes total)

## What

A theme switcher for the WCC shell, porting the three Sargent report themes
(`sargent/src/routes/reports/themes/*.js`) as chrome identities:

- **default** — today's look, byte-for-byte. Boot default; nothing changes until picked.
- **olympus** — brutalist daylight: construction yellow `#ffde2e` + ink `#0b0b0b` on
  off-white `#f4f2ea`; 2px ink borders, offset shadows, uppercase mono chrome.
- **hades** — navy `#0a1929` + cyan `#71d4e8` + amber `#f0b864`; same brutalist bones,
  blueprint dot-grid on the stage background.
- **olis** — light SaaS: `#f8f9fb` canvas, electric blue `#0034ff`, thin 1px borders,
  8px radius, soft shadows.

## How

- **Mechanism (same as Sargent):** `document.documentElement.dataset.theme = id`;
  `app.css` gains per-theme blocks `:root[data-theme="X"] { … }` that REMAP WCC's existing
  variables (`--background-primary/-secondary`, `--background-modifier-border/-hover`,
  `--text-normal/-muted`, `--interactive-accent(-hover)`, `--text-on-accent`,
  `--color-red/-green/-yellow`) so every existing component re-tints automatically, plus a
  small set of personality rules per theme for the visible chrome (topbar, workspace tabs,
  app-tab strip, tile frames/heads, control buttons, board, toasts, dialogs, Kane panel).
- **Terminal interiors are deliberately untouched** in v1 — Claude's TUI paints its own
  dark colors; retinting xterm under it would look broken, and live-retheming every tile
  adds complexity for no visual win. All themes keep the dark terminal wells.
- **Fonts:** stacks with graceful fallbacks only, no network imports
  (`'Archivo Black','Arial Black',sans-serif`; `'JetBrains Mono',Consolas,monospace`;
  `'Open Sans','Segoe UI',sans-serif`).
- **Store (pure, TDD):** `src/terminals/theme-store.ts` — `THEMES` (id+label list),
  `normalizeTheme(raw): string` (unknown/legacy → `'default'`).
- **Switcher:** a `<select>` in the top bar; startup applies `cfg.theme` before mount;
  change applies instantly and persists via the existing `persist()` merge (`theme` key).

## Out of scope (v1)

Per-theme xterm palettes; theming inside webview app tabs; per-workspace themes.
