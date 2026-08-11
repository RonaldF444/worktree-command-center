import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Autosave } from '../src/terminals/autosave';

describe('Autosave', () => {
  let saves: number;
  let a: Autosave;

  beforeEach(() => {
    vi.useFakeTimers();
    saves = 0;
    a = new Autosave(() => { saves++; }, { idleMs: 1000, maxMs: 10000 });
  });
  afterEach(() => vi.useRealTimers());

  it('saves after idleMs of quiet', () => {
    a.schedule();
    vi.advanceTimersByTime(999);
    expect(saves).toBe(0);
    vi.advanceTimersByTime(1);
    expect(saves).toBe(1);
  });

  it('a new keystroke inside the idle window resets the timer', () => {
    a.schedule();
    vi.advanceTimersByTime(600);
    a.schedule();
    vi.advanceTimersByTime(600); // 1200ms since first, only 600 since last
    expect(saves).toBe(0);
    vi.advanceTimersByTime(400);
    expect(saves).toBe(1);
  });

  it('continuous typing still saves by maxMs', () => {
    for (let t = 0; t < 10500; t += 500) {
      a.schedule();
      vi.advanceTimersByTime(500);
    }
    expect(saves).toBeGreaterThanOrEqual(1);
  });

  it('flush saves a pending change immediately', () => {
    a.schedule();
    a.flush();
    expect(saves).toBe(1);
    a.flush(); // nothing pending — must not double-save
    expect(saves).toBe(1);
  });

  it('cancel discards a pending change', () => {
    a.schedule();
    a.cancel();
    vi.advanceTimersByTime(60000);
    expect(saves).toBe(0);
  });

  it('each save starts a fresh idle/max cycle', () => {
    a.schedule();
    vi.advanceTimersByTime(1000);
    expect(saves).toBe(1);
    a.schedule();
    vi.advanceTimersByTime(1000);
    expect(saves).toBe(2);
  });
});
