/** Pure parsing of Claude's `/usage` view — no IO, so it unit-tests cleanly. */

export interface UsageReadout {
	sessionPct: number | null;   // current session (the 5-hour window)
	sessionReset: string | null; // e.g. "3:50am (America/New_York)"
	weekPct: number | null;      // current week, all models
	weekReset: string | null;    // e.g. "Jun 15, 12am (America/New_York)"
}

/** Strip ANSI/OSC escape sequences so word/number anchors survive. Box-drawing glyphs
 *  (█ ▌ ▍) are left as-is — the field regexes skip over them. */
export function stripAnsi(text: string): string {
	return String(text)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (e.g. window title)
		.replace(/\x1b[[\]][0-9;?]*[ -/]*[@-~]/g, '')      // CSI
		.replace(/\x1b[()][AB0]/g, '');                    // charset selects
}

/** A window of text starting at a section label, so one section's numbers don't leak in
 *  from another. */
function sectionAfter(text: string, labelRe: RegExp): string {
	const m = labelRe.exec(text);
	return m ? text.slice(m.index, m.index + 200) : '';
}

function pctIn(s: string): number | null {
	const m = /(\d{1,3})\s*%\s*used/i.exec(s);
	return m ? Math.min(100, parseInt(m[1], 10)) : null;
}

function resetIn(s: string): string | null {
	// Prefer "Resets <…>(timezone)"; fall back to a short run after "Resets".
	const m = /resets\s*([^\n]*?\([^)]+\))/i.exec(s);
	if (m) return m[1].replace(/\s+/g, ' ').trim();
	const m2 = /resets\s*([^\n]{1,40})/i.exec(s);
	return m2 ? m2[1].replace(/\s+/g, ' ').trim() : null;
}

export function parseUsage(text: string): UsageReadout {
	const t = stripAnsi(text);
	const sess = sectionAfter(t, /current\s*session/i);
	const week = sectionAfter(t, /current\s*week\s*\(?\s*all\s*models\)?/i);
	return {
		sessionPct: pctIn(sess),
		sessionReset: resetIn(sess),
		weekPct: pctIn(week),
		weekReset: resetIn(week),
	};
}
