import { describe, it, expect } from 'vitest';
import { decideMouseDown, isDrag, type MouseSig } from '../src/terminals/drag-select';

const plain = (over: Partial<MouseSig> = {}): MouseSig => ({
	button: 0, detail: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over,
});

describe('decideMouseDown — plain-drag selection while the TUI tracks the mouse', () => {
	it('holds a plain left press to see if it becomes a drag', () => {
		expect(decideMouseDown(plain(), true, false)).toBe('hold');
	});

	it('selects immediately on double and triple click (word/line select)', () => {
		expect(decideMouseDown(plain({ detail: 2 }), true, false)).toBe('select');
		expect(decideMouseDown(plain({ detail: 3 }), true, false)).toBe('select');
	});

	it('never touches its own replayed events — no infinite loop', () => {
		expect(decideMouseDown(plain(), true, true)).toBe('pass');
	});

	it('passes when the TUI does not track the mouse — xterm already selects natively', () => {
		expect(decideMouseDown(plain(), false, false)).toBe('pass');
	});

	it('passes modified presses: Shift stays native-extend, Ctrl/Cmd stays link-open', () => {
		expect(decideMouseDown(plain({ shiftKey: true }), true, false)).toBe('pass');
		expect(decideMouseDown(plain({ ctrlKey: true }), true, false)).toBe('pass');
		expect(decideMouseDown(plain({ altKey: true }), true, false)).toBe('pass');
		expect(decideMouseDown(plain({ metaKey: true }), true, false)).toBe('pass');
	});

	it('passes non-left buttons (right-click paste, middle-click)', () => {
		expect(decideMouseDown(plain({ button: 1 }), true, false)).toBe('pass');
		expect(decideMouseDown(plain({ button: 2 }), true, false)).toBe('pass');
	});
});

describe('isDrag — click jitter vs a real drag', () => {
	it('a wiggle inside the threshold is still a click', () => {
		expect(isDrag(0, 0)).toBe(false);
		expect(isDrag(4, -4)).toBe(false);
	});
	it('crossing the threshold on either axis is a drag, in any direction', () => {
		expect(isDrag(5, 0)).toBe(true);
		expect(isDrag(0, -5)).toBe(true);
		expect(isDrag(-12, 3)).toBe(true);
	});
});
