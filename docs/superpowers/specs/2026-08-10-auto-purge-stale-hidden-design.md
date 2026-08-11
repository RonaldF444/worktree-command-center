# Auto-purge stale hidden sessions — design

**Date:** 2026-08-10
**Why:** The default workspace accumulated ~47 persisted sessions. Every launch respawned all
of them (multi-second renderer stalls, workspace-switch freezes, one crash today). Hidden
sessions nobody has touched in days are pure cost.

## Rule

On every app boot, before any grid restores, sweep `.terminal-sessions.json` (all
workspaces): any entry with `kind === 'terminal'` AND `hidden === true` AND idle ≥ 5 days is
**purged** — session never spawns, entry removed, and its worktree + branch deleted via the
existing `removeWorktreeAndBranch` (× semantics, unconditional — user's explicit choice).

Exempt: journals, god console, chat, any visible tile. An entry whose `worktreePath` no
longer exists on disk is dropped from persistence (nothing to delete).

## Idle tracking

- New optional field on persisted entries: `lastActivity` (epoch ms). Live tiles hold it in
  memory; `persist()` reads it from the tile like every other field.
- Stamped on: user input to the tile; hide/unhide/center/reveal; PTY output — EXCEPT output
  in the first 2 minutes after spawn. That exception keeps `--continue` replay (which every
  relaunch produces) from resetting the clock, while a hidden session genuinely chattering
  (dev server) keeps refreshing itself and never purges.
- Backfill for entries without the field (first boot after upgrade): newest of worktree root
  mtime, `.git` file mtime, resolved gitdir `logs/HEAD`/`index`/`HEAD` mtimes, and last
  commit time (`git log -1 --format=%ct`). Probe failures → 0 → purge.

## Architecture

- `src/terminals/session-purge.ts` — pure decision module:
  `partitionStale(entries, now, probe)` → `{ keep, purge }`. `probe(worktreePath)` supplies
  the backfill timestamp; injected for tests. Constant `PURGE_AFTER_MS = 5 * 864e5`. No
  config UI (YAGNI).
- Boot integration in `app.ts`: after config load, before any `TerminalsGrid` is created:
  load sessions file → partition each workspace → for each purged entry, await
  `removeWorktreeAndBranch` (sequential; failures collected, entry dropped regardless — the
  perf win must not depend on disk cleanup succeeding) → write pruned file → toast
  `Auto-purged N hidden sessions (idle 5+ days)` (+ failure count if any).
- `TerminalTile`: add `lastActivity` tracking at the stamping points above; expose a getter;
  include in the record `persist()` writes.

## Error handling

- Worktree delete fails (OneDrive lock, etc.): entry still dropped, failure toasted once.
- Sessions file unreadable: sweep aborts, app boots normally (never brick startup).

## Testing

- `session-purge.test.ts`: fake clock + fake probe — hidden/old purges; visible/old kept;
  hidden/recent kept; journal/god kept; missing-field backfills via probe; probe failure
  purges; malformed entries kept (never destroy what we don't understand).
- Tile stamping: extend existing tile tests where feasible; replay-window exception unit
  tested with fake clock.

## First run

The 2026-08-10 manual prune already removed the 19-entry backlog, so the feature's first
sweep is small. Purge count is visible in the toast on every launch thereafter.
