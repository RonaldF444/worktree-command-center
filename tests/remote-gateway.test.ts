import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import WebSocket from 'ws';
import { startGateway, type GatewayHandle } from '../electron/remote/gateway';
import type { AuthFrame, AuthResult } from '../electron/remote/auth';

// `fetch()` treats `Host` as a forbidden header and silently drops it, so a couple of the
// Host-header-guard tests below need a raw request where we control every header sent.
function getWithHost(base: string, path: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const u = new URL(path, base);
		const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.once('error', reject);
		req.end();
	});
}

let dir: string; let gw: GatewayHandle | null = null;
const okAuth = async (f: AuthFrame): Promise<AuthResult> =>
	f.password === 'pw' || f.deviceToken === 'tok' ? { ok: true, deviceId: f.deviceToken === 'tok' ? 'dev-tok' : 'dev-pw', deviceToken: 'tok' } : { ok: false, error: 'invalid password' };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-gw-'));
	fs.writeFileSync(path.join(dir, 'index.html'), '<html>app</html>');
	fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
});
afterEach(async () => { await gw?.close(); gw = null; fs.rmSync(dir, { recursive: true, force: true }); });

async function start(extra: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<{ base: string; wsUrl: string }> {
	gw = await startGateway({ port: 0, hosts: ['127.0.0.1'], staticDir: dir, table: { echo: async (p) => p, boom: async () => { throw new Error('secret path C:\\x'); } }, authenticate: okAuth, ...extra });
	const port = gw.boundPort();
	return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}
function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
	return new Promise((resolve, reject) => { const s = new WebSocket(url, { headers }); s.once('open', () => resolve(s)); s.once('error', reject); });
}
function next(s: WebSocket): Promise<any> { return new Promise((r) => s.once('message', (d) => r(JSON.parse(d.toString())))); }
function closed(s: WebSocket): Promise<number> { return new Promise((r) => s.once('close', (code) => r(code))); }
async function login(s: WebSocket): Promise<void> { s.send(JSON.stringify({ t: 'auth', password: 'pw' })); expect((await next(s)).ok).toBe(true); }

describe('static + routes', () => {
	it('serves index.html at / and extension-less paths, assets by name, 404 for missing assets', async () => {
		const { base } = await start();
		expect(await (await fetch(`${base}/`)).text()).toBe('<html>app</html>');
		expect(await (await fetch(`${base}/some/route`)).text()).toBe('<html>app</html>');
		expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)');
		expect((await fetch(`${base}/missing.js`)).status).toBe(404);
	});
	it('refuses path escapes including an embedded drive letter', async () => {
		const { base } = await start();
		expect((await fetch(`${base}/..%2F..%2Fx.txt`)).status).not.toBe(200);
		expect((await fetch(`${base}/C:/Windows/win.ini`)).status).toBe(403);
	});
	it('sets security headers', async () => {
		const { base } = await start();
		const r = await fetch(`${base}/`);
		expect(r.headers.get('x-frame-options')).toBe('DENY');
		expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		expect(r.headers.get('x-content-type-options')).toBe('nosniff');
	});
	it('mounts the phone routes when given', async () => {
		const { base } = await start({ phoneRoutes: (_req, res, pathname) => { if (pathname === '/phone') { res.writeHead(200); res.end('phone'); return true; } return false; } });
		expect(await (await fetch(`${base}/phone`)).text()).toBe('phone');
	});
});

describe('websocket auth + dispatch', () => {
	it('rejects invokes until authed, then dispatches, with fixed error strings', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		s.send(JSON.stringify({ t: 'invoke', id: '1', channel: 'echo', payload: 1 }));
		expect(await next(s)).toEqual({ t: 'reply', id: '1', ok: false, error: 'unauthenticated' });
		await login(s);
		s.send(JSON.stringify({ t: 'invoke', id: '2', channel: 'echo', payload: { a: 1 } }));
		expect(await next(s)).toEqual({ t: 'reply', id: '2', ok: true, value: { a: 1 } });
		s.send(JSON.stringify({ t: 'invoke', id: '3', channel: 'nope' }));
		expect(await next(s)).toEqual({ t: 'reply', id: '3', ok: false, error: 'unknown channel' });
		s.send(JSON.stringify({ t: 'invoke', id: '4', channel: 'constructor' }));
		expect(await next(s)).toEqual({ t: 'reply', id: '4', ok: false, error: 'unknown channel' });
		s.send(JSON.stringify({ t: 'invoke', id: '5', channel: 'boom' }));
		expect(await next(s)).toEqual({ t: 'reply', id: '5', ok: false, error: 'request failed' });
		s.send('garbage');
		s.send(JSON.stringify({ t: 'ping' }));
		expect(await next(s)).toEqual({ t: 'pong' });
		s.close();
	});
	it('auth reply carries only named fields; a wrong password answers ok:false', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		s.send(JSON.stringify({ t: 'auth', password: 'bad' }));
		expect(await next(s)).toEqual({ t: 'auth', ok: false, error: 'invalid password' });
		s.send(JSON.stringify({ t: 'auth', deviceToken: 'tok' }));
		expect(await next(s)).toEqual({ t: 'auth', ok: true, deviceToken: 'tok', deviceId: 'dev-tok' });
		s.close();
	});
	it('closes a socket after 10 auth attempts', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		const done = closed(s);
		for (let i = 0; i < 11; i++) s.send(JSON.stringify({ t: 'auth', password: 'bad' }));
		expect(await done).toBe(1008);
	});
	it('rejects a cross-origin upgrade and allows a matching/absent Origin', async () => {
		const { wsUrl } = await start();
		await expect(open(wsUrl, { Origin: 'http://evil.example' })).rejects.toThrow();
		const host = new URL(wsUrl).host;
		const s = await open(wsUrl, { Origin: `http://${host}` });
		s.close();
	});
});

describe('fan-out', () => {
	it('broadcasts events to authed sockets only and counts clients', async () => {
		const { wsUrl } = await start();
		const counts: number[] = [];
		gw!.onClientCount((n) => counts.push(n));
		const a = await open(wsUrl); const b = await open(wsUrl);
		await login(a);
		expect(gw!.clientCount()).toBe(1);
		const gotA = next(a);
		let gotB = false; b.once('message', () => { gotB = true; });
		gw!.broadcast('tile:data', { id: 1, chunk: 'x' });
		expect(await gotA).toEqual({ t: 'event', channel: 'tile:data', payload: { id: 1, chunk: 'x' } });
		await new Promise((r) => setTimeout(r, 50));
		expect(gotB).toBe(false);
		a.close(); b.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts).toEqual([1, 0]);
	});
	it('ends live sessions for a revoked device with the fixed error and code 4009', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		await login(s); // deviceId 'dev-pw'
		const done = closed(s);
		const msg = next(s);
		expect(gw!.endDeviceSessions(['dev-pw'])).toBe(1);
		expect(await msg).toEqual({ t: 'auth', ok: false, error: 'device revoked' });
		expect(await done).toBe(4009);
	});
	it('drops a slow consumer with 4008', async () => {
		const { wsUrl } = await start({ backpressureLimitBytes: 1 });
		const s = await open(wsUrl);
		await login(s);
		s.pause(); // stop reading so the server's send buffer fills
		const done = closed(s);
		for (let i = 0; i < 200; i++) gw!.broadcast('tile:data', { chunk: 'y'.repeat(100_000) });
		// On Windows a paused client observes nothing (not even the close) until it resumes.
		// Resuming drains the queued frames and then delivers the server's close frame.
		s.resume();
		expect(await done).toBe(4008);
	});
	it('terminates a silent socket on the heartbeat sweep', async () => {
		const { wsUrl } = await start({ heartbeatSweepMs: 20, heartbeatTimeoutMs: 40 });
		const s = await open(wsUrl);
		await login(s);
		const code = await closed(s);
		expect(code).toBe(1006);
	});
});

describe('hosts', () => {
	it('binds every host given and can add one later', async () => {
		const { base } = await start();
		expect(gw!.boundHosts()).toEqual(['127.0.0.1']);
		expect(await gw!.addHost('127.0.0.1')).toBe(false);
		expect(await gw!.addHost('0.0.0.0')).toBe(false); // refused: never all-interfaces
		expect((await fetch(`${base}/`)).status).toBe(200);
	});
	it('binds only loopback/Tailscale hosts — an allowlist, not a denylist', async () => {
		await start();
		expect(await gw!.addHost('')).toBe(false);
		expect(await gw!.addHost('::0')).toBe(false);
		expect(await gw!.addHost('0.0.0.0')).toBe(false);
		expect(await gw!.addHost('192.168.1.5')).toBe(false);
		expect(await gw!.addHost('127.0.0.2')).toBe(true);
		expect(gw!.boundHosts().sort()).toEqual(['127.0.0.1', '127.0.0.2']);
	});
	it('refuses addHost after close', async () => {
		await start();
		await gw!.close();
		expect(await gw!.addHost('127.0.0.1')).toBe(false);
	});
});

describe('Host header guard (DNS rebinding)', () => {
	it('rejects an HTTP request whose Host header does not name a bound host', async () => {
		const { base } = await start();
		expect(await getWithHost(base, '/', 'evil.example')).toBe(421);
	});
	it('rejects a websocket upgrade whose Host header does not name a bound host', async () => {
		const { wsUrl } = await start();
		await expect(open(wsUrl, { Host: 'evil.example' })).rejects.toThrow();
	});
	it('allows a Host accepted by allowHost', async () => {
		const { base } = await start({ allowHost: (h) => h.endsWith('.ts.net') });
		expect(await getWithHost(base, '/', 'box.tail.ts.net')).toBe(200);
	});
});

describe('pre-auth resource bounds', () => {
	it('closes an unauthed socket that sends an oversized frame', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		const done = closed(s);
		s.send(JSON.stringify({ t: 'auth', password: 'x'.repeat(5000) }));
		expect(await done).toBe(1008);
	});
	it('closes an unauthed socket after 120 frames', async () => {
		const { wsUrl } = await start();
		const s = await open(wsUrl);
		const done = closed(s);
		for (let i = 0; i < 121; i++) s.send(JSON.stringify({ t: 'ping' }));
		expect(await done).toBe(1008);
	});
	// MAX_SOCKETS (64) is covered by inspection only: opening 65 real sockets per test run is slow
	// and would slow the whole suite down for a one-line bound check.
});
