/** Pure sizing rules for the browser mirror. The browser never resizes the desktop's PTY
 *  (two screens must not fight), so a tile fits the desktop-sized terminal into its own box by
 *  lowering the FONT SIZE instead — down to `min`, after which it clips like the desktop does. */

export interface FitInput {
	cols: number; rows: number;
	/** Inner box the terminal must fit, css px. */
	boxW: number; boxH: number;
	/** One character cell at `base` px, css px. */
	cell: { w: number; h: number };
	base?: number;
	min?: number;
}

export function fitFontSize({ cols, rows, boxW, boxH, cell, base = 12, min = 6 }: FitInput): number {
	if (!(cols > 0) || !(rows > 0) || !(boxW > 0) || !(boxH > 0) || !(cell.w > 0) || !(cell.h > 0)) return base;
	const k = Math.min(boxW / (cols * cell.w), boxH / (rows * cell.h));
	if (k >= 1) return base;
	return Math.max(min, Math.min(base, Math.floor(base * k)));
}

/** The "repo · branch" line under a tile name — null when the name already says exactly that
 *  (the desktop's default name), so it is not printed twice. */
export function repoLabel(name: string, repo: string, branch: string): string | null {
	const label = branch ? `${repo} · ${branch}` : repo;
	return name.trim() === label ? null : label;
}
