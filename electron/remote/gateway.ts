import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFile, stat } from 'fs/promises';
import { resolve as resolvePath, relative, isAbsolute, extname, join } from 'path';
import { isIP } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { parseClientFrame, type ServerFrame, MAX_FRAME_BYTES, DEVICE_REVOKED_ERROR, DEVICE_REVOKED_CLOSE_CODE, SLOW_CONSUMER_CLOSE_CODE, WS_PATH } from './protocol';
import type { AuthFrame, AuthResult } from './auth';
import { isTailscaleIp } from '../remote-net';

export type Handler = (payload: unknown) => Promise<unknown>;
export type HandlerTable = Record<string, Handler>;

export interface GatewayOpts {
	port: number;
	hosts: string[];
	staticDir: string;
	table: HandlerTable;
	authenticate: (frame: AuthFrame, ip: string) => Promise<AuthResult>;
	phoneRoutes?: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;
	backpressureLimitBytes?: number;
	heartbeatSweepMs?: number;
	heartbeatTimeoutMs?: number;
	allowHost?: (hostname: string) => boolean;
}
export interface GatewayHandle {
	boundHosts(): string[];
	boundPort(): number;
	addHost(host: string): Promise<boolean>;
	broadcast(channel: string, payload: unknown): void;
	endDeviceSessions(deviceIds: readonly string[]): number;
	clientCount(): number;
	onClientCount(cb: (n: number) => void): () => void;
	close(): Promise<void>;
}

const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_SWEEP_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_UNAUTHENTICATED_FRAMES = 120;
const MAX_UNAUTHED_FRAME_BYTES = 4096;
const MAX_AUTH_ATTEMPTS_PER_SOCKET = 10;
const MAX_AUTH_ATTEMPTS_PER_IP = 12;
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_SOCKETS = 64;
const SLOW_CONSUMER_LINGER_MS = 5000;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export const APP_SHELL_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
};

// The phone page (and any other opts.phoneRoutes-served route) has an inline script, so it
// must NOT get the app-shell CSP above — that has no 'unsafe-inline' for script-src and would
// silently break it. Still lock the rest down: no framing, no MIME sniffing, no referrer leak.
export const PHONE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'Content-Security-Policy': "frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
};

interface ClientState { authed: boolean; deviceId?: string; lastSeen: number; authAttempts: number; unauthedFrames: number; blocked: boolean; }

function routePathname(url: string | undefined): string {
	try { return new URL(url ?? '/', 'http://localhost').pathname; } catch { return ''; }
}

/** Strips `:port` off a Host header, handling a bracketed IPv6 literal (`[::1]:port`). Lowercased. */
function hostnameOf(hostHeader: string | undefined): string {
	if (!hostHeader) return '';
	const h = hostHeader.trim();
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		return (end === -1 ? h.slice(1) : h.slice(1, end)).toLowerCase();
	}
	const idx = h.lastIndexOf(':');
	return (idx === -1 ? h : h.slice(0, idx)).toLowerCase();
}

async function serveStatic(staticDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const plain = (code: number, body: string): void => { res.writeHead(code, { 'Content-Type': 'text/plain', ...APP_SHELL_SECURITY_HEADERS }); res.end(body); };
	let pathname: string;
	try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); } catch { plain(400, 'Bad request'); return; }
	try {
		const resolved = resolvePath(staticDir, '.' + pathname);
		const rel = relative(staticDir, resolved);
		// startsWith('..') = escaped upward; isAbsolute = different drive (Windows `/C:/...`).
		if (rel.startsWith('..') || isAbsolute(rel)) { plain(403, 'Forbidden'); return; }
		let file = resolved;
		if (extname(resolved) !== '') {
			try { await stat(file); } catch { plain(404, 'Not found'); return; }
		} else {
			file = join(staticDir, 'index.html');
		}
		const data = await readFile(file);
		res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', ...APP_SHELL_SECURITY_HEADERS });
		res.end(data);
	} catch (err) {
		console.error('[remote] static serve failed for', req.url, err);
		plain(500, 'Internal error');
	}
}

export async function startGateway(opts: GatewayOpts): Promise<GatewayHandle> {
	const backpressure = opts.backpressureLimitBytes ?? BACKPRESSURE_LIMIT_BYTES;
	const sockets = new Map<WebSocket, ClientState>();
	const authAttemptsByIp = new Map<string, { count: number; windowStart: number }>();
	const countListeners = new Set<(n: number) => void>();
	let lastCount = 0;
	let closed = false;
	const servers = new Map<string, Server>();
	let port = opts.port;
	const notifyCount = (): void => {
		const n = [...sockets.values()].filter((s) => s.authed).length;
		if (n === lastCount) return;
		lastCount = n;
		for (const cb of countListeners) { try { cb(n); } catch (err) { console.error('[remote] client-count listener threw:', err); } }
	};
	const sendFrame = (ws: WebSocket, f: ServerFrame): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)); };
	// Blocks DNS rebinding: a request/upgrade must target a Host we actually bound (or `localhost`,
	// or one the caller explicitly trusts via allowHost — e.g. a Tailscale MagicDNS name).
	const hostAllowed = (hostHeader: string | undefined): boolean => {
		const hostname = hostnameOf(hostHeader);
		return servers.has(hostname) || hostname === 'localhost' || (opts.allowHost?.(hostname) ?? false);
	};

	function dispatch(raw: string, ip: string, ws: WebSocket, state: ClientState): void {
		if (state.blocked) return;
		state.lastSeen = Date.now();
		if (!state.authed && raw.length > MAX_UNAUTHED_FRAME_BYTES) { state.blocked = true; ws.close(1008, 'frame too large'); return; }
		if (!state.authed && ++state.unauthedFrames > MAX_UNAUTHENTICATED_FRAMES) { state.blocked = true; ws.close(1008, 'too many frames'); return; }
		const frame = parseClientFrame(raw);
		if (!frame) return;
		if (frame.t === 'ping') { sendFrame(ws, { t: 'pong' }); return; }
		if (frame.t === 'auth') {
			state.authAttempts++;
			const now = Date.now();
			const ipState = authAttemptsByIp.get(ip);
			const active = !!ipState && now - ipState.windowStart <= AUTH_ATTEMPT_WINDOW_MS;
			const count = active ? ipState!.count + 1 : 1;
			authAttemptsByIp.set(ip, { count, windowStart: active ? ipState!.windowStart : now });
			if (state.authAttempts > MAX_AUTH_ATTEMPTS_PER_SOCKET || count > MAX_AUTH_ATTEMPTS_PER_IP) { state.blocked = true; ws.close(1008, 'too many auth attempts'); return; }
			opts.authenticate(frame, ip).then((r) => {
				if (r.ok) { state.authed = true; state.deviceId = r.deviceId; state.unauthedFrames = 0; authAttemptsByIp.delete(ip); notifyCount(); }
				// Named fields only — never spread a result that may carry store internals.
				sendFrame(ws, r.ok ? { t: 'auth', ok: true, deviceToken: r.deviceToken, deviceId: r.deviceId } : { t: 'auth', ok: false, error: r.error });
			}).catch((err: unknown) => {
				console.error('[remote] authenticate threw:', err);
				sendFrame(ws, { t: 'auth', ok: false, error: 'authentication failed' });
			});
			return;
		}
		void (async () => {
			if (!state.authed) { sendFrame(ws, { t: 'reply', id: frame.id, ok: false, error: 'unauthenticated' }); return; }
			if (!Object.prototype.hasOwnProperty.call(opts.table, frame.channel)) { sendFrame(ws, { t: 'reply', id: frame.id, ok: false, error: 'unknown channel' }); return; }
			try {
				const value = await opts.table[frame.channel]!(frame.payload);
				sendFrame(ws, { t: 'reply', id: frame.id, ok: true, value });
			} catch (err) {
				const msg = err instanceof Error ? err.message : '';
				// The one handler error allowed through verbatim: payload validation (Task 8 throws this literal).
				sendFrame(ws, { t: 'reply', id: frame.id, ok: false, error: msg === 'invalid payload' ? msg : 'request failed' });
				if (msg !== 'invalid payload') console.error('[remote] handler threw for', frame.channel, err);
			}
		})();
	}

	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES,
		verifyClient: (info, cb) => {
			if (!hostAllowed(info.req.headers.host)) { cb(false, 421, 'Misdirected'); return; }
			const origin = info.origin;
			if (!origin) { cb(true); return; }
			try { if (new URL(origin).host === info.req.headers.host) { cb(true); return; } } catch { /* malformed */ }
			cb(false, 403, 'Forbidden origin');
		},
	});
	wss.on('connection', (ws, req) => {
		if (sockets.size >= MAX_SOCKETS) { ws.close(1013, 'too many connections'); return; }
		const state: ClientState = { authed: false, lastSeen: Date.now(), authAttempts: 0, unauthedFrames: 0, blocked: false };
		sockets.set(ws, state);
		const ip = req.socket.remoteAddress ?? 'unknown';
		ws.on('message', (raw) => dispatch(raw.toString(), ip, ws, state));
		const drop = (): void => { sockets.delete(ws); notifyCount(); };
		ws.on('close', drop);
		ws.on('error', drop);
	});

	const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
		if (!hostAllowed(req.headers.host)) {
			res.writeHead(421, { 'Content-Type': 'text/plain', ...APP_SHELL_SECURITY_HEADERS });
			res.end('Misdirected Request');
			return;
		}
		const pathname = routePathname(req.url);
		for (const [k, v] of Object.entries(PHONE_SECURITY_HEADERS)) res.setHeader(k, v);
		if (opts.phoneRoutes?.(req, res, pathname)) return;
		void serveStatic(opts.staticDir, req, res);
	};
	const upgradeHandler = (req: IncomingMessage, socket: import('stream').Duplex, head: Buffer): void => {
		if (routePathname(req.url) === WS_PATH) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
		else socket.destroy();
	};

	async function listenOn(host: string): Promise<boolean> {
		if (closed || servers.has(host)) return false;
		if (!(isIP(host) === 4 && (host.startsWith('127.') || isTailscaleIp(host)))) {
			console.error(`[remote] refused to bind ${host}: not loopback or Tailscale`);
			return false;
		}
		const srv = createServer(requestHandler);
		srv.on('upgrade', upgradeHandler);
		try {
			await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(port, host, () => res()); });
		} catch (err) { console.error('[remote] bind failed on', host, err); return false; }
		const addr = srv.address();
		if (addr && typeof addr === 'object') port = addr.port;
		servers.set(host, srv);
		console.log(`[remote] gateway on http://${host}:${port}/`);
		return true;
	}
	const first = await listenOn(opts.hosts[0] ?? '127.0.0.1');
	if (!first) { wss.close(); throw new Error(`could not bind ${opts.hosts[0] ?? '127.0.0.1'}:${opts.port}`); }
	for (const h of opts.hosts.slice(1)) await listenOn(h);

	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [ws, s] of sockets) if (now - s.lastSeen > (opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS)) ws.terminate();
		for (const [ip, e] of authAttemptsByIp) if (now - e.windowStart > AUTH_ATTEMPT_WINDOW_MS) authAttemptsByIp.delete(ip);
	}, opts.heartbeatSweepMs ?? HEARTBEAT_SWEEP_MS);
	sweep.unref();

	return {
		boundHosts: () => [...servers.keys()],
		boundPort: () => port,
		addHost: listenOn,
		broadcast(channel, payload) {
			let json: string;
			try { json = JSON.stringify({ t: 'event', channel, payload } satisfies ServerFrame); } catch (err) { console.error('[remote] cannot serialize event', channel, err); return; }
			for (const [ws, s] of sockets) {
				if (!s.authed || ws.readyState !== WebSocket.OPEN) continue;
				if (ws.bufferedAmount > backpressure) {
					ws.close(SLOW_CONSUMER_CLOSE_CODE, 'slow-consumer');
					// A peer that never acks the close (e.g. still not draining) would otherwise pin
					// this socket open indefinitely; force it after a grace period.
					setTimeout(() => ws.terminate(), SLOW_CONSUMER_LINGER_MS).unref();
					continue;
				}
				ws.send(json);
			}
		},
		endDeviceSessions(ids) {
			const targets = new Set(ids);
			let ended = 0;
			for (const [ws, s] of sockets) {
				if (!s.deviceId || !targets.has(s.deviceId)) continue;
				s.authed = false; s.deviceId = undefined; ended++;
				sendFrame(ws, { t: 'auth', ok: false, error: DEVICE_REVOKED_ERROR });
				ws.close(DEVICE_REVOKED_CLOSE_CODE, 'device-revoked');
			}
			notifyCount();
			return ended;
		},
		clientCount: () => lastCount,
		onClientCount(cb) { countListeners.add(cb); return () => { countListeners.delete(cb); }; },
		async close() {
			if (closed) return;
			closed = true;
			clearInterval(sweep);
			for (const ws of sockets.keys()) ws.terminate();
			wss.close();
			await Promise.all([...servers.values()].map((s) => { s.closeAllConnections(); return new Promise<void>((r) => s.close(() => r())); }));
			servers.clear();
		},
	};
}
