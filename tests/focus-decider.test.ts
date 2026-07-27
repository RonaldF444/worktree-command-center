import { describe, it, expect } from 'vitest';
import { decideOnReady, decideCenter, type CenterContext } from '../src/terminals/focus-decider';

describe('decideOnReady', () => {
	it('centers immediately when the user is not typing', () => {
		expect(decideOnReady({ userTyping: false })).toBe('center-now');
	});
	it('defers when the user is mid-typing (wait for Enter)', () => {
		expect(decideOnReady({ userTyping: true })).toBe('defer');
	});
});

describe('decideCenter — FIFO service with a held center (2026-07-24 spec)', () => {
	const ctx = (over: Partial<CenterContext>): CenterContext => ({
		tiles: [], centeredId: null, readyOrder: [], pinnedId: null, userTyping: false, globalLock: false, lockedTileId: null, ...over,
	});

	it('no tiles → no spotlight', () => {
		expect(decideCenter(ctx({}))).toBeNull();
	});

	it('everyone thinking (and none pinned) → no spotlight, equal grid', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'thinking' }, { id: 2, state: 'thinking' }],
			centeredId: 1,
		}))).toBeNull();
	});

	it('centers the lone idle tile', () => {
		expect(decideCenter(ctx({ tiles: [{ id: 1, state: 'idle' }], readyOrder: [1] }))).toBe(1);
	});

	it('moves off a thinking centered tile to a ready sibling', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'thinking' }, { id: 2, state: 'idle' }],
			readyOrder: [2], centeredId: 1,
		}))).toBe(2);
	});

	it('serves the FRONT of the queue (waiting longest) when the center is free', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'idle' }, { id: 3, state: 'thinking' }],
			readyOrder: [1, 2], centeredId: 3,
		}))).toBe(1);
	});

	it('HOLDS a centered ready tile against same-tier siblings — FIFO advances on YOUR action', () => {
		// (Old LIFO behavior yanked the center to the newest finisher; steal is event-driven now.)
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'idle' }],
			readyOrder: [1, 2], centeredId: 1,
		}))).toBe(1);
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'idle' }],
			readyOrder: [1, 2], centeredId: 2,
		}))).toBe(2);
	});

	it('a permission prompt still outranks a held idle center (urgency beats FIFO)', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'prompt' }],
			readyOrder: [1], centeredId: 1,
		}))).toBe(2);
	});

	it('a settled error outranks a plain idle tile', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'errored' }],
			readyOrder: [1, 2],
		}))).toBe(2);
	});

	it('queued tiles are served before attention-needing tiles that never became ready', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 4, state: 'idle' }, { id: 1, state: 'idle' }],
			readyOrder: [1], centeredId: null,
		}))).toBe(1);
	});

	it('dismissed idle tiles (not in the queue) never attract the spotlight — overview holds', () => {
		// The 2026-07-27 bug: Alt+Right past the last tile reached the equal grid, then the
		// 1s re-derive bounced the center back to tile 1. All-idle + empty queue must stay null.
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'idle' }, { id: 3, state: 'idle' }],
			readyOrder: [], centeredId: null,
		}))).toBeNull();
	});

	it('a prompt or error still breaks into the overview even off-queue', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'prompt' }],
			readyOrder: [], centeredId: null,
		}))).toBe(2);
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 3, state: 'errored' }],
			readyOrder: [], centeredId: null,
		}))).toBe(3);
	});

	it('a manual pin keeps a thinking tile centered over queued ready tiles', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'thinking' }],
			readyOrder: [1], pinnedId: 2, centeredId: 2,
		}))).toBe(2);
	});

	it('a stale pin (tile gone) is ignored', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }],
			readyOrder: [1], pinnedId: 99, centeredId: null,
		}))).toBe(1);
	});

	it('an individual lock pins the spotlight regardless of state', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'thinking' }, { id: 2, state: 'idle' }],
			readyOrder: [2], centeredId: 1, lockedTileId: 1,
		}))).toBe(1);
	});

	it('the global lock holds the current center (no auto-move)', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'thinking' }, { id: 2, state: 'idle' }],
			readyOrder: [2], centeredId: 1, globalLock: true,
		}))).toBe(1);
	});

	it('active typing holds the current center (do not yank mid-type)', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'idle' }, { id: 2, state: 'idle' }],
			readyOrder: [1, 2], centeredId: 1, userTyping: true,
		}))).toBe(1);
	});

	it('a menu in the centered tile holds it against an idle sibling', () => {
		expect(decideCenter(ctx({
			tiles: [{ id: 1, state: 'menu' }, { id: 2, state: 'idle' }],
			readyOrder: [2], centeredId: 1,
		}))).toBe(1);
	});
});
