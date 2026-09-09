/** What the browser renders from. Published by the desktop on every grid change (debounced) and
 *  on the phone's 2s timer. Pure types + a debounce helper; the builder lives in app.ts because it
 *  needs the live grid, workspaces and usage widget. */
import type { PortItem } from './port-registry';

export interface FloorTile { id: number; name: string; repo: string; branch: string; state: string; remoteOn: boolean; hidden: boolean; cols: number; rows: number; model: string | null; effort: string | null; locked: boolean; }
export interface FloorKane { name: string; state: string; cols: number; rows: number; visible: boolean; }
/** One dev server a terminal printed: what the browser lists and main tunnels (Tailscale only). */
export interface FloorPort { port: number; host: string; path: string; url: string; tileId: number; name: string; repo: string; }
export const toFloorPorts = (items: PortItem[]): FloorPort[] =>
	items.map(({ port, host, path, url, tileId, name, repo }) => ({ port, host, path, url, tileId, name, repo }));
/** Cheap change detection for the publish poll: owner + host:port + path, order-free. */
export const portsSignature = (items: FloorPort[]): string =>
	items.map((i) => `${i.tileId}|${i.host}:${i.port}${i.path}`).sort().join('\n');

export interface FloorUsage { sessionPct: number | null; sessionReset: string | null; weekPct: number | null; weekReset: string | null; fablePct: number | null; }
export interface FloorState {
	workspaceId: string;
	centeredId: number | null;
	terminals: FloorTile[];
	kane: FloorKane | null;
	workspaces: Array<{ id: string; name: string; active: boolean }>;
	repos: string[];
	theme: string;
	usage: FloorUsage | null;
	ports: FloorPort[];
}

export function debounceFloor(
	publish: (s: FloorState) => void,
	build: () => FloorState,
	ms = 100,
	setTimer: (cb: () => void, ms: number) => unknown = (cb, m) => globalThis.setTimeout(cb, m),
	clearTimer: (h: unknown) => void = (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
): { request(): void; flush(): void } {
	let timer: unknown = null;
	const fire = (): void => { timer = null; publish(build()); };
	return {
		request() { if (timer === null) timer = setTimer(fire, ms); },
		flush() { if (timer !== null) { clearTimer(timer); timer = null; } publish(build()); },
	};
}
