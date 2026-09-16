import { describe, it, expect } from 'vitest';
import { scrollIntentForKey, scrollKeySequence } from '../src/terminals/scroll-keys';

describe('scrollIntentForKey', () => {
	it('ignores keys without Shift (Claude keeps plain nav keys)', () => {
		expect(scrollIntentForKey({ key: 'PageUp', shiftKey: false })).toBeNull();
		expect(scrollIntentForKey({ key: 'ArrowUp', shiftKey: false })).toBeNull();
		expect(scrollIntentForKey({ key: 'a', shiftKey: true })).toBeNull();
	});
	it('maps Shift+Page to page scroll, Shift+Arrow to line scroll', () => {
		expect(scrollIntentForKey({ key: 'PageUp', shiftKey: true })).toEqual({ kind: 'pages', amount: -1 });
		expect(scrollIntentForKey({ key: 'PageDown', shiftKey: true })).toEqual({ kind: 'pages', amount: 1 });
		expect(scrollIntentForKey({ key: 'ArrowUp', shiftKey: true })).toEqual({ kind: 'lines', amount: -3 });
		expect(scrollIntentForKey({ key: 'ArrowDown', shiftKey: true })).toEqual({ kind: 'lines', amount: 3 });
	});
	it('maps Shift+Home/End to jump to top/bottom', () => {
		expect(scrollIntentForKey({ key: 'Home', shiftKey: true })).toEqual({ kind: 'top' });
		expect(scrollIntentForKey({ key: 'End', shiftKey: true })).toEqual({ kind: 'bottom' });
	});
});

describe('scrollKeySequence — alternate-screen forwarding', () => {
	it('maps each intent to the key claude binds for that scroll', () => {
		// Shift+Up/Down -> ONE SGR wheel tick (scroll:lineUp/Down = CLAUDE_CODE_SCROLL_SPEED lines),
		// deliberately not a page.
		expect(scrollKeySequence({ kind: 'lines', amount: -3 })).toBe('\x1b[<64;1;1M');
		expect(scrollKeySequence({ kind: 'lines', amount: 3 })).toBe('\x1b[<65;1;1M');
		expect(scrollKeySequence({ kind: 'pages', amount: -1 })).toBe('\x1b[5~');   // PgUp
		expect(scrollKeySequence({ kind: 'pages', amount: 1 })).toBe('\x1b[6~');    // PgDn
		expect(scrollKeySequence({ kind: 'top' })).toBe('\x1b[1;5H');               // Ctrl+Home
		expect(scrollKeySequence({ kind: 'bottom' })).toBe('\x1b[1;5F');            // Ctrl+End
	});

	it('every intent scrollIntentForKey can produce has a sequence (desk and browser agree)', () => {
		for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
			const intent = scrollIntentForKey({ key, shiftKey: true });
			expect(intent).not.toBeNull();
			expect(scrollKeySequence(intent!)).toMatch(/^\x1b\[/);
		}
	});
});
