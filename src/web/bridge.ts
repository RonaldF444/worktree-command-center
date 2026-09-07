// Browser side of electron/remote/protocol.ts. Ported from The Spire's remote bridge, reduced:
// no relay, no email code. BROWSER-ONLY MODULE: no Node imports, ever. Timers, sockets and
// storage are injectable so the unit test runs under vitest's node environment.
import type { ClientFrame, ServerFrame } from '../../electron/remote/protocol';

export type BridgeStatus = 'connecting' | 'login' | 'open' | 'offline';
export interface AuthOutcome { ok: boolean; error?: string; }
export interface SocketLike {
	readyState: number; send(d: string): void; close(): void;
	onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null;
}
export interface TokenStorage { get(): string | null; set(token: string, remember: boolean): void; clear(): void; }
export interface BridgeDeps {
	url: string;
	createSocket?: (url: string) => SocketLike;
	storage?: TokenStorage;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
	setInterval?: (cb: () => void, ms: number) => unknown;
	clearInterval?: (h: unknown) => void;
	document?: { visibilityState: string; addEventListener(type: string, cb: () => void): void };
}
export interface Bridge {
	invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
	on(channel: string, cb: (payload: unknown) => void): () => void;
	status(): BridgeStatus;
	onStatus(cb: (s: BridgeStatus) => void): () => void;
	submitPassword(password: string, remember: boolean, deviceLabel: string): Promise<AuthOutcome>;
	logout(): void;
}

export const TOKEN_KEY = 'wcc.deviceToken';
const PING_MS = 20_000, MAX_MISSED_PONGS = 3;
const BACKOFF_MIN_MS = 1_000, BACKOFF_MAX_MS = 60_000;
const INVOKE_TIMEOUT_MS = 30_000, AUTH_TIMEOUT_MS = 30_000, MAX_QUEUE = 100;
const OPEN = 1;

/** Exactly one of localStorage/sessionStorage holds the token: "remember" picks which. */
export function defaultStorage(): TokenStorage {
	const safe = (fn: () => void): void => { try { fn(); } catch { /* storage blocked */ } };
	return {
		get() { try { return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
		set(t, remember) { safe(() => { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t); (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY); }); },
		clear() { safe(() => { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }); },
	};
}

export function createBridge(deps: BridgeDeps): Bridge {
	const createSocket = deps.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
	const storage = deps.storage ?? defaultStorage();
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const setIv = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
	const clearIv = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

	let ws: SocketLike | null = null;
	let status: BridgeStatus = 'connecting';
	let authed = false;
	let backoff = BACKOFF_MIN_MS;
	let reconnectTimer: unknown = null;
	let pingTimer: unknown = null;
	let missedPongs = 0;
	let seq = 0;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const queue: Array<{ id: string; channel: string; payload: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
	const listeners = new Map<string, Set<(p: unknown) => void>>();
	const statusListeners = new Set<(s: BridgeStatus) => void>();
	const authWaiters: Array<{ id: string; remember: boolean; resolve: (o: AuthOutcome) => void }> = [];

	const setStatus = (s: BridgeStatus): void => { if (status === s) return; status = s; for (const cb of statusListeners) cb(s); };
	const send = (f: ClientFrame): void => { if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(f)); };

	function flushQueue(): void {
		for (const q of queue.splice(0)) { pending.set(q.id, { resolve: q.resolve, reject: q.reject }); send({ t: 'invoke', id: q.id, channel: q.channel, payload: q.payload }); }
	}
	function failPending(msg: string): void { for (const p of pending.values()) p.reject(new Error(msg)); pending.clear(); }
	function failAuthWaiters(msg: string): void { for (const w of authWaiters.splice(0)) w.resolve({ ok: false, error: msg }); }

	function completeAuth(): void {
		authed = true;
		backoff = BACKOFF_MIN_MS; // the ONE place backoff resets: protocol success, never socket open
		setStatus('open');
		flushQueue();
	}
	function deauth(): void { authed = false; setStatus('login'); }

	function handleAuth(f: Extract<ServerFrame, { t: 'auth' }>): void {
		const waiter = authWaiters.shift();
		if (waiter) {
			if (f.ok) { if (f.deviceToken) storage.set(f.deviceToken, waiter.remember); completeAuth(); }
			waiter.resolve(f.ok ? { ok: true } : { ok: false, error: f.error });
			return;
		}
		if (f.ok) { completeAuth(); return; }
		storage.clear(); // the token we auto-presented is dead (or the device was revoked)
		deauth();
	}

	function handleFrame(raw: unknown): void {
		let f: ServerFrame;
		try { f = JSON.parse(String(raw)) as ServerFrame; } catch { return; }
		if (!f || typeof f !== 'object') return;
		switch (f.t) {
			case 'reply': {
				const p = pending.get(f.id); if (!p) return;
				pending.delete(f.id);
				if (f.ok) p.resolve(f.value);
				else { if (f.error === 'unauthenticated') deauth(); p.reject(new Error(f.error)); }
				return;
			}
			case 'event': { const set = listeners.get(f.channel); if (set) for (const cb of set) cb(f.payload); return; }
			case 'auth': handleAuth(f); return;
			case 'pong': missedPongs = 0; return;
			default: return;
		}
	}

	function stopPing(): void { if (pingTimer !== null) { clearIv(pingTimer); pingTimer = null; } }
	function startPing(sock: SocketLike): void {
		stopPing(); missedPongs = 0;
		pingTimer = setIv(() => {
			if (++missedPongs >= MAX_MISSED_PONGS) { socketDown(sock, 'no pong'); try { sock.close(); } catch { /* detached */ } return; }
			send({ t: 'ping' });
		}, PING_MS);
	}
	function socketDown(sock: SocketLike, reason: string): void {
		if (ws !== sock) return;
		stopPing(); ws = null; authed = false;
		failPending(reason); failAuthWaiters(reason);
		scheduleReconnect();
	}
	function scheduleReconnect(): void {
		if (reconnectTimer !== null) return;
		setStatus('offline');
		reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, backoff);
		backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
	}
	function connect(): void {
		setStatus('connecting'); authed = false;
		let sock: SocketLike;
		try { sock = createSocket(deps.url); } catch { scheduleReconnect(); return; }
		ws = sock;
		sock.onopen = () => {
			startPing(sock);
			const token = storage.get();
			if (token) send({ t: 'auth', deviceToken: token });
			else setStatus('login');
		};
		sock.onmessage = (ev) => handleFrame(ev.data);
		sock.onerror = () => {};
		sock.onclose = () => socketDown(sock, 'connection lost');
	}

	const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined);
	doc?.addEventListener('visibilitychange', () => {
		if (doc.visibilityState !== 'visible' || reconnectTimer === null) return;
		clearTimer(reconnectTimer); reconnectTimer = null; connect();
	});
	connect();

	return {
		invoke<T>(channel: string, payload?: unknown): Promise<T> {
			const id = String(++seq);
			return new Promise<T>((resolve, reject) => {
				const ready = !!ws && ws.readyState === OPEN && authed;
				if (!ready && queue.length >= MAX_QUEUE) { reject(new Error('too many invokes waiting for a connection')); return; }
				const timer = setTimer(() => { pending.delete(id); const i = queue.findIndex((q) => q.id === id); if (i !== -1) queue.splice(i, 1); reject(new Error(`invoke timed out: ${channel}`)); }, INVOKE_TIMEOUT_MS);
				const settle = { resolve: (v: unknown) => { clearTimer(timer); resolve(v as T); }, reject: (e: Error) => { clearTimer(timer); reject(e); } };
				if (ready) { pending.set(id, settle); send({ t: 'invoke', id, channel, payload }); }
				else queue.push({ id, channel, payload, ...settle });
			});
		},
		on(channel, cb) {
			let set = listeners.get(channel); if (!set) { set = new Set(); listeners.set(channel, set); }
			set.add(cb); return () => { set!.delete(cb); };
		},
		status: () => status,
		onStatus(cb) { statusListeners.add(cb); return () => { statusListeners.delete(cb); }; },
		submitPassword(password, remember, deviceLabel) {
			if (!ws || ws.readyState !== OPEN) return Promise.resolve({ ok: false, error: 'not connected' });
			const id = String(++seq);
			return new Promise<AuthOutcome>((resolve) => {
				const timer = setTimer(() => { const i = authWaiters.findIndex((w) => w.id === id); if (i !== -1) authWaiters.splice(i, 1); resolve({ ok: false, error: 'auth timed out' }); }, AUTH_TIMEOUT_MS);
				authWaiters.push({ id, remember, resolve: (o) => { clearTimer(timer); resolve(o); } });
				send({ t: 'auth', password, deviceLabel });
			});
		},
		logout() {
			storage.clear();
			const sock = ws;
			if (sock) { try { sock.close(); } catch { /* already closed */ } }
		},
	};
}
