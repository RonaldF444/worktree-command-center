/** Rect maths for the draggable/resizable peek pane. Pure and separately tested, because the
 *  edge cases here (an origin that must stop when a minimum is reached, a window that shrank
 *  under a saved position) are exactly the ones that are miserable to chase through the DOM. */

export interface Geometry { left: number; top: number; width: number; height: number; }
export interface Viewport { width: number; height: number; }
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Small enough to tuck away, large enough that a dev server page is still worth looking at. */
export const MIN_W = 320;
export const MIN_H = 200;

export function applyDrag(g: Geometry, dx: number, dy: number): Geometry {
	return { ...g, left: g.left + dx, top: g.top + dy };
}

export function applyResize(g: Geometry, edge: ResizeEdge, dx: number, dy: number): Geometry {
	let { left, top, width, height } = g;
	if (edge.includes('e')) width = Math.max(MIN_W, width + dx);
	if (edge.includes('w')) {
		// Anchor the edge NOT being dragged and derive the origin from it. Clamping `left` and
		// `width` independently lets the origin keep travelling after the width has bottomed
		// out, which drags the pane inside-out.
		const right = left + width;
		width = Math.max(MIN_W, width - dx);
		left = right - width;
	}
	if (edge.includes('s')) height = Math.max(MIN_H, height + dy);
	if (edge.includes('n')) {
		const bottom = top + height;
		height = Math.max(MIN_H, height - dy);
		top = bottom - height;
	}
	return { left, top, width, height };
}

/** Keep the pane wholly on screen. Called on every drag/resize and on window resize, so a pane
 *  can never be parked where it cannot be grabbed again — including after the window shrinks
 *  or a monitor changes under a saved position. */
export function clampToViewport(g: Geometry, vp: Viewport): Geometry {
	const width = Math.min(g.width, vp.width);
	const height = Math.min(g.height, vp.height);
	return {
		width,
		height,
		left: Math.min(Math.max(0, g.left), vp.width - width),
		top: Math.min(Math.max(0, g.top), vp.height - height),
	};
}

/** Where the pane opens before you have ever moved it: the right-hand 40%, full height — the
 *  fixed dock it had before it became draggable, so a first open looks unchanged. */
export function defaultGeometry(vp: Viewport): Geometry {
	const width = Math.max(MIN_W, Math.round(vp.width * 0.4));
	return clampToViewport({ left: vp.width - width, top: 0, width, height: vp.height }, vp);
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse a persisted geometry. Returns null for anything malformed so the caller falls back to
 *  `defaultGeometry` — stored UI state is untrusted input like any other. */
export function normalizeGeometry(raw: unknown, vp: Viewport): Geometry | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (!isFiniteNum(r.left) || !isFiniteNum(r.top) || !isFiniteNum(r.width) || !isFiniteNum(r.height)) return null;
	// A finite but tiny stored size is still unusable, so raise it to the minimum rather than
	// restoring a sliver the user then has to find and drag back open.
	return clampToViewport({
		left: r.left,
		top: r.top,
		width: Math.max(MIN_W, r.width),
		height: Math.max(MIN_H, r.height),
	}, vp);
}
