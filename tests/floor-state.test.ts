import { describe, it, expect } from 'vitest';
import { debounceFloor, type FloorState } from '../src/terminals/floor-state';

const state = (n: number): FloorState => ({ workspaceId: 'w', centeredId: n, terminals: [], kane: null, workspaces: [], repos: [], theme: 'default', usage: null });

describe('debounceFloor', () => {
	it('coalesces a burst into one publish after the window', () => {
		const out: FloorState[] = [];
		let n = 0;
		let timers: Array<() => void> = [];
		const d = debounceFloor((s) => out.push(s), () => state(++n), 100, (cb) => { timers.push(cb); return 1; }, () => {});
		d.request(); d.request(); d.request();
		expect(out).toEqual([]);
		const t = timers; timers = []; for (const cb of t) cb();
		expect(out).toHaveLength(1);
		expect(out[0]!.centeredId).toBe(1); // built once, at fire time
	});
	it('flush publishes immediately and cancels the pending timer', () => {
		const out: FloorState[] = [];
		let cleared = 0;
		const d = debounceFloor((s) => out.push(s), () => state(7), 100, () => 1, () => { cleared++; });
		d.request(); d.flush();
		expect(out.map((s) => s.centeredId)).toEqual([7]);
		expect(cleared).toBe(1);
	});
});
