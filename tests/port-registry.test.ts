import { describe, it, expect } from 'vitest';
import { PortRegistry, MAX_ENTRIES } from '../src/terminals/port-registry';
import type { PortHit } from '../src/terminals/port-scan';

const hit = (port: number, path = '', host = 'localhost'): PortHit => ({ url: `http://${host}:${port}${path}`, host, port, path });

describe('PortRegistry', () => {
	it('collapses repeats of one server into a single entry and keeps the newest URL', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000, '/'), 100);
		r.note(1, hit(3000, '/dashboard'), 200);
		expect(r.list()).toEqual([
			{ key: 'localhost:3000', url: 'http://localhost:3000/dashboard', host: 'localhost', port: 3000, path: '/dashboard', tileId: 1, firstSeenMs: 100, lastSeenMs: 200 },
		]);
	});

	it('moves a recycled port to its new owner instead of duplicating the row', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000), 100);
		r.note(2, hit(3000), 500);
		const rows = r.list();
		expect(rows).toHaveLength(1);
		expect(rows[0].tileId).toBe(2);
		expect(rows[0].firstSeenMs).toBe(100); // the port has been alive since 100, under new ownership
	});

	it('forgets exactly one terminal\'s rows when it closes', () => {
		const r = new PortRegistry();
		r.note(1, hit(3000), 100);
		r.note(2, hit(3001), 100);
		r.forget(1);
		expect(r.list().map((e) => e.port)).toEqual([3001]);
	});

	it('keeps different hosts on the same port apart', () => {
		const r = new PortRegistry();
		r.note(1, hit(5173), 100);
		r.note(1, hit(5173, '/', '192.168.1.42'), 100);
		expect(r.list().map((e) => e.key)).toEqual(['localhost:5173', '192.168.1.42:5173']);
	});

	it('evicts the least recently seen entry at the cap', () => {
		const r = new PortRegistry();
		for (let i = 0; i < MAX_ENTRIES; i++) r.note(1, hit(3000 + i), 1000 + i);
		r.note(1, hit(9999), 9_000);
		const rows = r.list();
		expect(rows).toHaveLength(MAX_ENTRIES);
		expect(rows.some((e) => e.port === 3000)).toBe(false); // oldest lastSeenMs went
		expect(rows.some((e) => e.port === 9999)).toBe(true);
	});

	it('sorts by owning tile then port so the rendered list does not jitter', () => {
		const r = new PortRegistry();
		r.note(2, hit(3001), 100);
		r.note(1, hit(5173), 100);
		r.note(1, hit(3000), 100);
		expect(r.list().map((e) => [e.tileId, e.port])).toEqual([[1, 3000], [1, 5173], [2, 3001]]);
	});
});
