import { describe, it, expect } from 'vitest';
import { fitFontSize, repoLabel } from '../src/web/fit';

// Cell metrics of the default mono font at 12px, roughly 7.2 x 14 css px.
const cell = { w: 7.2, h: 14 };

describe('fitFontSize', () => {
	it('keeps the base size when the desktop terminal already fits the box', () => {
		expect(fitFontSize({ cols: 80, rows: 24, boxW: 700, boxH: 400, cell })).toBe(12);
	});
	it('never grows past the base size, however big the box', () => {
		expect(fitFontSize({ cols: 80, rows: 24, boxW: 4000, boxH: 3000, cell })).toBe(12);
	});
	it('shrinks by width so every column fits', () => {
		// 100 cols * 7.2 = 720px wide at 12px; a 600px box needs 12 * 600/720 = 10px
		expect(fitFontSize({ cols: 100, rows: 10, boxW: 600, boxH: 1000, cell })).toBe(10);
	});
	it('shrinks by height when that is the tighter side', () => {
		// 50 rows * 14 = 700px tall at 12px; a 420px box needs 12 * 420/700 = 7.2 -> 7px
		expect(fitFontSize({ cols: 10, rows: 50, boxW: 1000, boxH: 420, cell })).toBe(7);
	});
	it('stops at the minimum size and lets the rest clip, like the desktop does', () => {
		// 200 cols on a 230px box would want ~1.9px
		expect(fitFontSize({ cols: 200, rows: 24, boxW: 230, boxH: 300, cell })).toBe(6);
		expect(fitFontSize({ cols: 200, rows: 24, boxW: 230, boxH: 300, cell, min: 8 })).toBe(8);
	});
	it('falls back to the base size on degenerate input (nothing measured yet)', () => {
		expect(fitFontSize({ cols: 0, rows: 24, boxW: 500, boxH: 300, cell })).toBe(12);
		expect(fitFontSize({ cols: 80, rows: 24, boxW: 0, boxH: 300, cell })).toBe(12);
		expect(fitFontSize({ cols: 80, rows: 24, boxW: 500, boxH: 300, cell: { w: 0, h: 0 } })).toBe(12);
	});
});

describe('repoLabel', () => {
	it('is hidden when the name is already the default "repo · branch"', () => {
		expect(repoLabel('cj-warehouse · wt/main-1', 'cj-warehouse', 'wt/main-1')).toBeNull();
	});
	it('shows repo · branch under a custom name', () => {
		expect(repoLabel('Terri Deep-Clean Review', 'terri', 'wt/main-1')).toBe('terri · wt/main-1');
	});
	it('shows just the repo when there is no branch (Kane)', () => {
		expect(repoLabel('Kane', 'overseer', '')).toBe('overseer');
	});
});
