import { describe, it, expect } from 'vitest';
import {
  parseOutboxMessage, resolveTellTarget, slug,
  formatFloorSnapshot, formatFloorIndex, godSystemPrompt, EFFORT_LEVELS, remapWatchers, parseGodSelfImprove,
} from '../src/terminals/god';

describe('parseOutboxMessage', () => {
  it('parses a tell (and treats an untagged target+message as tell)', () => {
    expect(parseOutboxMessage('{"kind":"tell","target":"Improver 1","message":"rebase"}'))
      .toEqual({ kind: 'tell', target: 'Improver 1', message: 'rebase' });
    expect(parseOutboxMessage('{"ts":1,"target":"A","message":"hi"}'))
      .toEqual({ kind: 'tell', target: 'A', message: 'hi' });
  });
  it('parses a watch', () => {
    expect(parseOutboxMessage('{"kind":"watch","target":"A","note":"run tests"}'))
      .toEqual({ kind: 'watch', target: 'A', note: 'run tests' });
  });
  it('parses a spawn with and without a base', () => {
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","base":"main","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null });
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'do X', model: null, effort: null, name: null });
  });
  it('parses spawn model/effort/name, lowercasing effort and nulling junk', () => {
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"opus","effort":"MAX","name":"Linehaul"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: 'opus', effort: 'max', name: 'Linehaul' });
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"  ","effort":42,"name":" "}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: null, effort: null, name: null });
  });
  it('parses a rename and rejects blank fields', () => {
    expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"Linehaul fix"}'))
      .toEqual({ kind: 'rename', target: 'wt-1', name: 'Linehaul fix' });
    expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"  "}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"rename","target":"","name":"x"}')).toBeNull();
  });
  it('parses a personality toggle (no fields)', () => {
    expect(parseOutboxMessage('{"kind":"personality"}')).toEqual({ kind: 'personality' });
  });
  it('rejects malformed / missing fields', () => {
    expect(parseOutboxMessage('not json')).toBeNull();
    expect(parseOutboxMessage('{"kind":"tell","target":"A"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"watch","target":"  ","note":"x"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"bogus"}')).toBeNull();
  });
});

describe('resolveTellTarget', () => {
  it('matches exactly, then case-insensitively, else null', () => {
    expect(resolveTellTarget('A', ['A', 'B'])).toBe('A');
    expect(resolveTellTarget('improver 1', ['Improver 1', 'B'])).toBe('Improver 1');
    expect(resolveTellTarget('ghost', ['A', 'B'])).toBeNull();
  });
});

describe('slug', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slug('Improver 1')).toBe('improver-1');
    expect(slug('!!!')).toBe('unnamed');
  });
});

describe('formatFloorSnapshot', () => {
  it('renders a header block + fenced recent output', () => {
    const out = formatFloorSnapshot(
      { name: 'Improver 1', repo: 'app', branch: 'wt/main-1', worktreePath: '/w/1', ts: 0 },
      'building...\nok',
    );
    expect(out).toContain('# Improver 1');
    expect(out).toContain('- repo: app');
    expect(out).toContain('- branch: wt/main-1');
    expect(out).toContain('- worktree: /w/1');
    expect(out).toContain('1970-01-01T00:00:00.000Z');
    expect(out).toContain('building...\nok');
  });
});

describe('formatFloorIndex', () => {
  it('lists live terminals with their snapshot filenames', () => {
    const idx = formatFloorIndex([{ id: 2, name: 'Improver 1', repo: 'app', branch: 'wt/main-1' }]);
    expect(idx).toContain('**Improver 1**');
    expect(idx).toContain('2-improver-1.md');
  });
  it('says so when the floor is empty', () => {
    expect(formatFloorIndex([])).toContain('no terminals open');
  });
});

describe('godSystemPrompt', () => {
  const p = godSystemPrompt([{ name: 'app', path: '/repos/app' }], '/coord');
  it('states the non-autonomous overseer stance', () => {
    expect(p).toMatch(/do not run the floor/i);
    expect(p).toMatch(/user drives/i);
    expect(p).toMatch(/never start work|do not start work|only when asked|only on request/i);
  });
  it('tells GOD where to read the floor', () => {
    expect(p).toContain('/coord/floor/INDEX.md');
    expect(p).toContain('/coord/board.md');
    expect(p).toContain('/coord/worktrees.md');
  });
  it('documents cos-coord tell and lists repo paths', () => {
    expect(p).toContain('cos-coord tell');
    expect(p).toContain('/repos/app');
  });
  it('documents the watch, spawn, and rename commands', () => {
    expect(p).toContain('cos-coord watch');
    expect(p).toContain('cos-coord spawn');
    expect(p).toContain('--model');
    expect(p).toContain('--effort low|medium|high|xhigh|max|ultracode');
    expect(p).toContain('--name');
    expect(p).toContain('cos-coord rename');
  });
});

describe('godSystemPrompt self-improvement', () => {
  const repos = [{ name: 'app', path: '/repos/app' }];
  const si = { sourceRepo: 'C:\\dev\\wcc', toolsDir: 'C:\\dev\\kane-tools' };
  it('is absent when not configured', () => {
    expect(godSystemPrompt(repos, '/coord')).not.toContain('SELF-IMPROVEMENT');
  });
  it('names the source repo + tools dir and the guardrails when configured', () => {
    const p = godSystemPrompt(repos, '/coord', si);
    expect(p).toContain('SELF-IMPROVEMENT');
    expect(p).toContain('C:\\dev\\wcc');
    expect(p).toContain('C:\\dev\\kane-tools');
    expect(p).toMatch(/never `git push`/i);
    expect(p).toContain('install-local');
    expect(p).toMatch(/stance is UNCHANGED/);
  });
  it('keeps the overseer stance either way', () => {
    expect(godSystemPrompt(repos, '/coord', si)).toMatch(/do not run the floor/i);
  });
});

describe('parseGodSelfImprove', () => {
  it('accepts sourceRepo with optional toolsDir', () => {
    expect(parseGodSelfImprove({ sourceRepo: 'C:\\x' })).toEqual({ sourceRepo: 'C:\\x', toolsDir: null });
    expect(parseGodSelfImprove({ sourceRepo: 'C:\\x', toolsDir: 'C:\\t' })).toEqual({ sourceRepo: 'C:\\x', toolsDir: 'C:\\t' });
  });
  it('rejects junk without throwing', () => {
    expect(parseGodSelfImprove(undefined)).toBeUndefined();
    expect(parseGodSelfImprove('yes')).toBeUndefined();
    expect(parseGodSelfImprove({ toolsDir: 'C:\\t' })).toBeUndefined();
    expect(parseGodSelfImprove({ sourceRepo: '   ' })).toBeUndefined();
  });
});

describe('EFFORT_LEVELS', () => {
  it('lists the six claude CLI effort levels, ultracode last', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  });
});

describe('remapWatchers', () => {
  it('retargets only the renamed terminal, preserving notes', () => {
    const ws = [{ target: 'A', note: 'x' }, { target: 'B', note: 'y' }];
    expect(remapWatchers(ws, 'A', 'C')).toEqual([{ target: 'C', note: 'x' }, { target: 'B', note: 'y' }]);
    expect(remapWatchers(ws, 'Z', 'C')).toEqual(ws);
  });
});
