import { describe, it, expect } from 'vitest';
import {
	applyDrag, applyResize, clampToViewport, defaultGeometry, normalizeGeometry,
	MIN_W, MIN_H, type Geometry,
} from '../src/ui/pane-geometry';

const g = (left: number, top: number, width: number, height: number): Geometry => ({ left, top, width, height });
const vp = { width: 1600, height: 900 };

describe('applyDrag', () => {
	it('moves by the pointer delta without changing size', () => {
		expect(applyDrag(g(100, 100, 400, 300), 50, -25)).toEqual(g(150, 75, 400, 300));
	});
});

describe('applyResize', () => {
	it('grows width from the east edge, leaving the origin alone', () => {
		expect(applyResize(g(100, 100, 400, 300), 'e', 60, 0)).toEqual(g(100, 100, 460, 300));
	});

	it('grows height from the south edge', () => {
		expect(applyResize(g(100, 100, 400, 300), 's', 0, 40)).toEqual(g(100, 100, 400, 340));
	});

	it('moves the origin when dragging the west edge, so the right edge stays put', () => {
		// left 100 -> 160, width 400 -> 340: the right edge stays at 500.
		expect(applyResize(g(100, 100, 400, 300), 'w', 60, 0)).toEqual(g(160, 100, 340, 300));
	});

	it('moves the origin when dragging the north edge, so the bottom edge stays put', () => {
		expect(applyResize(g(100, 100, 400, 300), 'n', 0, 60)).toEqual(g(100, 160, 400, 240));
	});

	it('resizes both axes from a corner', () => {
		expect(applyResize(g(100, 100, 400, 300), 'se', 50, 40)).toEqual(g(100, 100, 450, 340));
	});

	it('stops the west edge at the minimum width instead of dragging the origin past it', () => {
		// Dragging the west edge 300px right would leave width 100 (< MIN_W). The origin must
		// stop where the minimum is reached, not keep travelling — otherwise the pane inverts.
		const r = applyResize(g(100, 100, 400, 300), 'w', 300, 0);
		expect(r.width).toBe(MIN_W);
		expect(r.left).toBe(100 + 400 - MIN_W); // right edge unmoved at 500
	});

	it('stops the north edge at the minimum height instead of dragging the origin past it', () => {
		const r = applyResize(g(100, 100, 400, 300), 'n', 0, 250);
		expect(r.height).toBe(MIN_H);
		expect(r.top).toBe(100 + 300 - MIN_H);
	});

	it('clamps the east edge at the minimum width', () => {
		expect(applyResize(g(100, 100, 400, 300), 'e', -1000, 0).width).toBe(MIN_W);
	});

	it('clamps the south edge at the minimum height', () => {
		expect(applyResize(g(100, 100, 400, 300), 's', 0, -1000).height).toBe(MIN_H);
	});
});

describe('clampToViewport', () => {
	it('leaves a pane that already fits untouched', () => {
		expect(clampToViewport(g(100, 100, 400, 300), vp)).toEqual(g(100, 100, 400, 300));
	});

	it('pulls a pane dragged off the right edge back into view', () => {
		expect(clampToViewport(g(1500, 100, 400, 300), vp)).toEqual(g(1200, 100, 400, 300));
	});

	it('pulls a pane dragged off the top-left back into view', () => {
		expect(clampToViewport(g(-80, -50, 400, 300), vp)).toEqual(g(0, 0, 400, 300));
	});

	it('shrinks a pane larger than the viewport rather than leaving it unreachable', () => {
		// Happens when the window is resized smaller, or a monitor changes.
		expect(clampToViewport(g(0, 0, 4000, 3000), vp)).toEqual(g(0, 0, 1600, 900));
	});
});

describe('defaultGeometry', () => {
	it('is the right-hand 40% at full height, matching the pre-draggable pane', () => {
		expect(defaultGeometry(vp)).toEqual(g(960, 0, 640, 900));
	});

	it('never returns something below the minimum size on a small window', () => {
		const r = defaultGeometry({ width: 500, height: 300 });
		expect(r.width).toBeGreaterThanOrEqual(MIN_W);
		expect(r.height).toBeGreaterThanOrEqual(MIN_H);
	});
});

describe('normalizeGeometry', () => {
	it('accepts a well-formed stored value, clamped to the current viewport', () => {
		expect(normalizeGeometry({ left: 100, top: 50, width: 400, height: 300 }, vp)).toEqual(g(100, 50, 400, 300));
	});

	it('re-clamps a value saved on a larger monitor', () => {
		expect(normalizeGeometry({ left: 1500, top: 800, width: 400, height: 300 }, { width: 800, height: 600 }))
			.toEqual(g(400, 300, 400, 300));
	});

	it('raises a stored size below the minimum back to it, rather than restoring an unusable sliver', () => {
		const r = normalizeGeometry({ left: 40, top: 40, width: 10, height: 10 }, vp);
		expect(r).toEqual(g(40, 40, MIN_W, MIN_H));
	});

	it('rejects malformed stored values so a corrupt entry falls back to the default', () => {
		expect(normalizeGeometry(null, vp)).toBeNull();
		expect(normalizeGeometry('nonsense', vp)).toBeNull();
		expect(normalizeGeometry({ left: 1, top: 2, width: 3 }, vp)).toBeNull();
		expect(normalizeGeometry({ left: 'a', top: 2, width: 3, height: 4 }, vp)).toBeNull();
		expect(normalizeGeometry({ left: NaN, top: 2, width: 300, height: 300 }, vp)).toBeNull();
		expect(normalizeGeometry({ left: 0, top: 0, width: Infinity, height: 300 }, vp)).toBeNull();
	});
});
