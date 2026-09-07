// Wire protocol between a browser client and the main-process gateway. ZERO imports on
// purpose: src/web/* imports these types and constants into the browser bundle.

export type ClientFrame =
	| { t: 'invoke'; id: string; channel: string; payload?: unknown }
	| { t: 'auth'; password?: string; deviceToken?: string; deviceLabel?: string }
	| { t: 'ping' };

export type ServerFrame =
	| { t: 'reply'; id: string; ok: true; value: unknown }
	| { t: 'reply'; id: string; ok: false; error: string }
	| { t: 'event'; channel: string; payload: unknown }
	| { t: 'auth'; ok: boolean; deviceToken?: string; deviceId?: string; error?: string }
	| { t: 'pong' };

/** Largest WebSocket frame either side accepts (a full 2,000,000-char snapshot, JSON-escaped, fits). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Sent (then close 4009) to a live socket whose device was revoked. */
export const DEVICE_REVOKED_ERROR = 'device revoked';
export const DEVICE_REVOKED_CLOSE_CODE = 4009;
/** Close code for a socket with > 4 MB queued: it reconnects and repaints from a snapshot. */
export const SLOW_CONSUMER_CLOSE_CODE = 4008;
export const WS_PATH = '/ws';

/** One WebSocket text message → ClientFrame, or null for anything malformed. Never throws. */
export function parseClientFrame(raw: string): ClientFrame | null {
	let obj: unknown;
	try { obj = JSON.parse(raw); } catch { return null; }
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
	const o = obj as Record<string, unknown>;
	switch (o.t) {
		case 'invoke': {
			if (typeof o.id !== 'string' || typeof o.channel !== 'string') return null;
			const f: Extract<ClientFrame, { t: 'invoke' }> = { t: 'invoke', id: o.id, channel: o.channel };
			if ('payload' in o) f.payload = o.payload;
			return f;
		}
		case 'auth': {
			const f: Extract<ClientFrame, { t: 'auth' }> = { t: 'auth' };
			if (typeof o.password === 'string') f.password = o.password;
			if (typeof o.deviceToken === 'string') f.deviceToken = o.deviceToken;
			if (typeof o.deviceLabel === 'string') f.deviceLabel = o.deviceLabel;
			return f;
		}
		case 'ping':
			return { t: 'ping' };
		default:
			return null;
	}
}
