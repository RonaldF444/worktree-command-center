'use strict';
// cos-coord <status|acquire|release|note> — agents call this from Bash.
// Fail-open: unexpected errors exit 0 (allow). A timed-out acquire exits 1
// (the lock is working — the && chain should stop).
const core = require('./coord-core.cjs');
const store = require('./coord-store.cjs');

function env(name, dflt) { return process.env[name] != null ? process.env[name] : dflt; }
function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function ageStr(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`; }

function main() {
  const dir = env('COS_COORD_DIR');
  const terminal = env('COS_TERMINAL_NAME', `pid${process.pid}`);
  const holderId = Number(env('COS_TERMINAL_ID', String(process.pid)));
  if (!dir) { process.exit(0); } // coordination not configured → allow
  const [cmd, resource, ...rest] = process.argv.slice(2);

  if (cmd === 'status') {
    const now = Date.now();
    const locks = store.readLocks(dir);
    if (!locks.length) console.log('coord: no active locks');
    for (const l of locks) {
      const st = core.lockStatus(l, now);
      console.log(`coord: ${l.resource} — ${l.holder}${l.reason ? ` (${l.reason})` : ''} · ${ageStr(now - l.ts)}${st === 'stale' ? ' [stale]' : ''}`);
    }
    process.exit(0);
  }

  if (cmd === 'note') {
    store.note(dir, terminal, [resource, ...rest].filter(Boolean).join(' '));
    process.exit(0);
  }

  if (cmd === 'chat') {
    store.appendChat(dir, terminal, [resource, ...rest].filter(Boolean).join(' '));
    process.exit(0);
  }

  if (cmd === 'tell') {
    if (env('COS_ROLE') !== 'god') process.exit(0); // only GOD may inject into worker terminals
    const target = resource;
    const message = rest.join(' ');
    if (target && message) store.tell(dir, target, message);
    process.exit(0);
  }

  if (cmd === 'acquire') {
    const waitMs = Number(env('COS_COORD_WAIT_MS', String(core.WAIT_MS)));
    const ttlMs = flag(rest, '--ttl') ? Number(flag(rest, '--ttl')) * 1000 : core.CLI_TTL_MS;
    const reason = flag(rest, '--reason') || '';
    const r = store.acquire(dir, resource, { holderId, terminal }, { reason, ttlMs, waitMs });
    if (r.ok) { console.log(`coord: acquired ${resource}`); process.exit(0); }
    console.error(`coord: ${resource} held by ${r.holder ? r.holder.holder : '?'}${r.holder && r.holder.reason ? ` (${r.holder.reason})` : ''} — try again later`);
    process.exit(1);
  }

  if (cmd === 'release') {
    store.release(dir, resource, holderId);
    process.exit(0);
  }

  console.error('usage: cos-coord <status|acquire|release|note|chat|tell> [resource] [--reason "…"] [--ttl <sec>]');
  process.exit(0);
}

try { main(); } catch (e) { try { console.error('coord: ' + e.message); } catch (_) {} process.exit(0); }
