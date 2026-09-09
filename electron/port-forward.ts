/** Tailscale-only tunnels to the dev servers the terminals print. A dev server on the desktop
 *  answers only on localhost; the browser mirror on another device cannot reach it. For every
 *  port in the floor state we listen on the SAME port on each Tailscale IP (never LAN, never
 *  0.0.0.0) and pipe bytes to 127.0.0.1:<port>. Plain TCP — no HTTP rewriting, so HMR
 *  websockets and absolute paths just work. A host:port that is already bound (the server
 *  itself listens on all interfaces, or something else owns it) is skipped, not fought over. */
import net from 'net';

export interface PortForwarder {
	/** Make the live set exactly hosts x ports: open what is missing, close what dropped out. */
	sync(ports: number[], hosts: string[]): Promise<void>;
	active(): Array<{ host: string; port: number }>;
	close(): Promise<void>;
}

export interface PortForwarderOpts { upstreamHost?: string; log?: (msg: string) => void }

export function createPortForwarder(opts: PortForwarderOpts = {}): PortForwarder {
	const upstream = opts.upstreamHost ?? '127.0.0.1';
	const servers = new Map<string, { srv: net.Server; host: string; port: number; clients: Set<net.Socket> }>();
	const key = (host: string, port: number): string => `${host}:${port}`;

	const listen = (host: string, port: number): Promise<void> => new Promise((resolve) => {
		const clients = new Set<net.Socket>();
		const srv = net.createServer((client) => {
			clients.add(client);
			const up = net.connect(port, upstream);
			const drop = (): void => { client.destroy(); up.destroy(); };
			client.on('error', drop);
			up.on('error', drop);
			up.once('connect', () => { client.pipe(up); up.pipe(client); });
			client.on('close', () => { clients.delete(client); up.destroy(); });
			up.on('close', () => client.destroy());
		});
		srv.once('error', () => resolve()); // EADDRINUSE and friends: not ours to serve
		srv.listen(port, host, () => {
			srv.removeAllListeners('error');
			srv.on('error', (e) => opts.log?.(`[ports] ${host}:${port}: ${e.message}`));
			servers.set(key(host, port), { srv, host, port, clients });
			resolve();
		});
	});
	const closeOne = (k: string): Promise<void> => new Promise((resolve) => {
		const e = servers.get(k);
		if (!e) { resolve(); return; }
		servers.delete(k);
		for (const c of e.clients) c.destroy();
		e.srv.close(() => resolve());
	});

	// Syncs are serialised so a burst of floor states cannot open and close the same port at once.
	let chain: Promise<void> = Promise.resolve();
	const run = (job: () => Promise<void>): Promise<void> => { chain = chain.then(job, job); return chain; };

	return {
		sync(ports, hosts) {
			return run(async () => {
				const want = new Set<string>();
				for (const h of hosts) for (const p of ports) want.add(key(h, p));
				for (const k of [...servers.keys()]) if (!want.has(k)) await closeOne(k);
				for (const h of hosts) for (const p of ports) if (!servers.has(key(h, p))) await listen(h, p);
			});
		},
		active() { return [...servers.values()].map(({ host, port }) => ({ host, port })); },
		close() { return run(async () => { for (const k of [...servers.keys()]) await closeOne(k); }); },
	};
}
