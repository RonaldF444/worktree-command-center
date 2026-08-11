import { describe, it, expect } from 'vitest';
import { ctrlClickActivator, shouldOpen, OPEN_DEDUPE_MS } from '../src/terminals/links';

const click = (mods: Partial<MouseEvent> = {}): MouseEvent => ({ ctrlKey: false, metaKey: false, ...mods }) as MouseEvent;

describe('ctrlClickActivator', () => {
	it('opens only on Ctrl/Cmd+click', () => {
		const opened: string[] = [];
		const act = ctrlClickActivator((u) => opened.push(u));
		act(click(), 'http://a');
		expect(opened).toEqual([]);
		act(click({ ctrlKey: true }), 'http://a');
		act(click({ metaKey: true }), 'http://b');
		expect(opened).toEqual(['http://a', 'http://b']);
	});
	it('yields when suppressed (TUI owns the mouse)', () => {
		const opened: string[] = [];
		let tui = true;
		const act = ctrlClickActivator((u) => opened.push(u), () => tui);
		act(click({ ctrlKey: true }), 'http://a');
		expect(opened).toEqual([]); // TUI opens it, we must not
		tui = false; // session died / plain shell — our handler takes over
		act(click({ ctrlKey: true }), 'http://a');
		expect(opened).toEqual(['http://a']);
	});
});

describe('shouldOpen', () => {
	it('collapses a same-URL double-fire inside the dedupe window, allows it after', () => {
		const t0 = 1_900_000_000_000; // fresh URL for this test run
		expect(shouldOpen('http://dedupe-test/a', t0)).toBe(true);
		expect(shouldOpen('http://dedupe-test/a', t0 + 50)).toBe(false); // OSC8 + regex double
		expect(shouldOpen('http://dedupe-test/b', t0 + 60)).toBe(true);  // different URL is fine
		expect(shouldOpen('http://dedupe-test/b', t0 + 60 + OPEN_DEDUPE_MS + 1)).toBe(true); // re-click later
	});
});
