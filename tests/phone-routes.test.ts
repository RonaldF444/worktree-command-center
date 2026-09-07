import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'http';
import { createPhoneRoutes, MOBILE_HTML } from '../electron/remote-server';

async function withServer(handler: ReturnType<typeof createPhoneRoutes>, fn: (base: string) => Promise<void>): Promise<void> {
	const srv: Server = createServer((req, res) => {
		const pathname = new URL(req.url ?? '/', 'http://x').pathname;
		if (!handler(req, res, pathname)) { res.writeHead(404); res.end('nope'); }
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as { port: number }).port;
	try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(); }
}

describe('createPhoneRoutes', () => {
	it('serves the page at /phone without a token, and only that', async () => {
		const h = createPhoneRoutes({ token: 'tok', getFloor: () => ({}), onAction: () => {} });
		await withServer(h, async (base) => {
			const r = await fetch(`${base}/phone`);
			expect(r.status).toBe(200);
			expect(await r.text()).toBe(MOBILE_HTML);
			expect((await fetch(`${base}/`)).status).toBe(404);
		});
	});
	it('gates /api/* on the token', async () => {
		const h = createPhoneRoutes({ token: 'tok', getFloor: () => ({ terminals: [1] }), onAction: () => {} });
		await withServer(h, async (base) => {
			expect((await fetch(`${base}/api/floor`)).status).toBe(401);
			expect((await fetch(`${base}/api/floor?t=wrong`)).status).toBe(401);
			const ok = await fetch(`${base}/api/floor?t=tok`);
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({ terminals: [1] });
			expect((await fetch(`${base}/api/other?t=tok`)).status).toBe(404);
		});
	});
	it('forwards a valid action and rejects a bad one', async () => {
		const seen: unknown[] = [];
		const h = createPhoneRoutes({ token: 'tok', getFloor: () => ({}), onAction: (a) => seen.push(a) });
		await withServer(h, async (base) => {
			const good = await fetch(`${base}/api/action?t=tok`, { method: 'POST', body: JSON.stringify({ type: 'center', id: 2 }) });
			expect(good.status).toBe(200);
			expect(seen).toEqual([{ type: 'center', id: 2 }]);
			const bad = await fetch(`${base}/api/action?t=tok`, { method: 'POST', body: '{"type":"center","id":-1}' });
			expect(bad.status).toBe(400);
			const notJson = await fetch(`${base}/api/action?t=tok`, { method: 'POST', body: '{nope' });
			expect(notJson.status).toBe(400);
		});
	});
});
