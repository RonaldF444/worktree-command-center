/** When a session becomes ready: center now, unless the user is mid-typing
 *  in a terminal (then defer until they press Enter). */
export function decideOnReady(state: { userTyping: boolean }): 'center-now' | 'defer' {
	return state.userTyping ? 'defer' : 'center-now';
}

/** A visible tile's state for the spotlight decision, in order of how much it needs you:
 *  a permission prompt > a selection menu > a settled error > done/idle. Anything still
 *  streaming output is `thinking` and is NEVER given the spotlight on its own. */
export type SpotlightState = 'prompt' | 'menu' | 'errored' | 'idle' | 'thinking';

export interface CenterTile { id: number; state: SpotlightState; }

export interface CenterContext {
	tiles: CenterTile[];          // every VISIBLE tile + its current state
	centeredId: number | null;    // which tile holds the spotlight right now
	readyOrder: number[];         // the ready FIFO queue, front (index 0) = waiting longest
	pinnedId: number | null;      // manual click pin — soft: a steal event may replace it
	userTyping: boolean;          // text in the input box → don't yank the grid mid-type
	globalLock: boolean;          // the Lock button → never auto-move the spotlight
	lockedTileId: number | null;  // an individual lock → pin this tile to the center
}

const NEED: Record<Exclude<SpotlightState, 'thinking'>, number> = { prompt: 0, menu: 1, errored: 2, idle: 3 };

/** Decide which tile should hold the spotlight, DERIVED from the current floor state.
 *
 *  Rules, in order (2026-07-24 spec — FIFO service with a held center):
 *   1. An individual lock pins its tile; the global lock / active typing freeze the current one.
 *   2. A selection menu in the centered tile holds it (an Enter there toggles an option).
 *   3. A manual pin (clicked tile) holds — even a thinking tile.
 *   4. A centered tile that still needs you HOLDS the spotlight against same-or-lower
 *      urgency; only a strictly MORE urgent tile (e.g. a permission prompt over a plain
 *      idle) may take it. FIFO never yanks — the queue advances on YOUR Enter/click,
 *      and fresh-finisher steals are event-driven in the grid, not derived here.
 *   5. A free center serves whoever needs you most: urgency tier first, then queue
 *      order (waiting longest first; never-ready tiles after all queued ones), then id.
 *   6. Nobody qualifies → null: no spotlight, the grid shows every tile at equal size. */
export function decideCenter(ctx: CenterContext): number | null {
	if (ctx.lockedTileId !== null) return ctx.lockedTileId;   // pinned by lock
	if (ctx.globalLock) return ctx.centeredId;                // never auto-move
	if (ctx.userTyping) return ctx.centeredId;                // mid-type → hold
	const cur = ctx.tiles.find((t) => t.id === ctx.centeredId);
	if (cur && cur.state === 'menu') return cur.id;           // mid-menu → hold
	if (ctx.pinnedId !== null && ctx.tiles.some((t) => t.id === ctx.pinnedId)) return ctx.pinnedId;

	// Plain idle tiles attract the spotlight only while QUEUED — a dismissed idle tile
	// (served and cycled past, queue cleared by the overview) rests in the equal grid.
	// Prompts, menus and errors are always candidates: urgency must never be lost.
	const candidates = ctx.tiles.filter((t) =>
		t.state === 'prompt' || t.state === 'menu' || t.state === 'errored'
		|| (t.state === 'idle' && ctx.readyOrder.includes(t.id)));
	if (candidates.length === 0) return null;                 // nobody needs you → equal grid

	const need = (t: CenterTile): number => NEED[t.state as Exclude<SpotlightState, 'thinking'>];
	const qIndex = (id: number): number => { const i = ctx.readyOrder.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
	candidates.sort((a, b) => need(a) - need(b) || qIndex(a.id) - qIndex(b.id) || a.id - b.id);
	const best = candidates[0]!;

	// A centered tile that needs you holds against same-or-lower urgency (rule 4).
	if (cur && cur.state !== 'thinking' && need(best) >= need(cur)) return cur.id;
	return best.id;
}
