import { describe, it, expect } from 'vitest';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, nextSpotlight } from '../src/terminals/bubble-layout';

describe('settledLayout', () => {
	it('lays N tiles in an adaptive grid, all within bounds', () => {
		const r = settledLayout([1, 2, 3, 4], 1000, 600, 8);
		expect(r).toHaveLength(4);
		for (const t of r) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.x + t.w).toBeLessThanOrEqual(1000);
			expect(t.y + t.h).toBeLessThanOrEqual(600);
			expect(t.w).toBeGreaterThan(0);
			expect(t.h).toBeGreaterThan(0);
		}
	});
	it('returns [] for no tiles', () => {
		expect(settledLayout([], 800, 600, 8)).toEqual([]);
	});
});

describe('centeredLayout', () => {
	it('centers the chosen tile and includes every id', () => {
		const r = centeredLayout([1, 2, 3, 4, 5], 1000, 600, 8, 3);
		expect(r).toHaveLength(5);
		expect(r.map((x) => x.id).sort()).toEqual([1, 2, 3, 4, 5]);
		const c = r.find((x) => x.id === 3)!;
		expect(c.x).toBeGreaterThan(150);
		expect(c.x + c.w).toBeLessThan(850);
		const maxW = Math.max(...r.map((x) => x.w));
		expect(c.w).toBe(maxW);
	});
	it('falls back to settled when centeredId is absent', () => {
		const r = centeredLayout([1, 2], 800, 600, 8, 99);
		expect(r).toHaveLength(2);
	});
	it('fills full height (no blank bands) when only left/right satellites exist', () => {
		const r = centeredLayout([1, 2, 3], 1000, 600, 8, 1);
		expect(r).toHaveLength(3);
		const c = r.find((x) => x.id === 1)!;
		expect(c.h).toBeGreaterThan(600 * 0.9); // center spans almost the whole height
		expect(c.w).toBe(Math.max(...r.map((x) => x.w)));
		for (const t of r) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.x + t.w).toBeLessThanOrEqual(1000);
			expect(t.y + t.h).toBeLessThanOrEqual(600);
		}
	});
	it('a lone centered tile fills the whole stage', () => {
		const r = centeredLayout([7], 1000, 600, 8, 7);
		expect(r).toHaveLength(1);
		expect(r[0]!.w).toBe(1000 - 16);
		expect(r[0]!.h).toBe(600 - 16);
	});
});

describe('keyForIndex / keyToIndex', () => {
	it('maps F1..F12 then A,B,…', () => {
		expect(keyForIndex(0)).toBe('F1');
		expect(keyForIndex(11)).toBe('F12');
		expect(keyForIndex(12)).toBe('A');
		expect(keyForIndex(13)).toBe('B');
	});
	it('round-trips', () => {
		for (let i = 0; i < 16; i++) expect(keyToIndex(keyForIndex(i))).toBe(i);
		expect(keyToIndex('F13')).toBeNull();
		expect(keyToIndex('1')).toBeNull();
	});
});

describe('nextSpotlight (Alt+←/→ cycle incl. equal-grid stop)', () => {
	const ids = [1, 2, 3, 4];
	it('forward: grid → first tile → … → last → back to grid', () => {
		expect(nextSpotlight(ids, null, 1)).toBe(1);
		expect(nextSpotlight(ids, 1, 1)).toBe(2);
		expect(nextSpotlight(ids, 3, 1)).toBe(4);
		expect(nextSpotlight(ids, 4, 1)).toBeNull(); // past the last tile → equal grid
	});
	it('backward is the reverse', () => {
		expect(nextSpotlight(ids, null, -1)).toBe(4);
		expect(nextSpotlight(ids, 4, -1)).toBe(3);
		expect(nextSpotlight(ids, 1, -1)).toBeNull(); // before the first → equal grid
	});
	it('REGRESSION: the equal grid is always reachable by cycling (the reported bug)', () => {
		let cur: number | null = 2;
		const seen: Array<number | null> = [];
		for (let i = 0; i < ids.length + 1; i++) { cur = nextSpotlight(ids, cur, 1); seen.push(cur); }
		expect(seen).toContain(null); // Alt+→ can reach the all-equal layout
	});
	it('an unknown current steps into the ring', () => {
		expect(nextSpotlight(ids, 999, 1)).toBe(1);
		expect(nextSpotlight(ids, 999, -1)).toBe(4);
	});
	it('no tiles → only the equal grid', () => {
		expect(nextSpotlight([], null, 1)).toBeNull();
		expect(nextSpotlight([], 5, 1)).toBeNull();
	});
});
