/** The actions the phone may send, validated in the MAIN process before they reach the
 *  renderer. The page is token-gated, but a typo'd or hostile body must never become a
 *  keystroke in a live Claude session — so nothing is forwarded until it parses cleanly. */
export type RemoteAction =
	| { type: 'remote'; id: number }
	| { type: 'spawn'; repo: string; base: string | null; task: string }
	| { type: 'input'; id: number; text: string };

/** Longest message accepted from the phone. Speech transcripts are short; the HTTP body cap
 *  (100KB) is far too generous for something that gets typed into an agent. */
export const MAX_INPUT = 4000;

const isTileId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Validate + normalize one action. `null` means reject: it is dropped, never forwarded. */
export function parseRemoteAction(raw: unknown): RemoteAction | null {
	if (!raw || typeof raw !== 'object') return null;
	const a = raw as Record<string, unknown>;
	if (a.type === 'remote') return isTileId(a.id) ? { type: 'remote', id: a.id } : null;
	if (a.type === 'spawn') {
		if (typeof a.repo !== 'string' || !a.repo.trim()) return null;
		if (typeof a.task !== 'string' || !a.task.trim()) return null;
		const base = typeof a.base === 'string' && a.base.trim() ? a.base.trim() : null;
		return { type: 'spawn', repo: a.repo.trim(), base, task: a.task.trim() };
	}
	if (a.type === 'input') {
		if (!isTileId(a.id) || typeof a.text !== 'string') return null;
		// A dictated "new line" must stay ONE message: a CR would submit it early, and a LF
		// would split it. Collapse both to spaces before it can reach the PTY.
		const text = a.text.replace(/[\r\n]+/g, ' ').trim();
		if (!text || text.length > MAX_INPUT) return null;
		return { type: 'input', id: a.id, text };
	}
	return null;
}
