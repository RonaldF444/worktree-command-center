/** Decide the browser's fill/release move for one incoming floor:state. Pure so it unit-tests —
 *  getting this wrong in either direction has already hurt: auto-following the spotlight caused
 *  the 09-16 ConPTY repaint storm, and never filling made a focused tile unreadably tiny.
 *
 *  Rules:
 *  - Only a centre the USER requested (wantFillId, from click / Alt-jump / ports badge) may fill,
 *    and only once the desk CONFIRMS that tile is centred. Desk-driven spotlight moves (FIFO
 *    auto-centering, Alt-cycling) never fill.
 *  - The filled tile is released the moment the spotlight is confirmed elsewhere — one refit.
 *  - A wantFill that has expired (the desk never centred it — tile closed, request lost) must
 *    not fire later off an unrelated auto-move, so it is dropped instead of filled.
 */
export interface FillPlanInput {
	filledId: number | null;
	wantFillId: number | null;
	wantExpired: boolean;
	centeredId: number | null;
}
export interface FillPlan {
	release: number | null;
	fill: number | null;
	clearWant: boolean;
}
export function planFillTransition(i: FillPlanInput): FillPlan {
	const release = i.filledId !== null && i.centeredId !== i.filledId ? i.filledId : null;
	const fill = !i.wantExpired && i.wantFillId !== null && i.centeredId === i.wantFillId ? i.wantFillId : null;
	return { release, fill, clearWant: fill !== null || i.wantExpired };
}
