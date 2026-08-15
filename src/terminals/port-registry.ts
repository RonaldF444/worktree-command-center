import type { PortHit } from './port-scan';

/** One live dev server, owned by the terminal that most recently printed it. */
export interface PortEntry {
	key: string;   // normalised `host:port`
	url: string;
	host: string;
	port: number;
	path: string;  // last seen path, rendered as the row's subtitle
	tileId: number;
	firstSeenMs: number;
	lastSeenMs: number;
}

/** A PortEntry with the display fields the grid resolves (see TerminalsGrid.portItems). */
export interface PortItem extends PortEntry { name: string; repo: string; }

export const MAX_ENTRIES = 200;

/** Every localhost URL the sessions in ONE grid have printed. Live-only and never persisted:
 *  a remembered URL outlives its server, and a stale row is worse than a missing one because
 *  it looks trustworthy. Rows die with the terminal that printed them (see forget). */
export class PortRegistry {
	private entries = new Map<string, PortEntry>();

	note(tileId: number, hit: PortHit, nowMs: number): void {
		const key = `${hit.host}:${hit.port}`;
		const prev = this.entries.get(key);
		// Newest printer owns the row: when a killed server frees :3000 and another worktree
		// grabs it, the row moves rather than the list growing a duplicate.
		this.entries.set(key, {
			key, url: hit.url, host: hit.host, port: hit.port, path: hit.path, tileId,
			firstSeenMs: prev?.firstSeenMs ?? nowMs,
			lastSeenMs: nowMs,
		});
		this.evict();
	}

	forget(tileId: number): void {
		for (const [key, e] of this.entries) if (e.tileId === tileId) this.entries.delete(key);
	}

	list(): PortEntry[] {
		return [...this.entries.values()].sort((a, b) => a.tileId - b.tileId || a.port - b.port);
	}

	private evict(): void {
		while (this.entries.size > MAX_ENTRIES) {
			let oldestKey = '';
			let oldestAt = Infinity;
			for (const [key, e] of this.entries) if (e.lastSeenMs < oldestAt) { oldestAt = e.lastSeenMs; oldestKey = key; }
			this.entries.delete(oldestKey);
		}
	}
}
