# Browser remote over Tailscale — design

Date: 2026-09-07
Status: approved in chat, ready for an implementation plan

## Goal

Drive Worktree Command Center from any computer on the tailnet, in a browser tab.
Same tiles, same Kane, same spawn and workspace controls. The desktop app stays
running at home and remains the owner of every terminal. The browser is a mirror
that can also type.

Origin: ported from The Spire's remote-access subsystem
(`E:\Projects\PERSONAL\the-spire`, `src/main/remote/*`, `src/renderer/src/remote/*`),
reduced to LAN mode, no relay, no email codes.

## Decisions already made

| Question | Decision |
| --- | --- |
| Full app or better phone page | Full app in a browser |
| Login | Tailscale + one password + 30-day device token. No email code. |
| Architecture | **Way B**: desktop renderer stays the terminal owner; main runs the server; browser is a mirror driven by desktop state |
| Password hashing | scrypt (Node builtin). No native dependency. |
| Bind address | 127.0.0.1 + Tailscale IP only. Never LAN. |
| Terminal size | Browser follows the desktop's PTY size. Browser never resizes the PTY. |
| Old phone page | Kept, moved to `/phone`, unchanged behaviour and token scheme |
| Device list/revoke from the browser | Not exposed; desktop-only (matches The Spire) |
| Alt+F4 in the browser | Not remappable (closes the tab on Windows); click or Alt+←/→ instead |

## Why Way B

In The Spire, main owns the PTYs and keeps scrollback, so the same renderer bundle
runs in Electron and in a browser. In this app the **renderer** spawns the
`pty-sidecar` processes, keeps xterm scrollback, and touches `fs` /
`child_process` in about 15 modules (`terminal-tile`, `terminals-grid`,
`session-bridge`, `journal-store`, `board-view`, `chat-room`, `god-console`,
`session-purge`, `perf-monitor`, `worktree-manager`, `format-probe`,
`linear-convert-probe`, `workspace`, `app`). Main knows nothing about terminals.

Moving PTY ownership into main (Way A) is a week of refactor before anything is
visible. Way B keeps ownership where it is and adds three seams:

1. a tap on tile output with a replay buffer,
2. a generic main ↔ renderer RPC,
3. a small browser entry that renders from desktop-published state.

## Part 1 — Server and login

### Server (`electron/remote/gateway.ts`)

- Started once from `createWindow()` in `electron/main.ts`. Replaces
  `startRemoteServer()`; the old `MOBILE_HTML` page is served at `/phone` by the
  new server with its existing `?t=` token guard. `remote.json` keeps being
  written for local consumers.
- Port `7420` (existing constant). Two `http.Server` listeners on the same
  port: `127.0.0.1` and the Tailscale IP from `pickHosts()` /
  `isTailscaleIp()` (`electron/remote-net.ts`). If no Tailscale IP is found at
  start, bind loopback only and toast "Remote: Tailscale not found, local only".
  Re-check the Tailscale IP every 60 s and add the listener when it appears.
- Routes:
  - `GET /` and any extension-less path → `web/index.html` (SPA).
  - `GET /web/*` → static files from `dist/web/` with path confinement
    (`resolve` + `relative`, reject `..` and absolute).
  - `GET /phone` and `/api/*` → the existing phone handlers, unchanged.
  - `GET /ws` → WebSocket upgrade (`ws`, `noServer: true`), `maxPayload` 16 MiB.
  - Anything else → 404.
- Security headers on every response: CSP (`default-src 'self'; connect-src
  'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'`),
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Origin guard on upgrade: if an `Origin` header is present, its host must equal
  the `Host` header.
- Per-socket state: `authed`, `deviceId`, `lastSeen`, `authAttempts`,
  `unauthedFrames`. Unauthenticated sockets get 120 frames max, then close.
- Heartbeat sweep every 15 s; terminate sockets silent > 60 s.
- Fan-out: `event` frames go to authed sockets only. A socket with
  `bufferedAmount` > 4 MB is closed with code 4008; the browser reconnects and
  repaints.

### Wire protocol (`electron/remote/protocol.ts`, zero imports)

```ts
// browser -> main
{ t:'invoke', id:string, channel:string, payload?:unknown }
{ t:'auth', password?:string, deviceToken?:string, deviceLabel?:string }
{ t:'ping' }
// main -> browser
{ t:'reply', id, ok:true, value:unknown } | { t:'reply', id, ok:false, error:string }
{ t:'event', channel:string, payload:unknown }
{ t:'auth', ok:boolean, deviceToken?:string, deviceId?:string, error?:string }
{ t:'pong' }
```

`parseClientFrame()` returns `null` for anything malformed; the gateway drops it.

### Auth (`electron/remote/auth.ts`)

- Store: `app.getPath('userData')/remote-auth.json`, owned by main only:
  `{ passwordHash: string|null, devices: Array<{id,label,tokenHash,createdAt,lastSeen}> }`.
  Written atomically (tmp + rename). Missing or corrupt file = no password set.
- Password: min 12 chars. Hash = scrypt, N=2^17, r=8, p=1, 64-byte key, params
  encoded in the stored string. Verify with `timingSafeEqual`; corrupt hash
  fails closed. At most 2 concurrent KDF runs, 32 queued; overflow answers the
  rate-limit error and is not counted as a failure.
- Flow: `auth{password}` → verify → mint token `randomBytes(32).hex`, store
  `sha256(token)`, reply `{ok:true, deviceToken, deviceId}`. `auth{deviceToken}`
  → hash compare in constant time → 30-day **sliding** expiry on `lastSeen`.
- Lockout: per IP, 5 failures → 15 min. Also account-wide: 20 failures in
  15 min → 15 min cool-off.
- Revoke: `remote:devices:revoke {id}` removes the device and closes its live
  sockets with `{t:'auth',ok:false,error:'device revoked'}` then code 4009.
  `remote:password:set` (desktop only) signs every device out.
- No password set → every `auth` frame answers `{ok:false,error:'no password
  set'}`; the browser shows "set a password in the desktop app first".

### Desktop UI

The existing 📱 panel (`src/app.ts` around `remoteInfo()`) gains: Set/Change
password (uses `promptForTopic`-style dialog), the browser URLs
(`http://<tailscale-ip>:7420/` and the `https://<magicdns>/` one when
`tailscale serve` handles 7420), and a device list with Revoke buttons.

New `window.wcc` functions: `remotePasswordSet(pw)`, `remoteDevices()`,
`remoteDeviceRevoke(id)`.

## Part 2 — Terminal mirroring

### Tap and replay buffer (renderer)

- `src/terminals/replay-buffer.ts`: ring of chunks capped at 2,000,000 chars.
  Drops oldest chunks; slices a single oversized chunk. `push(chunk)`,
  `snapshot(): string`, `clear()`.
- `src/terminals/remote-tap.ts`: one instance per grid. `attach(tileId, bridge)`
  hooks `SessionBridge.onData` before `TerminalTile.writeOut`. Every chunk goes
  to the tile's replay buffer. When `clientCount > 0` chunks are batched for
  16 ms per tile and sent as one `remote:event {channel:'tile:data',
  payload:{workspaceId, id, chunk}}`. When `clientCount === 0` nothing is sent.
  `detach(tileId)` on tile close emits `tile:exit` and drops the buffer.
- Restart marker: when a tile restarts, push `\r\n— restarted —\r\n` into the
  buffer and emit it, so both screens agree.

### Main ↔ desktop renderer RPC (`electron/remote/renderer-rpc.ts`)

- Main → renderer: `webContents.send('remote:invoke', {id, channel, payload})`.
  Renderer → main: `ipcRenderer.send('remote:reply', {id, ok, value|error})`.
  Renderer → main pushes: `ipcRenderer.send('remote:event', {channel, payload})`.
  Main → renderer: `remote:clients {count}` whenever the authed socket count
  changes.
- 10 s timeout per invoke → browser gets `'request failed'`. Renderer reload or
  close rejects all pending.
- Preload adds: `onRemoteInvoke(cb)`, `remoteReply(r)`, `remoteEvent(e)`,
  `onRemoteClients(cb)`.

### Handler table (main)

One table, `channel → handler`, mirrors The Spire's `createHandlers()`. Two
kinds of entry:

- **Local** (main answers): `config:get`, `clipboard:read`, `clipboard:write`,
  `cmd:run` (worker thread, same as desktop), `remote:devices`,
  `remote:devices:revoke`.
- **Forwarded** to the desktop renderer via RPC: `floor:state`,
  `tile:snapshot {id}`, `tile:write {id, data}`, `tile:center {id}`,
  `tile:spawn {repo, base, task, model, effort, name}`, `tile:rename {id,name}`,
  `tile:hide {id}`, `tile:show {id}`, `tile:kill {id}`, `kane:write {data}`,
  `workspace:switch {id}`, `board:get`.

Blocked from the browser entirely (never forwarded): `config:set`, `addFolder`,
`paths`, `remote:password:set`.

Every forwarded `tile:*` payload is validated in main (`id` is a non-negative
integer or `KANE_ID`, strings length-capped) before it goes over IPC, following
`electron/remote-actions.ts`. `tile:write` is raw; the phone's `name`-must-match
rule does **not** apply to browser writes because the browser holds live state
from `floor:state` events, not a 2 s poll. The phone path keeps its rule.

### Browser terminal lifecycle

1. Tile appears in `floor:state` → browser creates an xterm with `cols`/`rows`
   from the state (desktop's PTY size), `scrollback: 5000`, WebGL with DOM
   fallback, exactly as `terminal-tile.ts` does.
2. Invoke `tile:snapshot` → `term.write(snapshot)` → **then** subscribe to
   `tile:data` for that id. Snapshot-then-subscribe; no `seeded` flag.
3. On bridge status `open` after a drop: `term.reset()`, re-fetch snapshot,
   write it, keep the subscription. Desktop-side `floor:state` is re-fetched
   too.
4. `term.onData(d => invoke('tile:write', {id, data: d}))`. Same `isUserInput`
   filter as the desktop so focus/DSR replies are not forwarded.
5. Browser never calls resize. If the browser viewport is smaller than the
   PTY, the tile scrolls; if larger, it is letterboxed.

## Part 3 — Browser app

### Build (`esbuild.config.mjs`)

Fourth bundle: `src/web/main.ts` → `dist/web/app.js`, `platform: 'browser'`,
`format: 'iife'`, no externals, `define: { 'process.env.NODE_ENV': '"production"' }`.
Copies `app.css`, `styles.css`, `dist/xterm.css` and `web/index.html` to
`dist/web/`. `electron-builder` `files` gains `dist/web/**` and `web/**`.

Pure modules reused unchanged: `bubble-layout`, `focus-decider`,
`pane-geometry`, `theme-store`, `dom-shim`, `hidden-buffer`, `fit-throttle`,
`scroll-keys`, `links` (browser branch), `attention`, `prompt-detect`, and
`electron/remote/protocol.ts`. Any module that imports `fs`, `path`, `os`,
`child_process` or `electron` must not be imported by `src/web/*`; the build
fails loudly if one leaks in (esbuild resolves them to nothing under
`platform: 'browser'`).

### Files

- `web/index.html` — shell: login root, floor root, one classic `<script>`.
- `src/web/bridge.ts` — `window.wcc`-shaped client over WebSocket. Ported from
  The Spire's `bridge.ts`: monotonic ids, `pending` map, 30 s invoke timeout,
  offline queue (cap 100, never replays in-flight invokes), ping 20 s, 3 missed
  pongs = dead, backoff 1 s → 60 s, backoff resets on **auth success** not
  socket open, `visibilitychange` forces reconnect, status listeners
  (`connecting | login | open`).
- `src/web/login.ts` — password field, "remember this device" checkbox
  (localStorage vs sessionStorage, exactly one), device label guessed from UA,
  allow-listed error copy.
- `src/web/floor.ts` — renders tiles from `FloorState` with `bubble-layout` +
  `focus-decider`; tile chrome (name, repo, branch, state pill, Minimize,
  Restore, Kill, Rename), toolbar (spawn form with model/effort, workspace
  bar, usage meter), Kane dock (Alt+K), coordination panel from `board:get`.
- `src/web/main.ts` — `installDomShim()`, theme from state, mount login →
  bridge → floor.

### `FloorState` (published by the desktop)

Extends the existing `FloorSnapshot` (`terminals-grid.ts`): every tile gains
`cols`, `rows`, `model`, `effort`, `pid?`; add `theme`, `usage` (parsed battery
values), `board` summary, `kane: {…, cols, rows}`. Published as
`remote:event {channel:'floor:state'}` on every grid mutation (spawn, exit,
rename, hide/show, center, workspace switch, state change), debounced 100 ms.
The 2 s timer that feeds the phone page keeps running and reuses the same
builder.

### Keyboard

Same bindings as the desktop: Alt+F1…F12 / letters jump, Alt+←/→ step,
Alt+L lock, Alt+K Kane, Alt+↑/↓ workspace. Ctrl+1..9 is not stolen in the
browser.

### Out of scope for v1

Journal tiles, ports widget, perf monitor, peek pane, agent chat, the private
overlay, file-path links opening files, Linear conversion, usage-probe restart,
browser-driven PTY resize.

## Part 4 — Errors and tests

### Error handling

- Malformed frames dropped; unknown channel → `'unknown channel'`;
  unauthenticated invoke → `'unauthenticated'` (browser flips to login);
  blocked channel → `'channel not available remotely'`; handler throw →
  `'request failed'`. Never `String(err)`.
- RPC timeout (10 s) or renderer gone → `'request failed'`.
- Slow consumer (> 4 MB buffered) → close 4008 → reconnect → snapshot repaint.
- Replay buffer overflow is silent (oldest dropped); the browser's next
  snapshot is simply shorter.
- Server bind failure (port busy) → toast, app keeps running, `remote.json`
  not written.

### Tests (vitest, node environment, no DOM — matches the repo)

| File | Covers |
| --- | --- |
| `tests/remote-protocol.test.ts` | every frame type, malformed JSON, arrays, missing fields, blocked channel set |
| `tests/remote-auth.test.ts` | scrypt hash/verify, params travel with hash, corrupt hash fails closed, password step, device token issue/verify/sliding expiry/prune, per-IP and account-wide lockout, revoke closes live sessions, no-password state, atomic file write |
| `tests/remote-gateway.test.ts` | routes (`/`, `/web/*` confinement incl. `/C:/…`, `/phone`, `/api/*`, 404), bind hosts from `pickHosts`, Origin guard, unauthed frame budget, auth rate limit, fan-out to authed only, backpressure close 4008, heartbeat sweep, security headers, fixed-string errors |
| `tests/renderer-rpc.test.ts` | invoke/reply correlation, 10 s timeout, reject-all on renderer gone, clients count broadcast |
| `tests/replay-buffer.test.ts` | cap, shift, oversized chunk slice, clear |
| `tests/remote-tap.test.ts` | 16 ms batching, silent when 0 clients, buffer always fills, restart marker, detach emits exit |
| `tests/web-bridge.test.ts` | fake WebSocket: correlation, offline queue bounds, in-flight rejected not replayed, auth handshake, token storage single-location, backoff resets on auth, visibility reconnect, `'unauthenticated'` → login |
| `tests/floor-state.test.ts` | builder includes cols/rows/model/effort/theme/usage, debounce, phone snapshot still equals the old shape |
| `tests/remote-actions.test.ts` | unchanged; plus validation of the new `tile:*` payloads |

## Implementation order (for the plan)

1. `protocol.ts`, `replay-buffer.ts`, tests.
2. `auth.ts` + `remote-auth.json`, tests.
3. `gateway.ts` (serve, ws, auth gate, fan-out, `/phone` passthrough), tests;
   wire into `main.ts`.
4. `renderer-rpc.ts` + preload channels + handler table, tests.
5. `remote-tap.ts` + `terminal-tile.ts` tap point + `FloorState` builder +
   grid RPC handlers, tests.
6. esbuild fourth bundle + `web/index.html` + `bridge.ts` + `login.ts`.
7. `floor.ts` (tiles, snapshot-then-subscribe, actions, keyboard, Kane).
8. Desktop 📱 panel: password, URLs, devices.
9. Smoke: open from a second tailnet machine, type into a tile, spawn, switch
   workspace, revoke a device, reconnect after sleep.
