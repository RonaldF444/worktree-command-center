/** Pull the dev-server URLs a session prints out of raw pty output. Pure scan + a small
 *  stateful wrapper, because a pty write can split a URL in half. */

export interface PortHit { url: string; host: string; port: number; path: string; }
export interface ScanMatch extends PortHit { index: number; length: number; }

/** Loopback + private LAN only. A public URL in agent output is a citation, not a server. */
const HOST = String.raw`localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}`;
/** The lookbehind stops `notlocalhost:3000` matching on its tail. A port is required — an
 *  unported `http://localhost/` is too ambiguous to be worth a row. */
const URL_RE = new RegExp(String.raw`(?<![\w.-])(?:(https?):\/\/)?(${HOST}):(\d{2,5})(\/[^\s"'\`<>)\]]*)?`, 'gi');

/** OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC \). Claude emits these, and the visible
 *  label is often not the URL — so keep the TARGET as plain text for the scan below. */
const OSC8_RE = /\x1b]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC_RE = /\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;

const LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '[::1]']);

/** Strip terminal escapes, but unwrap OSC 8 targets into the text rather than deleting them.
 *  One cleaned stream keeps the offset bookkeeping in PortScanner honest. */
export function stripAnsi(s: string): string {
	return s.replace(OSC8_RE, ' $1 ').replace(OSC_RE, '').replace(CSI_RE, '');
}

function normalizeHost(h: string): string {
	const l = h.toLowerCase();
	// 0.0.0.0 means "all interfaces" — a browser cannot navigate to it, so open it as localhost.
	return LOOPBACK.has(l) ? 'localhost' : l;
}

/** `see http://localhost:3000.` must not yield a URL ending in a period. */
function trimTrailing(p: string): string { return p.replace(/[.,;:!?'")\]}]+$/, ''); }

export function scanText(text: string): ScanMatch[] {
	const out: ScanMatch[] = [];
	URL_RE.lastIndex = 0;
	for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
		const port = Number(m[3]);
		if (!port || port > 65535) continue;
		const rawPath = m[4] ?? '';
		const path = trimTrailing(rawPath);
		const scheme = (m[1] ?? 'http').toLowerCase();
		const host = normalizeHost(m[2]);
		out.push({
			url: `${scheme}://${host}:${port}${path}`,
			host, port, path,
			index: m.index,
			length: m[0].length,
		});
	}
	return out;
}

export const CARRY_CHARS = 256;

/** Feeds cleaned output through `scanText`, carrying a tail across calls so a URL split by a
 *  pty write is still found, and tracking absolute offsets so the overlap is not re-reported. */
export class PortScanner {
	private carry = '';
	private absBase = 0;     // absolute offset of carry[0] in the cleaned stream
	private emittedUpTo = 0; // absolute end of the last hit reported

	feed(chunk: string): PortHit[] {
		const text = this.carry + stripAnsi(chunk);
		const textEnd = this.absBase + text.length;
		const hits: PortHit[] = [];
		for (const m of scanText(text)) {
			const absStart = this.absBase + m.index;
			const absEnd = absStart + m.length;
			// Touching the boundary means it may be truncated (`:300` that is really `:3000`).
			// Leave it for the next feed, where the carry will present it whole.
			if (absEnd >= textEnd) continue;
			if (absStart < this.emittedUpTo) continue; // already reported on an earlier feed
			this.emittedUpTo = absEnd;
			hits.push({ url: m.url, host: m.host, port: m.port, path: m.path });
		}
		const keep = text.slice(-CARRY_CHARS);
		this.absBase += text.length - keep.length;
		this.carry = keep;
		return hits;
	}
}
