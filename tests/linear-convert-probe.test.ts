import { describe, it, expect } from 'vitest';
import { buildProposePrompt, buildCreatePrompt, parseIssuesJson } from '../src/terminals/linear-convert-probe';

describe('buildProposePrompt', () => {
  it('references the note path and asks for a JSON array', () => {
    const p = buildProposePrompt('/tmp/n.md');
    expect(p).toContain('/tmp/n.md');
    expect(p).toContain('JSON array');
  });
});
describe('buildCreatePrompt', () => {
  it('references the issues path, the CJBrothers team, and its id', () => {
    const p = buildCreatePrompt('/tmp/i.json');
    expect(p).toContain('/tmp/i.json');
    expect(p).toContain('CJBrothers');
    expect(p).toContain('0c1d60eb-eb84-4cd2-8a8c-d7b0926b28d5');
  });
});
describe('parseIssuesJson', () => {
  it('extracts a well-formed array', () => {
    expect(parseIssuesJson('[{"title":"a","description":"b"}]')).toEqual([{ title: 'a', description: 'b' }]);
  });
  it('tolerates a json fence and a preamble', () => {
    expect(parseIssuesJson('Here are the issues:\n```json\n[{"title":"a"}]\n```')).toEqual([{ title: 'a' }]);
  });
  it('strips ANSI before parsing', () => {
    expect(parseIssuesJson('\x1b[2m[{"title":"a"}]\x1b[0m')).toEqual([{ title: 'a' }]);
  });
  it('returns [] for non-array / malformed / empty', () => {
    expect(parseIssuesJson('{"title":"a"}')).toEqual([]);
    expect(parseIssuesJson('not json')).toEqual([]);
    expect(parseIssuesJson('')).toEqual([]);
  });
});
