# Localhost port registry: one place for every dev server the terminals print

**Date:** 2026-08-14
**Status:** approved, ready for an implementation plan

Ten terminals each spawn dev servers, and each one announces itself with a `localhost` URL that
scrolls away seconds later. Finding the right one means hunting back through output; telling
`:3000` from `:3001` from `:5173` means remembering which worktree owns which port; and clicking
links as they fly past leaves a wall of browser tabs, most of them opened for a five-second
"did it render" check.

This adds a registry that watches every session's output for loopback URLs, and a topbar list
that shows them grouped by worktree. Clicking a row opens the real browser as today. A second
button peeks the page inside WCC, so the disposable checks never become tabs at all.

## What exists today

Nothing tracks URLs. `src/terminals/links.ts` knows how to *open* one — `openExternalUrl` hands
off to Electron's `shell.openExternal`, with a same-URL debounce — and xterm's WebLinksAddon
makes URLs Ctrl+clickable in the terminal where they were printed. Once a URL scrolls out of the
scrollback, it is gone.

Everything the registry needs is already in place, though:

- **A single output choke point.** `TerminalTile.writeOut()` (`terminal-tile.ts:360`) receives
  every byte of session output, for foreground *and* hidden tiles — `bridge.onData` is its only
  producer (`terminal-tile.ts:593`).
- **A cross-tile aggregation pattern.** `TerminalsGrid.attentionItems()`
  (`terminals-grid.ts:605`) maps over `allSessions()` — foreground plus hidden — and returns a
  classified snapshot.
- **A topbar-surface pattern.** `AttentionWidget` (`src/ui/attention-widget.ts`) is a badge plus
  dropdown that polls a provider every 1.5s, groups rows under headings, and calls back into
  `revealTile()` to jump to a terminal. `app.ts:170` wires it with a closure over the mutable
  `activeGrid`, so it always reads the active workspace.
- **A hardened webview host.** `webviewTag` is on (`electron/main.ts:47`), and
  `web-contents-created` (`main.ts:209`) already hardens every guest: `window.open` and
  `target=_blank` go to the real browser instead of spawning Electron windows, non-web protocols
  are dropped, and F11 / Ctrl+digit are mirrored back to the host.

## What changes

Four new modules and two test files, plus one hook in `TerminalTile`, one new grid method, and
one widget construction in `app.ts`.

### Capture — `src/terminals/port-scan.ts`

A pure module, matching how `links.ts`, `usage-parse.ts` and `prompt-detect.ts` are written and
tested. It exposes a small stateful scanner built from pure parts:

```ts
export interface PortHit { url: string; host: string; port: number; path: string; }
export function scanChunk(text: string): PortHit[];   // pure
export class PortScanner { feed(chunk: string): PortHit[]; }  // carries state across chunks
```

The scanner earns its keep on the messy details of pty output:

- **ANSI stripped before matching.** Vite, Next and friends colour their URLs, so SGR sequences
  land mid-URL.
- **OSC 8 hyperlinks read.** `ESC ]8;;<url> BEL <text> ESC ]8;; BEL` carries the URL in the
  escape payload; the visible text may be a label, not the URL. Both forms are matched, which is
  also why `links.ts` needed its `OPEN_DEDUPE_MS` guard — one cell can hold both.
- **Chunk boundaries carried.** A pty write can split a URL in half. The scanner retains the
  trailing 256 characters and prefixes the next chunk, then suppresses hits that fall entirely
  within the carried region so an overlap is not reported twice.
- **Trailing punctuation trimmed.** `see http://localhost:3000.` must not yield a URL ending in
  a period; likewise `)`, `,`, `"`, `'` and `]`.

Hosts are restricted to loopback and private LAN — `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`,
`10.*`, `192.168.*`, `172.16-31.*`. Public URLs are ignored; this is a dev-server list, not a
browser history. Both `http://host:port/path` and bare `localhost:5173` are matched, the latter
normalised to an `http://` URL. `0.0.0.0` normalises to `localhost` for opening, since a browser
cannot usefully navigate to `0.0.0.0`.

LAN addresses are kept rather than dropped: the "Network:" line vite prints is the one that
works from a phone, which matters given the existing phone-remote surface.

### Registry — `src/terminals/port-registry.ts`

One instance per `TerminalsGrid`, so each workspace has its own list — the same scoping attention
state already uses.

```ts
export interface PortEntry {
  key: string;        // normalised `host:port`
  url: string;        // last full URL seen for this key
  port: number;
  tileId: number;     // the terminal that most recently printed it
  firstSeenMs: number;
  lastSeenMs: number;
}

export class PortRegistry {
  note(tileId: number, hit: PortHit, nowMs: number): void;
  forget(tileId: number): void;
  list(): PortEntry[];
}
```

Entries are keyed on normalised `host:port`, collapsing `127.0.0.1:3000` and `localhost:3000`
into one row. **The newest printer owns the entry** — when a server is killed and another
worktree grabs the freed port, the row moves to the new owner instead of the list growing a
duplicate. The stored `url` is likewise the most recent one, so a path change is reflected.

The registry is **live-only and never persisted**. A URL dies with the terminal that printed it:
`forget(tileId)` runs when a tile closes. Persisting across restarts is exactly how the list would
grow back into the thousand-link pile this is meant to replace, and a stale entry is worse than an
absent one because it looks trustworthy.

Restart-in-place (`terminal-tile.ts:629`) deliberately does *not* forget. Killing the Claude
process rarely kills the dev server the agent spawned in the background, so the URL usually keeps
working; if it does not, the row disappears the next time the tile closes.

Capacity is capped at 200 entries, evicting by oldest `lastSeenMs`. `list()` returns entries
sorted by owning tile, then port, so the grouped rendering is stable frame to frame.

### Wiring

`TerminalTile` gains a `PortScanner` and calls it from the one hook:

```ts
private writeOut(d: string): void {
  for (const hit of this.ports.feed(d)) this.opts.onPortSeen?.(this.tileId, hit);
  // ...existing body
}
```

The tile reports hits through an optional callback rather than owning a registry, keeping the
tile ignorant of cross-tile state — the same shape as the existing `onReady` / `onClosed`
callbacks. The grid owns the registry, wires `onPortSeen`, calls `forget()` where it already
handles a closed tile, and exposes a snapshot next to `attentionItems()`:

```ts
portItems(): PortItem[]   // PortEntry + { name, repo } resolved via repoNameFor()
```

### Topbar surface — `src/ui/ports-widget.ts`

Structurally a sibling of `AttentionWidget`: a badge (`⇢ 6`) that opens a dropdown, a 1.5s poll,
a document-click listener to dismiss, and a `dispose()` hooked to `beforeunload`. It sits left of
the attention badge, and its count is the number of registry entries. Empty state reads
"No servers running".

Rows group under a **repo-name heading**, and each row names the **terminal** that owns it — the
two fields `portItems()` resolves, and the same pair the attention dropdown already renders.
`portItems()` sorts by repo, then tile, then port, so a repo's terminals stay contiguous and each
heading is emitted once. (The registry's own `list()` sorts by tile then port; repo is a
grid-level concept the registry cannot see.)

Each row shows port, path and owning terminal, and carries four actions:

| Action | Result |
|---|---|
| click | open in the real browser via `openExternalUrl` |
| `▣` | peek the page inside WCC |
| terminal name | `revealTile()` — un-hide or centre the tile that printed it |
| Ctrl+click | copy the URL |

`app.ts` constructs it beside the attention widget, closing over `activeGrid` the same way, so
switching workspace switches the list.

### Peek pane — `src/ui/peek-pane.ts`

A single reusable `<webview>` in an overlay docked to the right at 40% width, positioned *above*
the stage rather than splitting the layout — a real split would resize every tile and drive
xterm's fit path (`fit-throttle.ts`) on every open and close.

There is exactly one pane. Peeking a different row swaps `src` on the same webview, so peeking
cannot accumulate — the in-app equivalent of the tab wall is structurally impossible. The header
carries the URL, reload, "open in browser" (handing off to `openExternalUrl`, which is how a peek
graduates into a real tab), and close; Esc also closes. The guest inherits the existing
`web-contents-created` hardening, so a dev server that calls `window.open` still lands in Chrome.

## What this does not do

No liveness probing. Nothing pings the ports to grey out dead ones, because dead links were not
the reported pain and probing means either an HTTP request loop against every server every few
seconds, or a socket connect that some dev servers log as a spurious connection.

No process management — no kill button, no port-conflict resolution, no launching servers.

No history. Closing a terminal removes its rows, and closing WCC empties the registry.

## Testing

`tests/port-scan.test.ts` covers the scanner as a pure unit: coloured vite output, OSC 8
hyperlinks, a URL split across two `feed()` calls, no duplicate across the carry overlap,
trailing punctuation, bare `localhost:PORT`, `0.0.0.0` normalisation, public URLs rejected, LAN
addresses accepted.

`tests/port-registry.test.ts` covers behaviour that has to hold over time: loopback aliases
collapsing to one entry, a recycled port changing owner rather than duplicating, `forget(tileId)`
dropping exactly one tile's rows, LRU eviction at the cap, and stable sort order.

The widget and the pane stay hand-wired and untested, matching the existing split where
`attention.ts` has tests and `attention-widget.ts` does not.
