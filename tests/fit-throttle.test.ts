import { describe, it, expect, vi } from 'vitest';
import { FitThrottle } from '../src/terminals/fit-throttle';

/** A FitThrottle wired to a manual timer so debounce is deterministic in tests. */
function harness(getDims: () => { cols: number; rows: number }, fitImpl?: () => void) {
  let pending: (() => void) | null = null;
  let id = 0;
  const fit = vi.fn(fitImpl ?? (() => {}));
  const resize = vi.fn();
  const setTimer = vi.fn((cb: () => void) => { pending = cb; return ++id; });
  const clearTimer = vi.fn(() => { pending = null; });
  const t = new FitThrottle({ fit, dims: getDims, resize, setTimer, clearTimer, delayMs: 100 });
  const flush = () => { const p = pending; if (p) { pending = null; p(); } };
  const isPending = () => pending !== null;
  return { t, fit, resize, setTimer, clearTimer, flush, isPending };
}

describe('FitThrottle', () => {
  it('coalesces a burst of schedule() calls into a single fit + resize', () => {
    const h = harness(() => ({ cols: 80, rows: 24 }));
    h.t.schedule(); h.t.schedule(); h.t.schedule();
    expect(h.clearTimer).toHaveBeenCalledTimes(2); // each reschedule cancels the prior timer
    expect(h.fit).not.toHaveBeenCalled();          // nothing runs until the timer fires
    h.flush();
    expect(h.fit).toHaveBeenCalledTimes(1);
    expect(h.resize).toHaveBeenCalledTimes(1);
    expect(h.resize).toHaveBeenCalledWith(80, 24);
  });

  it('skips the pty resize when dimensions are unchanged (dedupe)', () => {
    const dims = { cols: 80, rows: 24 };
    const h = harness(() => dims);
    h.t.schedule(); h.flush();           // first settle → resize
    h.t.schedule(); h.flush();           // same dims → no resize
    expect(h.resize).toHaveBeenCalledTimes(1);
    dims.cols = 100;
    h.t.schedule(); h.flush();           // changed → resize again
    expect(h.resize).toHaveBeenCalledTimes(2);
    expect(h.resize).toHaveBeenLastCalledWith(100, 24);
  });

  it('never resizes to a zero/invalid size, but still fits', () => {
    const h = harness(() => ({ cols: 0, rows: 0 }));
    h.t.schedule(); h.flush();
    expect(h.fit).toHaveBeenCalledTimes(1);
    expect(h.resize).not.toHaveBeenCalled();
  });

  it('swallows fit errors (terminal not visible yet) without resizing', () => {
    const h = harness(() => ({ cols: 80, rows: 24 }), () => { throw new Error('not visible'); });
    expect(() => { h.t.schedule(); h.flush(); }).not.toThrow();
    expect(h.resize).not.toHaveBeenCalled();
  });

  it('dispose cancels a pending fit', () => {
    const h = harness(() => ({ cols: 80, rows: 24 }));
    h.t.schedule();
    h.t.dispose();
    expect(h.clearTimer).toHaveBeenCalled();
    h.flush();
    expect(h.fit).not.toHaveBeenCalled();
  });
});
