'use strict';
// IO layer: atomic per-resource locks + append-only board. Fails by throwing;
// callers (cli/hook) decide fail-open. Uses coord-core for slug/status/format.
const fs = require('fs');
const path = require('path');
const core = require('./coord-core.cjs');

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function locksDir(dir) { return path.join(dir, 'locks'); }
function lockPath(dir, resource) { return path.join(locksDir(dir), core.slug(resource) + '.json'); }

function ensureDir(dir) { fs.mkdirSync(locksDir(dir), { recursive: true }); }

function appendBoard(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'board.md'), core.formatBoardLine(event), 'utf8');
}

function readHolder(dir, resource) {
  try { return JSON.parse(fs.readFileSync(lockPath(dir, resource), 'utf8')); }
  catch { return null; }
}

function readLocks(dir) {
  let names = [];
  try { names = fs.readdirSync(locksDir(dir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(locksDir(dir), n), 'utf8'))); } catch { /* skip bad */ }
  }
  return out;
}

// holder: { holderId, terminal }. opts: { reason, ttlMs, waitMs, pollMs, now }.
// NOTE: deadline uses real wall-clock Date.now() so the loop terminates even when
// opts.now is a fixed test value (stamp() is frozen, but wall-clock always advances).
function acquire(dir, resource, holder, opts = {}) {
  ensureDir(dir);
  const now = opts.now != null ? opts.now : Date.now();
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : core.CLI_TTL_MS;
  const waitMs = opts.waitMs != null ? opts.waitMs : core.WAIT_MS;
  const pollMs = opts.pollMs != null ? opts.pollMs : core.POLL_MS;
  const file = lockPath(dir, resource);
  // stamp() returns fixed test value when opts.now provided, else live time.
  // Used for lock timestamps and staleness math.
  const stamp = () => (opts.now != null ? opts.now : Date.now());
  const payload = () => JSON.stringify({
    resource, holder: holder.terminal, holderId: holder.holderId,
    reason: opts.reason || '', pid: process.pid, ts: stamp(), ttlMs,
  });
  // Deadline is always real wall-clock so the loop terminates even with fixed opts.now.
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, payload(), { flag: 'wx' });
      appendBoard(dir, { ts: stamp(), terminal: holder.terminal, resource, status: 'START', detail: opts.reason || '-' });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readHolder(dir, resource);
      if (core.lockStatus(cur, stamp()) === 'stale') {
        try { fs.unlinkSync(file); } catch { /* race: someone else took it */ }
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, holder: cur };
      sleepSync(pollMs);
    }
  }
}

function release(dir, resource, holderId) {
  const cur = readHolder(dir, resource);
  if (!cur || cur.holderId !== holderId) return false;
  try { fs.unlinkSync(lockPath(dir, resource)); } catch { /* already gone */ }
  appendBoard(dir, { ts: Date.now(), terminal: cur.holder, resource, status: 'DONE', detail: cur.reason || '-' });
  return true;
}

function note(dir, terminal, message) {
  appendBoard(dir, { ts: Date.now(), terminal, resource: '-', status: 'NOTE', detail: message });
}

function appendChat(dir, terminal, message) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'chat.md'), core.formatChatLine({ ts: Date.now(), terminal, message }), 'utf8');
}

// GOD-only: drop one message for a worker terminal. Atomic temp-file + rename so the
// renderer's outbox watcher never reads a half-written file. One file per message.
function tell(dir, target, message) {
  const outbox = path.join(dir, 'god-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const final = path.join(outbox, `${ts}-${rand}.json`);
  const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ts, target, message }), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}

module.exports = { acquire, release, readLocks, readHolder, appendBoard, note, appendChat, tell, sleepSync };
