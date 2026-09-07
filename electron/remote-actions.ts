import { EFFORT_LEVELS } from '../src/terminals/spawn-options';

/** The actions the phone may send, validated in the MAIN process before they reach the
 *  renderer. The page is token-gated, but a typo'd or hostile body must never become a
 *  keystroke in a live Claude session — so nothing is forwarded until it parses cleanly. */
export type RemoteAction =
	| { type: 'remote'; id: number }
	| { type: 'spawn'; repo: string; base: string | null; task: string }
	| { type: 'input'; id: number; text: string; name: string }
	| { type: 'center'; id: number }
	| { type: 'workspace'; id: string };

/** Longest message accepted from the phone. Speech transcripts are short; the HTTP body cap
 *  (100KB) is far too generous for something that gets typed into an agent. */
export const MAX_INPUT = 4000;

/** Kane's synthetic id on the floor (TerminalsGrid.floorState appends him with this id — see
 *  terminals-grid.ts). Negative and distinct from every real tile id (tiles count up from 0),
 *  so it can never collide with one. */
export const KANE_ID = -1;

const isTileId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** `input` may target a real tile OR Kane. `remote` (the Claude-remote-control toggle) must
 *  keep rejecting Kane — he has no such toggle and the page never renders one for him — so it
 *  keeps using isTileId directly rather than this. */
const isInputTargetId = (v: unknown): v is number => isTileId(v) || v === KANE_ID;

/** Validate + normalize one action. `null` means reject: it is dropped, never forwarded. */
export function parseRemoteAction(raw: unknown): RemoteAction | null {
	if (!raw || typeof raw !== 'object') return null;
	const a = raw as Record<string, unknown>;
	if (a.type === 'remote') return isTileId(a.id) ? { type: 'remote', id: a.id } : null;
	// The phone mirrors the desk: centring a tile there moves the spotlight here. Kane is
	// rejected on purpose — on the desk he is a side console, not a tile on the stage, so
	// there is nothing to centre. (He is still a valid `input` target; see isInputTargetId.)
	if (a.type === 'center') return isTileId(a.id) ? { type: 'center', id: a.id } : null;
	if (a.type === 'workspace') {
		// A workspace id is a config string, not a tile id. An id that no longer exists is a
		// no-op downstream (switchTo already guards), so shape is all we check here.
		if (typeof a.id !== 'string' || !a.id.trim()) return null;
		return { type: 'workspace', id: a.id.trim() };
	}
	if (a.type === 'spawn') {
		if (typeof a.repo !== 'string' || !a.repo.trim()) return null;
		if (typeof a.task !== 'string' || !a.task.trim()) return null;
		const base = typeof a.base === 'string' && a.base.trim() ? a.base.trim() : null;
		return { type: 'spawn', repo: a.repo.trim(), base, task: a.task.trim() };
	}
	if (a.type === 'input') {
		if (!isInputTargetId(a.id) || typeof a.text !== 'string') return null;
		// Tile ids are per-workspace (each grid's counter starts at 1), and the phone always
		// targets the currently-active workspace. A stale phone list (switched workspace since
		// the last poll) could otherwise deliver text into an unrelated session that executes
		// it with no confirmation. Requiring the card's name here — checked again against the
		// live tile in sendToId — is the fail-safe: reject rather than risk the wrong agent.
		if (typeof a.name !== 'string' || !a.name.trim()) return null;
		// A dictated "new line" must stay ONE message: a CR would submit it early, and a LF
		// would split it. Collapse both to spaces before it can reach the PTY.
		const text = a.text.replace(/[\r\n]+/g, ' ').trim();
		if (!text || text.length > MAX_INPUT) return null;
		return { type: 'input', id: a.id, text, name: a.name.trim() };
	}
	return null;
}

/** The browser's forwarded invokes, validated in MAIN before they cross IPC to the renderer.
 *  Same discipline as parseRemoteAction: nothing reaches a live session until it parses cleanly.
 *  Unlike the phone's `input`, `tile:write` is RAW keystrokes — the browser holds live state from
 *  `floor:state` events (not a 2s poll), so the name-must-match guard is not needed here. */
export type TileInvoke =
	| { channel: 'floor:state' } | { channel: 'board:get' } | { channel: 'kane:snapshot' }
	| { channel: 'tile:snapshot' | 'tile:center' | 'tile:hide' | 'tile:show' | 'tile:kill'; id: number }
	| { channel: 'tile:write'; id: number; data: string }
	| { channel: 'kane:write'; data: string }
	| { channel: 'tile:rename'; id: number; name: string }
	| { channel: 'tile:spawn'; repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null }
	| { channel: 'workspace:switch'; id: string };

export const FORWARDED_CHANNELS: ReadonlySet<string> = new Set([
	'floor:state', 'board:get', 'kane:snapshot', 'tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill',
	'tile:write', 'kane:write', 'tile:rename', 'tile:spawn', 'workspace:switch',
]);
export const MAX_WRITE = 65536;
export const MAX_NAME = 80;

const ID_CHANNELS = new Set(['tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill']);
const optStr = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function parseTileInvoke(channel: string, payload: unknown): TileInvoke | null {
	if (channel === 'floor:state' || channel === 'board:get' || channel === 'kane:snapshot') return { channel };
	const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
	if (ID_CHANNELS.has(channel)) return isTileId(p.id) ? { channel: channel as 'tile:snapshot', id: p.id } : null;
	if (channel === 'tile:write') {
		if (!isTileId(p.id) || typeof p.data !== 'string' || !p.data || p.data.length > MAX_WRITE) return null;
		return { channel, id: p.id, data: p.data };
	}
	if (channel === 'kane:write') {
		if (typeof p.data !== 'string' || !p.data || p.data.length > MAX_WRITE) return null;
		return { channel, data: p.data };
	}
	if (channel === 'tile:rename') {
		if (!isTileId(p.id) || typeof p.name !== 'string') return null;
		const name = p.name.trim();
		if (!name || name.length > MAX_NAME) return null;
		return { channel, id: p.id, name };
	}
	if (channel === 'tile:spawn') {
		const repo = optStr(p.repo), task = optStr(p.task, MAX_INPUT);
		if (!repo || !task) return null;
		const effort = optStr(p.effort, 20);
		if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return null;
		return { channel, repo, base: optStr(p.base), task, model: optStr(p.model, 60), effort, name: optStr(p.name, MAX_NAME) };
	}
	if (channel === 'workspace:switch') {
		const id = optStr(p.id);
		return id ? { channel, id } : null;
	}
	return null;
}
