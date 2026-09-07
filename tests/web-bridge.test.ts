import { describe, it, expect } from 'vitest';
import { createBridge, type SocketLike } from '../src/web/bridge';

class FakeSocket implements SocketLike {
	static OPEN = 1;
	readyState = 0;
	sent: any[] = [];
	onopen: (() => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
	send(d: string): void { this.sent.push(JSON.parse(d)); }
	close(): void { this.readyState = 3; this.onclose?.(); }
	open(): void { this.readyState = 1; this.onopen?.(); }
	receive(f: unknown): void { this.onmessage?.({ data: JSON.stringify(f) }); }
}

function harness(token: string | null = null) {
	const sockets: FakeSocket[] = [];
	let stored: string | null = token; let remembered: boolean | null = null;
	const timers: Array<{ cb: () => void; ms: number }> = [];
	const intervals: Array<{ cb: () => void; ms: number }> = [];
	const bridge = createBridge({
		url: 'ws://x/ws',
		createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
		storage: { get: () => stored, set: (t, r) => { stored = t; remembered = r; }, clear: () => { stored = null; } },
		setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
		clearTimer: (h) => { const i = (h as number) - 1; if (timers[i]) timers[i] = { cb: () => {}, ms: -1 }; },
		setInterval: (cb, ms) => { intervals.push({ cb, ms }); return intervals.length; },
		clearInterval: () => {},
	});
	const fireTimers = (): void => { const t = timers.splice(0); for (const x of t) x.cb(); };
	return { bridge, sockets, timers, intervals, fireTimers, get stored() { return stored; }, get remembered() { return remembered; } };
}

describe('createBridge', () => {
	it('with no token: opens the socket and lands in login', () => {
		const h = harness();
		const s = h.sockets[0]!;
		expect(h.bridge.status()).toBe('connecting');
		s.open();
		expect(h.bridge.status()).toBe('login');
		expect(s.sent).toEqual([]);
	});
	it('with a stored token: sends auth, becomes open on ok, flushes queued invokes', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		const p = h.bridge.invoke('floor:state');
		s.open();
		expect(s.sent).toEqual([{ t: 'auth', deviceToken: 'tok' }]);
		s.receive({ t: 'auth', ok: true, deviceId: 'd' });
		expect(h.bridge.status()).toBe('open');
		expect(s.sent[1]).toMatchObject({ t: 'invoke', channel: 'floor:state' });
		s.receive({ t: 'reply', id: s.sent[1].id, ok: true, value: { x: 1 } });
		await expect(p).resolves.toEqual({ x: 1 });
	});
	it('a rejected token is cleared and the bridge falls to login', () => {
		const h = harness('dead');
		const s = h.sockets[0]!;
		s.open();
		s.receive({ t: 'auth', ok: false, error: 'unknown device token' });
		expect(h.stored).toBeNull();
		expect(h.bridge.status()).toBe('login');
	});
	it('submitPassword stores the returned token (remember flag honoured) and opens', async () => {
		const h = harness();
		const s = h.sockets[0]!;
		s.open();
		const p = h.bridge.submitPassword('pw', true, 'Laptop');
		expect(s.sent).toEqual([{ t: 'auth', password: 'pw', deviceLabel: 'Laptop' }]);
		s.receive({ t: 'auth', ok: true, deviceToken: 'new', deviceId: 'd' });
		await expect(p).resolves.toEqual({ ok: true });
		expect(h.stored).toBe('new'); expect(h.remembered).toBe(true);
		expect(h.bridge.status()).toBe('open');
	});
	it('a wrong password resolves ok:false with the server error and stays in login', async () => {
		const h = harness();
		const s = h.sockets[0]!;
		s.open();
		const p = h.bridge.submitPassword('bad', false, 'L');
		s.receive({ t: 'auth', ok: false, error: 'invalid password' });
		await expect(p).resolves.toEqual({ ok: false, error: 'invalid password' });
		expect(h.bridge.status()).toBe('login');
	});
	it('events reach listeners; unsubscribe works', () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const got: unknown[] = [];
		const off = h.bridge.on('tile:data', (p) => got.push(p));
		s.receive({ t: 'event', channel: 'tile:data', payload: { key: 'w:1', chunk: 'x' } });
		off();
		s.receive({ t: 'event', channel: 'tile:data', payload: { key: 'w:1', chunk: 'y' } });
		expect(got).toEqual([{ key: 'w:1', chunk: 'x' }]);
	});
	it('in-flight invokes are rejected (not replayed) on drop; the reconnect is scheduled with backoff', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const p = h.bridge.invoke('tile:kill', { id: 1 });
		s.close();
		await expect(p).rejects.toThrow();
		expect(h.bridge.status()).toBe('offline');
		const delays = h.timers.filter((t) => t.ms > 0).map((t) => t.ms);
		expect(delays).toContain(1000);
		h.fireTimers();
		expect(h.sockets).toHaveLength(2);
		h.sockets[1]!.close(); // fails again: 2s next
		expect(h.timers.filter((t) => t.ms > 0).map((t) => t.ms)).toContain(2000);
	});
	it('an "unauthenticated" reply flips to login', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const p = h.bridge.invoke('x');
		s.receive({ t: 'reply', id: s.sent[1].id, ok: false, error: 'unauthenticated' });
		await expect(p).rejects.toThrow('unauthenticated');
		expect(h.bridge.status()).toBe('login');
	});
	it('pings on the interval and declares the socket dead after 3 missed pongs', () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const ping = h.intervals[0]!;
		expect(ping.ms).toBe(20_000);
		ping.cb(); ping.cb();
		expect(s.sent.filter((f) => f.t === 'ping')).toHaveLength(2);
		s.receive({ t: 'pong' });
		ping.cb(); ping.cb(); ping.cb();
		expect(h.bridge.status()).toBe('offline');
	});
	it('queue is bounded at 100 while offline', async () => {
		const h = harness();
		for (let i = 0; i < 100; i++) void h.bridge.invoke('x').catch(() => {});
		await expect(h.bridge.invoke('x')).rejects.toThrow(/too many/);
	});
	it('logout clears the token and returns to login on the next socket', () => {
		const h = harness('tok');
		h.sockets[0]!.open(); h.sockets[0]!.receive({ t: 'auth', ok: true });
		h.bridge.logout();
		expect(h.stored).toBeNull();
		h.fireTimers();
		h.sockets[1]!.open();
		expect(h.bridge.status()).toBe('login');
	});
});
