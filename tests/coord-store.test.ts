import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
const require = createRequire(import.meta.url);
const store = require('../pty-sidecar/coord-store.cjs');
const core = require('../pty-sidecar/coord-core.cjs');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-')); });

const holder = (id: number, name = `t${id}`) => ({ holderId: id, terminal: name });

describe('coord-store', () => {
  it('acquires a free resource, writes lock + START', () => {
    const r = store.acquire(dir, 'paper-trader:db', holder(1), { reason: 'replay', ttlMs: 1000, waitMs: 0, now: 1000 });
    expect(r.ok).toBe(true);
    const locks = store.readLocks(dir);
    expect(locks).toHaveLength(1);
    expect(locks[0].resource).toBe('paper-trader:db');
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8');
    expect(core.parseBoardLine(board.trim()).status).toBe('START');
  });

  it('a second holder waits then fails while the lock is fresh', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 60000, waitMs: 0, now: 1000 });
    const r = store.acquire(dir, 'r', holder(2), { ttlMs: 60000, waitMs: 30, pollMs: 10, now: 1000 });
    expect(r.ok).toBe(false);
    expect(r.holder.holderId).toBe(1);
  });

  it('steals a stale lock', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 1000, waitMs: 0, now: 1000 });
    const r = store.acquire(dir, 'r', holder(2), { ttlMs: 1000, waitMs: 0, now: 5000 });
    expect(r.ok).toBe(true);
    expect(store.readLocks(dir)[0].holderId).toBe(2);
  });

  it('release only by the holder; writes DONE', () => {
    store.acquire(dir, 'r', holder(1), { ttlMs: 60000, waitMs: 0, now: 1000 });
    expect(store.release(dir, 'r', 2)).toBe(false);
    expect(store.release(dir, 'r', 1)).toBe(true);
    expect(store.readLocks(dir)).toHaveLength(0);
    const board = fs.readFileSync(path.join(dir, 'board.md'), 'utf8').trim().split('\n');
    expect(core.parseBoardLine(board[board.length - 1]).status).toBe('DONE');
  });

  it('different resources never contend', () => {
    expect(store.acquire(dir, 'a', holder(1), { waitMs: 0, now: 1 }).ok).toBe(true);
    expect(store.acquire(dir, 'b', holder(2), { waitMs: 0, now: 1 }).ok).toBe(true);
  });

  it('tell writes one atomic JSON message into god-outbox', () => {
    const file = store.tell(dir, 'Improver 1', 'rebase please');
    expect(fs.existsSync(file)).toBe(true);
    const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(msg.target).toBe('Improver 1');
    expect(msg.message).toBe('rebase please');
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1); // no leftover .tmp
  });
});
