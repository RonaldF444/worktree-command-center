import type { NetworkInterfaceInfo } from 'os';

/** Is an IPv4 in Tailscale's 100.64.0.0/10 CGNAT range? */
export function isTailscaleIp(ip: string): boolean {
	const m = /^(\d+)\.(\d+)\./.exec(ip);
	if (!m) return false;
	const a = +m[1]!, b = +m[2]!;
	return a === 100 && b >= 64 && b <= 127;
}

/** Ordered host candidates for the phone URL: Tailscale IP(s) first, then the hostname, then
 *  LAN IPv4s. Loopback/internal addresses are skipped. */
export function pickHosts(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>, hostname: string): string[] {
	const ts: string[] = [], lan: string[] = [];
	for (const list of Object.values(ifaces)) {
		for (const i of list ?? []) {
			if (i.family !== 'IPv4' || i.internal) continue;
			(isTailscaleIp(i.address) ? ts : lan).push(i.address);
		}
	}
	return [...ts, hostname, ...lan];
}

/** Phone page URLs (the page moved to /phone when the browser app took `/`). */
export function accessUrls(hosts: string[], port: number, token: string): string[] {
	return hosts.map((h) => `http://${h}:${port}/phone?t=${token}`);
}

/** HTTPS phone URL when `tailscale serve` fronts us, else null. MagicDNS names carry a trailing dot. */
export function httpsUrlFor(dnsName: string | null | undefined, token: string): string | null {
	const host = (dnsName ?? '').trim().replace(/\.$/, '');
	return host ? `https://${host}/phone?t=${token}` : null;
}

/** Every Tailscale IPv4 on this machine (the gateway binds to exactly these plus loopback). */
export function tailscaleIps(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>): string[] {
	const out: string[] = [];
	for (const list of Object.values(ifaces)) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isTailscaleIp(i.address)) out.push(i.address);
	return out;
}

/** Browser-app URLs (no token: the app has its own login). */
export function browserUrls(hosts: string[], port: number): string[] {
	return hosts.map((h) => `http://${h}:${port}/`);
}

/** Does `tailscale serve status --json` show an active handler proxying to `port` on this
 *  machine? MagicDNS resolves the moment a device joins a tailnet, independent of whether
 *  `tailscale serve` was ever run — so a DNS name alone is not proof anything is listening
 *  on 443. Without this check the panel could hand out an HTTPS URL that refuses to connect. */
export function hasServeHandlerFor(serveStatus: unknown, port: number): boolean {
	const web = (serveStatus as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null | undefined)?.Web;
	if (!web) return false;
	const suffix = `:${port}`;
	for (const site of Object.values(web)) {
		for (const handler of Object.values(site?.Handlers ?? {})) {
			if (typeof handler?.Proxy === 'string' && handler.Proxy.endsWith(suffix)) return true;
		}
	}
	return false;
}
