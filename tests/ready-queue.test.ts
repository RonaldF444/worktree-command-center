import { describe, it, expect } from 'vitest';
import { emptyState, applyKeystroke, onReady, onSubmit, onClose, onClick, onOverview } from '../src/terminals/ready-queue';

describe('applyKeystroke (input-box length)', () => {
	it('counts printable chars', () => {
		expect(applyKeystroke(0, 'a')).toBe(1);
		expect(applyKeystroke(2, 'xy')).toBe(4);
	});
	it('backspace decrements (floored at 0)', () => {
		expect(applyKeystroke(2, '\x7f')).toBe(1);
		expect(applyKeystroke(0, '\b')).toBe(0);
	});
	it('Enter / ctrl-u / ctrl-c clear the box', () => {
		expect(applyKeystroke(5, '\r')).toBe(0);
		expect(applyKeystroke(5, '\x15')).toBe(0);
		expect(applyKeystroke(5, '\x03')).toBe(0);
	});
	it('ignores escape sequences (arrow keys)', () => {
		expect(applyKeystroke(2, '\x1b[A')).toBe(2);
		expect(applyKeystroke(2, '\x1b[D')).toBe(2);
	});
	it('a bare Escape clears the box (Claude cancel / clear)', () => {
		expect(applyKeystroke(5, '\x1b')).toBe(0);
	});
});

describe('FIFO ready queue (2026-07-24 spec: first finished, first served)', () => {
	it('appends new ready tiles at the back; front = waiting longest', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onReady(s, 2).state;
		s = onReady(s, 3).state;
		expect(s.queue).toEqual([1, 2, 3]);
	});

	it('marks whether the tile was newly added (re-fires are not steal events)', () => {
		let s = emptyState();
		const first = onReady(s, 7);
		expect(first.added).toBe(true);
		const again = onReady(first.state, 7);
		expect(again.added).toBe(false);
		expect(again.state.queue).toEqual([7]);
	});

	it('onSubmit removes the tile, clears an identical pin, resets composing', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onReady(s, 2).state;
		s = onClick(s, 1).state;
		s = { ...s, composingLen: 4 };
		const r = onSubmit(s, 1);
		expect(r.state.queue).toEqual([2]);
		expect(r.state.pinnedId).toBeNull();
		expect(r.state.composingLen).toBe(0);
	});

	it('onSubmit to one tile leaves another pin alone', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onClick(s, 9).state;
		expect(onSubmit(s, 1).state.pinnedId).toBe(9);
	});

	it('onClose removes the tile and clears an identical pin', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onClick(s, 1).state;
		const r = onClose(s, 1);
		expect(r.state.queue).toEqual([]);
		expect(r.state.pinnedId).toBeNull();
	});

	it('onClick pins the tile WITHOUT inserting it into the queue', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		const r = onClick(s, 9); // clicked a busy (not-ready) tile
		expect(r.state.pinnedId).toBe(9);
		expect(r.state.queue).toEqual([1]);
	});

	it('clicking away from a centered ready tile demotes it to the BACK of the queue', () => {
		let s = emptyState();
		s = onReady(s, 1).state; // 1 finished first (and held the center)
		s = onReady(s, 2).state;
		s = onReady(s, 3).state;
		const r = onClick(s, 5, 1); // user clicks tile 5 while ready tile 1 was centered
		expect(r.state.queue).toEqual([2, 3, 1]); // 1 lost its front spot
		expect(r.state.pinnedId).toBe(5);
	});

	it('clicking the centered ready tile itself does not demote it', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onReady(s, 2).state;
		const r = onClick(s, 1, 1);
		expect(r.state.queue).toEqual([1, 2]);
		expect(r.state.pinnedId).toBe(1);
	});

	it('clicking away from a centered tile that is NOT in the queue changes nothing but the pin', () => {
		let s = emptyState();
		s = onReady(s, 2).state;
		const r = onClick(s, 5, 4); // 4 was centered but never ready
		expect(r.state.queue).toEqual([2]);
		expect(r.state.pinnedId).toBe(5);
	});

	it('onOverview (cycled to the equal grid) marks everything seen: queue + pin cleared', () => {
		let s = emptyState();
		s = onReady(s, 1).state;
		s = onReady(s, 2).state;
		s = onClick(s, 1).state;
		const r = onOverview(s);
		expect(r.state.queue).toEqual([]);
		expect(r.state.pinnedId).toBeNull();
	});
});
