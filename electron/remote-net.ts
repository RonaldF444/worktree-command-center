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

export function accessUrls(hosts: string[], port: number, token: string): string[] {
	return hosts.map((h) => `http://${h}:${port}/?t=${token}`);
}

/** The HTTPS URL for the phone page when `tailscale serve` is fronting us, else null.
 *  Voice needs a secure context: Safari will not hand a microphone to an http:// page, so
 *  the plain-HTTP URLs above are read-only in practice. MagicDNS names arrive fully
 *  qualified with a trailing dot, which is legal in DNS but ugly in a URL. */
export function httpsUrlFor(dnsName: string | null | undefined, token: string): string | null {
	const host = (dnsName ?? '').trim().replace(/\.$/, '');
	return host ? `https://${host}/?t=${token}` : null;
}
