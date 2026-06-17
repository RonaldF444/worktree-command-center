import { describe, it, expect } from 'vitest';
import { looksLikeMenu, looksErrored } from '../src/terminals/prompt-detect';

describe('looksLikeMenu', () => {
  // The real footer Claude Code renders under a single- or multi-select menu.
  const footer = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

  it('detects an interactive selection menu by its navigation footer', () => {
    expect(looksLikeMenu(`1. [ ] Time dropdown too long\n2. [ ] Date + time feel disjointed\n\n${footer}`)).toBe(true);
  });

  it('detects each navigation-hint phrase on its own', () => {
    expect(looksLikeMenu('use ↑/↓ to navigate the list')).toBe(true);
    expect(looksLikeMenu('press Esc to cancel')).toBe(true);
    expect(looksLikeMenu('Enter to select')).toBe(true);
    expect(looksLikeMenu('enter to toggle')).toBe(true);
  });

  it('does NOT fire on normal output or prose that merely says "navigate"', () => {
    expect(looksLikeMenu('Running the eval now, this will take a bit.')).toBe(false);
    expect(looksLikeMenu('let me navigate to the src directory and read the file')).toBe(false);
    expect(looksLikeMenu('Done. Results saved to ab_results/run.log')).toBe(false);
    expect(looksLikeMenu('')).toBe(false);
  });
});

describe('looksErrored', () => {
  it('fires on common failure markers', () => {
    expect(looksErrored('Traceback (most recent call last):')).toBe(true);
    expect(looksErrored('Error: ENOENT: no such file')).toBe(true);
    expect(looksErrored('✗ 3 tests failed')).toBe(true);
    expect(looksErrored("'claude' is not recognized as a command")).toBe(true);
    expect(looksErrored('process exited with code 1')).toBe(true);
  });
  it('does not fire on normal output or empty', () => {
    expect(looksErrored('Done. Results saved to run.log')).toBe(false);
    expect(looksErrored('Running the build now…')).toBe(false);
    expect(looksErrored('')).toBe(false);
  });
});
