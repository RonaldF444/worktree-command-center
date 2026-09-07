/** Main → desktop-renderer request/reply. The renderer owns every terminal, so most browser
 *  invokes are forwarded here and answered by src/app.ts. Pure (no electron import) so it
 *  unit-tests; main.ts supplies `send` = webContents.send('remote:invoke', ...). */
export interface RpcReply { id: string; ok: boolean; value?: unknown; error?: string; }
export interface RendererRpc {
	invoke(channel: string, payload: unknown): Promise<unknown>;
	handleReply(r: unknown): void;
	rejectAll(): void;
	pendingCount(): number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const FAILED = 'request failed';

export function createRendererRpc(deps: {
	send: (msg: { id: string; channel: string; payload: unknown }) => void;
	timeoutMs?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}): RendererRpc {
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
	let seq = 0;

	function settle(id: string): { resolve: (v: unknown) => void; reject: (e: Error) => void } | null {
		const p = pending.get(id);
		if (!p) return null;
		pending.delete(id);
		clearTimer(p.timer);
		return p;
	}

	return {
		invoke(channel, payload) {
			const id = String(++seq);
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimer(() => { settle(id)?.reject(new Error(FAILED)); }, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				try { deps.send({ id, channel, payload }); }
				catch (err) { console.error('[remote] rpc send failed:', err); settle(id)?.reject(new Error(FAILED)); }
			});
		},
		handleReply(r) {
			if (!r || typeof r !== 'object') return;
			const { id, ok, value, error } = r as Partial<RpcReply>;
			if (typeof id !== 'string') return;
			const p = settle(id);
			if (!p) return;
			if (ok) p.resolve(value);
			else { if (error) console.error('[remote] renderer rpc failed:', error); p.reject(new Error(FAILED)); }
		},
		rejectAll() { for (const id of [...pending.keys()]) settle(id)?.reject(new Error(FAILED)); },
		pendingCount: () => pending.size,
	};
}
