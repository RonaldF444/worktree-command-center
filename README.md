# Worktree Command Center

Run many **Claude Code** sessions in parallel — each isolated in its own git
**worktree/branch**, tiled in one view — across whatever code folders you add.
Sessions coordinate through shared locks + a live board so they don't step on each
other, auto-save unfinished work, and can talk to each other (and you) in a group chat.

A standalone desktop app (Electron). Windows-first.

> **Status:** early / in development.

## What it does

- **Add a folder** — point it at a single repo or a parent dir; it discovers the git repos inside.
- **Worktree terminals** — each terminal runs in its own `git worktree` on its own branch, tiled with a bubbling/centering layout; terminals that need you take the spotlight, and everything drops to an equal grid while they're all thinking. Pick the **model and effort** (up to ultracode) for new terminals from the toolbar dropdowns.
- **Kane, the overseer console** — a privileged Claude session docked beside the floor (Alt+K). He reads live snapshots of every terminal, and on request messages workers (`cos-coord tell`), watches for a terminal to finish (`watch`), spawns new worktree terminals (`spawn`, with `--model`/`--effort`/`--name`), and renames them (`rename`). Duplicate him (`🜲+`) for extra consoles, each its own session; drag his left edge to resize.
- **Focus discipline** — clicking or Alt+jumping to a terminal holds the spotlight there for 30 s (auto-centering can't yank you away mid-read); typing in Kane is never interrupted; Alt+←/→ steps back into the flow.
- **Coordination** — automatic locks on `git push` / `worktree add`, a live board of who's doing what, a registry of every worktree's unsaved work, and sibling-awareness injected into each session.
- **Park & reopen** — unfinished work is auto-saved as a recoverable commit when things close; one click brings it back. Minimized terminals keep their sessions alive and resurface from the Coordination panel or the ⚠ attention badge.
- **Workspaces** — independent floors of terminals (Alt+↑/↓ to cycle), each with its own repos and coordination dir.
- **Usage battery** — a topbar meter for your Claude limits: session, week, and Fable week, with a click-open detail popover, manual ⟳ (a fresh probe session every time), and a 60 s auto-refresh toggle.
- **Phone floor view** — a token-guarded HTTP view of the floor (e.g. over Tailscale) to check terminals, fire off spawns, and talk (type or dictate) directly into a live session from your phone; voice input needs an HTTPS URL, so run `tailscale serve` once.
- **Journal tiles** — dictate/type a journal entry in a tile; optionally convert it into a Linear issue via your configured team.
- **Agent chat** — pull two or more terminals into a group chat you can message (hidden by default; see `terminals-grid.ts`).

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Alt+F1…F12 / letters | Jump to that terminal (badges show while Alt is held) |
| Alt+←/→ | Step the spotlight across tiles (incl. the equal-grid stop) |
| Alt+L | Lock/unlock the centered terminal in place |
| Alt+K | Open/focus Kane |
| Alt+↑/↓ | Switch workspace |

## Build from source

```bash
npm install
npm start          # build + launch
npm test           # unit tests
npm run dist       # build a Windows installer (release/)
npm run install-local   # install/refresh it as a Windows app (see below)
```

Requires Node 18+ and Git on PATH. Claude Code (`claude`) must be installed and on PATH.

### Install as an app

`npm run install-local` builds the app, packages a Windows installer, and silently
(re)installs it per-user — Start Menu entry included, without ever opening the app
(launch it from the Start Menu when you want it). Rerun it any time to refresh the
installed copy with your latest code. If a `private/` overlay is present it is
compiled in; those installers go to the gitignored `release-private/` (separate from
public `release/` artifacts) and are meant to stay on your machine.

The installed app still resolves `node.exe`, `git`, and `claude` from PATH at runtime.

### Troubleshooting

- **`Error: Electron failed to install correctly`** — on Windows + Node 24, Electron's
  installer downloads the runtime but its `extract-zip` step fails silently. A
  `postinstall` (`scripts/fix-electron.mjs`) re-extracts it with `Expand-Archive`
  automatically; if you still hit it, run `node scripts/fix-electron.mjs` (or
  `node node_modules/electron/install.js`) manually.

## Private extensions

The build looks for an optional, gitignored `private/` folder at the repo root. If
`private/index.ts` exists, it is compiled into the app and its exported
`registerPrivateFeatures(api)` runs once at startup; otherwise the no-op stub
`src/private-stub.ts` is used. This lets you keep personal features in a separate
private repo cloned at `private/`, with full TypeScript access to `src/`, without
forking. The hook's surface is defined in `src/private-api.ts` — including a per-workspace
session-env provider (e.g. to point sessions at another `CLAUDE_CONFIG_DIR` profile) and
hooks to restart the usage probe or every live session in chosen workspaces.

`npm run dist` refuses to package installers while `private/` is present (set
`WCC_ALLOW_PRIVATE_DIST=1` to include the overlay deliberately).

## License

MIT © Ronald Fridlyand
