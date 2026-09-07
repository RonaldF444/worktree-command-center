import { describe, it, expect } from 'vitest';
import { RemoteTap, RESTART_MARKER } from '../src/terminals/remote-tap';

function make(clients = 1) {
	const events: any[] = [];
	let timers: Array<() => void> = [];
	const tap = new RemoteTap({ emit: (channel, payload) => events.push({ channel, payload }), setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {} });
	tap.setClientCount(clients);
	const tick = (): void => { const t = timers; timers = []; for (const cb of t) cb(); };
	return { tap, events, tick };
}

describe('RemoteTap', () => {
	it('buffers always, emits batched tile:data only with clients', () => {
		const { tap, events, tick } = make(0);
		tap.push('ws:1', 'a'); tap.push('ws:1', 'b');
		tick();
		expect(events).toEqual([]);
		expect(tap.snapshot('ws:1')).toBe('ab');
		tap.setClientCount(1);
		tap.push('ws:1', 'c'); tap.push('ws:1', 'd'); tap.push('ws:2', 'z');
		expect(events).toEqual([]); // not before the batch window
		tick();
		expect(events).toEqual([
			{ channel: 'tile:data', payload: { key: 'ws:1', chunk: 'cd' } },
			{ channel: 'tile:data', payload: { key: 'ws:2', chunk: 'z' } },
		]);
	});
	it('restart clears the buffer and emits the marker', () => {
		const { tap, events, tick } = make(1);
		tap.push('ws:1', 'old'); tick(); events.length = 0;
		tap.restart('ws:1'); tick();
		expect(tap.snapshot('ws:1')).toBe(RESTART_MARKER);
		expect(events).toEqual([{ channel: 'tile:data', payload: { key: 'ws:1', chunk: RESTART_MARKER } }]);
	});
	it('detach drops the buffer and emits tile:exit', () => {
		const { tap, events } = make(1);
		tap.push('ws:1', 'x');
		tap.detach('ws:1');
		expect(tap.snapshot('ws:1')).toBe('');
		expect(tap.keys()).toEqual([]);
		expect(events).toEqual([{ channel: 'tile:exit', payload: { key: 'ws:1' } }]);
	});
	it('caps the buffer', () => {
		const events: any[] = [];
		const tap = new RemoteTap({ emit: (c, p) => events.push(p), maxChars: 3 });
		tap.push('k', 'abcd');
		expect(tap.snapshot('k')).toBe('bcd');
	});
});
