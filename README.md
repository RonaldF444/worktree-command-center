# Worktree Command Center

Run many **Claude Code** sessions in parallel — each isolated in its own git
**worktree/branch**, tiled in one view — across whatever code folders you add.
Sessions coordinate through shared locks + a live board so they don't step on each
other, auto-save unfinished work, and can talk to each other (and you) in a group chat.

A standalone desktop app (Electron). Windows-first.

> **Status:** early / in development.

## What it does

- **Add a folder** — point it at a single repo or a parent dir; it discovers the git repos inside.
- **Worktree terminals** — each terminal runs in its own `git worktree` on its own branch, tiled with a bubbling/centering layout; idle terminals bubble to the front.
- **Coordination** — automatic locks on `git push` / `worktree add`, a live board of who's doing what, a registry of every worktree's unsaved work, and sibling-awareness injected into each session.
- **Park & reopen** — unfinished work is auto-saved as a recoverable commit when things close; one click brings it back.
- **Agent chat** — pull two or more terminals into a group chat you can message.

## Build from source

```bash
npm install
npm start          # build + launch
npm test           # unit tests
npm run dist       # build a Windows installer (release/)
```

Requires Node 18+ and Git on PATH. Claude Code (`claude`) must be installed and on PATH.

### Troubleshooting

- **`Error: Electron failed to install correctly`** — on Windows + Node 24, Electron's
  installer downloads the runtime but its `extract-zip` step fails silently. A
  `postinstall` (`scripts/fix-electron.mjs`) re-extracts it with `Expand-Archive`
  automatically; if you still hit it, run `node scripts/fix-electron.mjs` (or
  `node node_modules/electron/install.js`) manually.

## License

MIT © Ronald Fridlyand
