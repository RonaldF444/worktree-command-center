import { describe, it, expect, vi } from 'vitest';
import { ctrlClickActivator } from '../src/terminals/links';

const ev = (mods: { ctrlKey?: boolean; metaKey?: boolean }) => mods as unknown as MouseEvent;

describe('ctrlClickActivator', () => {
  it('opens the url only when Ctrl or Cmd is held', () => {
    const open = vi.fn();
    const activate = ctrlClickActivator(open);
    activate(ev({ ctrlKey: true }), 'http://localhost:5173');
    activate(ev({ metaKey: true }), 'http://localhost:5050');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, 'http://localhost:5173');
    expect(open).toHaveBeenNthCalledWith(2, 'http://localhost:5050');
  });

  it('does nothing on a plain click (so selection/click is unaffected)', () => {
    const open = vi.fn();
    ctrlClickActivator(open)(ev({}), 'http://localhost:3000');
    expect(open).not.toHaveBeenCalled();
  });
});
