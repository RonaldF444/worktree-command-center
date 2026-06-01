import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../pty-sidecar/coord-core.cjs');

describe('parseGitOp', () => {
  it('detects push and worktree add, including -C and cd prefixes', () => {
    expect(core.parseGitOp('git push')).toBe('push');
    expect(core.parseGitOp('git -C /a/b push origin main')).toBe('push');
    expect(core.parseGitOp('cd /y && git worktree add ../wt -b x main')).toBe('worktree-add');
    expect(core.parseGitOp('git commit -m hi')).toBeNull();
    expect(core.parseGitOp('ls -la')).toBeNull();
  });
});

describe('slug / baseName / gitResource', () => {
  it('slugs resource names', () => {
    expect(core.slug('paper-trader:db')).toBe('paper-trader-db');
    expect(core.slug('  ')).toBe('unnamed');
  });
  it('derives the git resource from the target repo', () => {
    expect(core.gitResource('push', 'git push', '/repo/foo')).toBe('push:foo');
    expect(core.gitResource('worktree-add', 'git -C "C:/x/MyRepo" worktree add z', '/repo/foo')).toBe('worktree:MyRepo');
  });
});

describe('lockStatus', () => {
  it('is free/held/stale around ts + ttlMs', () => {
    expect(core.lockStatus(null, 100)).toBe('free');
    expect(core.lockStatus({ ts: 0, ttlMs: 1000 }, 999)).toBe('held');
    expect(core.lockStatus({ ts: 0, ttlMs: 1000 }, 1001)).toBe('stale');
  });
});

describe('board line round-trip', () => {
  it('formats and parses a structured event', () => {
    const e = { ts: 123, terminal: 'termA', resource: 'paper-trader:db', status: 'START', detail: 'A/B replay' };
    const line = core.formatBoardLine(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(core.parseBoardLine(line)).toEqual(e);
  });
  it('keeps unstructured lines as raw and drops blanks', () => {
    expect(core.parseBoardLine('just some text')).toEqual({ raw: 'just some text' });
    expect(core.parseBoardLine('   ')).toBeNull();
  });
  it('mergeEvents sorts newest first', () => {
    const merged = core.mergeEvents([{ ts: 1 }, { ts: 3 }, { ts: 2 }]);
    expect(merged.map((e) => e.ts)).toEqual([3, 2, 1]);
  });
});
