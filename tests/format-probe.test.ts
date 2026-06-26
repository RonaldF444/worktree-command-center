import { describe, it, expect } from 'vitest';
import { buildFormatPrompt, parseFormatOutput } from '../src/terminals/format-probe';

describe('buildFormatPrompt', () => {
  it('references the note file path and keeps the strict instruction', () => {
    const p = buildFormatPrompt('/tmp/cos-format-1.md');
    expect(p).toContain('Preserve every word');
    expect(p).toContain('/tmp/cos-format-1.md');
    expect(p).toContain('Read the note file at');
  });
});

describe('parseFormatOutput', () => {
  it('strips a wrapping code fence', () => {
    expect(parseFormatOutput('```\n- a\n  - b\n```')).toBe('- a\n  - b');
    expect(parseFormatOutput('```md\n- a\n```')).toBe('- a');
  });
  it('trims outer whitespace but keeps interior lines', () => {
    expect(parseFormatOutput('\n\n- a\n  - b\n\n')).toBe('- a\n  - b');
  });
  it('passes clean text through unchanged', () => {
    expect(parseFormatOutput('- a\n  - b')).toBe('- a\n  - b');
  });
  it('strips ANSI escape codes', () => {
    expect(parseFormatOutput('\x1b[2m- a\x1b[0m')).toBe('- a');
  });
});
