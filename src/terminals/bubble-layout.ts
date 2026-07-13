export interface Rect { id: number; x: number; y: number; w: number; h: number; }

/** Adaptive grid filling the stage. */
export function settledLayout(ids: number[], W: number, H: number, gap: number): Rect[] {
	const n = ids.length;
	if (n === 0) return [];
	const cols = Math.ceil(Math.sqrt(n));
	const rows = Math.ceil(n / cols);
	const tw = Math.floor((W - gap * (cols + 1)) / cols);
	const th = Math.floor((H - gap * (rows + 1)) / rows);
	return ids.map((id, i) => {
		const c = i % cols;
		const r = Math.floor(i / cols);
		return { id, x: gap + c * (tw + gap), y: gap + r * (th + gap), w: tw, h: th };
	});
}

/** Big centered tile that fills all space not taken by satellites. Satellites ring the
 *  edges (left/right columns first, then top/bottom bands); the center grows into any
 *  edge that has no satellites, so it's full-height with 1-2 others and never leaves gaps. */
export function centeredLayout(ids: number[], W: number, H: number, gap: number, centeredId: number): Rect[] {
	if (!ids.includes(centeredId)) return settledLayout(ids, W, H, gap);
	const others = ids.filter((id) => id !== centeredId);

	// Lone tile: fill the whole stage.
	if (others.length === 0) {
		return [{ id: centeredId, x: gap, y: gap, w: W - 2 * gap, h: H - 2 * gap }];
	}

	const buckets: Record<'l' | 'r' | 't' | 'b', number[]> = { l: [], r: [], t: [], b: [] };
	const order: Array<'l' | 'r' | 't' | 'b'> = ['l', 'r', 't', 'b'];
	others.forEach((id, i) => buckets[order[i % 4]!].push(id));

	const colW = Math.max(90, Math.floor(W * 0.2));
	const bandH = Math.max(60, Math.floor(H * 0.2));
	const leftX = gap;
	const rightX = W - gap - colW;
	const topY = gap;
	const botY = H - gap - bandH;

	// The center occupies everything between whichever edges actually hold satellites.
	const cx = buckets.l.length ? gap + colW + gap : gap;
	const rightLimit = buckets.r.length ? rightX - gap : W - gap;
	const cw = Math.max(120, rightLimit - cx);
	const cy = buckets.t.length ? gap + bandH + gap : gap;
	const botLimit = buckets.b.length ? botY - gap : H - gap;
	const ch = Math.max(120, botLimit - cy);

	const out: Rect[] = [{ id: centeredId, x: cx, y: cy, w: cw, h: ch }];

	// Left/right columns span the full height; top/bottom bands span the center's width.
	const vert = (arr: number[], x: number): void => {
		const m = arr.length;
		if (!m) return;
		const h = Math.floor((H - gap * (m + 1)) / m);
		arr.forEach((id, i) => out.push({ id, x, y: gap + i * (h + gap), w: colW, h }));
	};
	const horiz = (arr: number[], y: number): void => {
		const m = arr.length;
		if (!m) return;
		const w = Math.floor((cw - gap * (m - 1)) / m);
		arr.forEach((id, i) => out.push({ id, x: cx + i * (w + gap), y, w, h: bandH }));
	};
	vert(buckets.l, leftX);
	vert(buckets.r, rightX);
	horiz(buckets.t, topY);
	horiz(buckets.b, botY);
	return out;
}

/** Tile shortcut label: F1..F12, then A, B, … */
export function keyForIndex(i: number): string {
	return i < 12 ? `F${i + 1}` : String.fromCharCode(65 + (i - 12));
}

export function keyToIndex(key: string): number | null {
	const m = /^F(\d{1,2})$/.exec(key);
	if (m) {
		const n = parseInt(m[1]!, 10);
		return n >= 1 && n <= 12 ? n - 1 : null;
	}
	if (/^[A-Z]$/.test(key)) return 12 + (key.charCodeAt(0) - 65);
	return null;
}

/** Alt+←/→ spotlight cycle across every tile PLUS an "equal grid" stop (null). Given the
 *  current center (or null = equal grid) and a direction, return the next position in the ring
 *  [id0, id1, …, idN, null]. Unlike the ready-queue cycle this is independent of which tiles
 *  are idle, so it can always reach the equal grid — including when every terminal is thinking
 *  (the case where the ready stack is empty and the old cycle had nothing to move). */
export function nextSpotlight(ids: number[], current: number | null, dir: 1 | -1): number | null {
	const ring: Array<number | null> = [...ids, null];
	const i = ring.indexOf(current);
	const cur = i === -1 ? ring.length - 1 : i; // unknown current → treat as the grid slot
	const next = (cur + dir + ring.length) % ring.length;
	return ring[next]!;
}
