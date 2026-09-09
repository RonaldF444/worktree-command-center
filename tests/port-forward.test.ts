import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { createPortForwarder, type PortForwarder } from '../electron/port-forward';

/** The forwarder binds <host>:<port> and pipes to 127.0.0.1:<port>, so the test's upstream sits
 *  on 127.0.0.1 and the forward on a second loopback address (127.0.0.2 — valid on Windows). */
const FWD_HOST = '127.0.0.2';

const echoServer = (): Promise<{ port: number; close: () => Promise<void> }> => new Promise((resolve) => {
	const srv = net.createServer((s) => s.pipe(s));
	srv.listen(0, '127.0.0.1', () => resolve({
		port: (srv.address() as net.AddressInfo).port,
		close: () => new Promise((r) => srv.close(() => r())),
	}));
});
const roundTrip = (host: string, port: number, msg: string): Promise<string> => new Promise((resolve, reject) => {
	const c = net.connect(port, host, () => c.write(msg));
	c.once('data', (d) => { resolve(d.toString()); c.destroy(); });
	c.once('error', reject);
	c.once('close', () => reject(new Error('closed before data')));
});
const refused = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
	const c = net.connect(port, host);
	c.once('connect', () => { c.destroy(); resolve(false); });
	c.once('error', () => resolve(true));
});

let fwd: PortForwarder | null = null;
let closers: Array<() => Promise<void>> = [];
afterEach(async () => { await fwd?.close(); fwd = null; for (const c of closers) await c(); closers = []; });

describe('createPortForwarder', () => {
	it('pipes a connection on <host>:<port> to 127.0.0.1:<port>, both ways', async () => {
		const up = await echoServer(); closers.push(up.close);
		fwd = createPortForwarder();
		await fwd.sync([up.port], [FWD_HOST]);
		expect(fwd.active()).toEqual([{ host: FWD_HOST, port: up.port }]);
		expect(await roundTrip(FWD_HOST, up.port, 'ping')).toBe('ping');
	});
	it('is idempotent and closes forwards that drop out of the set', async () => {
		const up = await echoServer(); closers.push(up.close);
		fwd = createPortForwarder();
		await fwd.sync([up.port], [FWD_HOST]);
		await fwd.sync([up.port], [FWD_HOST]);
		expect(fwd.active()).toHaveLength(1);
		await fwd.sync([], [FWD_HOST]);
		expect(fwd.active()).toEqual([]);
		expect(await refused(FWD_HOST, up.port)).toBe(true);
	});
	it('skips a host:port that is already bound (the server itself listens there) without throwing', async () => {
		const up = await echoServer(); closers.push(up.close);
		fwd = createPortForwarder();
		await fwd.sync([up.port], ['127.0.0.1']);
		expect(fwd.active()).toEqual([]);
	});
	it('drops the client when nothing answers upstream, and keeps serving', async () => {
		const up = await echoServer(); const dead = up.port; await up.close(); // a port nobody listens on now
		fwd = createPortForwarder();
		await fwd.sync([dead], [FWD_HOST]);
		await expect(roundTrip(FWD_HOST, dead, 'x')).rejects.toThrow();
		expect(fwd.active()).toEqual([{ host: FWD_HOST, port: dead }]);
	});
	it('close() releases everything', async () => {
		const up = await echoServer(); closers.push(up.close);
		fwd = createPortForwarder();
		await fwd.sync([up.port], [FWD_HOST]);
		await fwd.close();
		expect(await refused(FWD_HOST, up.port)).toBe(true);
		fwd = null;
	});
});
