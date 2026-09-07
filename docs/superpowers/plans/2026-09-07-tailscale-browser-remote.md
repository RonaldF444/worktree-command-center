# Browser Remote over Tailscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive Worktree Command Center from a browser on any tailnet machine: the same tiles, Kane, spawn and workspace controls, with a password login, while the desktop app stays the owner of every terminal.

**Architecture:** Main gets an HTTP+WebSocket gateway (port 7420, loopback + Tailscale IP only) that serves a browser bundle and a JSON invoke/reply/event protocol behind scrypt-password + device-token auth. The desktop renderer keeps owning the PTY sidecars; it taps each tile's output into a replay buffer, forwards chunks to main over IPC, and answers a generic main→renderer RPC for every action the browser takes. The browser runs a small new entry (`src/web/`) that reuses the pure layout/theme modules and CSS, renders from a desktop-published `FloorState`, and attaches xterm instances via snapshot-then-subscribe.

**Tech Stack:** Electron 33, TypeScript 5, esbuild, `ws` 8, Node `crypto.scrypt`, `@xterm/xterm` 6 (+ fit, webgl, web-links), vitest 4 (node environment, no DOM).

**Spec:** `docs/superpowers/specs/2026-09-07-tailscale-browser-remote-design.md`

## Global Constraints

- Repo root: `C:\Users\User\dev\worktree-command-center`, branch `feat/browser-remote`. All paths below are relative to it.
- Tabs for indentation in `.ts` files (matches the repo). Two-space indentation in `tests/*.test.ts` is also present in the repo; either is fine.
- Tests run with `npm test` (`vitest run`), node environment, **no DOM**. Never import a module that touches `document`/`window` at module scope from a test. Never import `wcc-private` from a test.
- `electron/remote/protocol.ts` must have **zero imports** so `src/web/*` can import it.
- Nothing under `src/web/` may import (directly or transitively) `fs`, `path`, `os`, `child_process`, `electron`, or any module that does. The web esbuild bundle uses `platform: 'browser'` and will fail on such imports.
- Port stays `7420`. Bind to `127.0.0.1` plus every Tailscale IPv4 (`100.64.0.0/10`). Never `0.0.0.0`.
- Password min length `12`. scrypt `N=2**17, r=8, p=1, keylen=64, maxmem=256 MiB`. Stored format `scrypt$N$r$p$saltHex$hashHex`.
- Device token TTL: `30 days` sliding on `lastSeen`. Per-IP lockout: `5` failures → `15 min`. Account-wide: `20` failures in `15 min` → `15 min`.
- Wire error strings are fixed literals: `'unauthenticated'`, `'unknown channel'`, `'request failed'`, `'invalid payload'`, `'device revoked'`, `'too many attempts -- try again later'`, `'no password set'`. Never `String(err)` on the wire.
- Frame cap `16 MiB`. Backpressure close code `4008` at `4 MB` buffered. Revoked close code `4009`. Unauthenticated frame budget `120`. Auth attempts: `10` per socket, `12` per IP per `15 min`. Heartbeat sweep `15 s`, silent-socket timeout `60 s`.
- Replay buffer cap `2,000,000` chars per tile. Tap batch window `16 ms`. Floor-state debounce `100 ms`. Renderer RPC timeout `10 s`.
- Device management (list/revoke) is **desktop-only** (not in the browser handler table). This is a deliberate narrowing of the spec's Part 2 local-handler list, matching The Spire: a stolen device must not be able to revoke the others.
- Commit after every task with a conventional message. Do not run `npm run install-local` (see `CLAUDE.md`).

## File map

| File | Responsibility |
| --- | --- |
| `electron/remote/protocol.ts` (new) | Frame types, `parseClientFrame`, wire constants. Zero imports. |
| `electron/remote/auth.ts` (new) | scrypt hashing, `remote-auth.json` store, device tokens, lockouts, revoke. |
| `electron/remote/gateway.ts` (new) | HTTP static + `/phone` passthrough + WS upgrade, auth gate, dispatch, fan-out, backpressure, sweep. |
| `electron/remote/renderer-rpc.ts` (new) | Main→renderer invoke/reply correlation with timeout. |
| `electron/remote/handlers.ts` (new) | The browser handler table: local handlers + validated forwards to the renderer. |
| `electron/remote-actions.ts` (modify) | Adds `parseTileInvoke` validators for the forwarded channels. |
| `electron/remote-server.ts` (modify) | Becomes a pure phone-route handler factory; no server of its own. |
| `electron/remote-net.ts` (modify) | `accessUrls`/`httpsUrlFor` point at `/phone`; adds `tailscaleIps`, `browserUrls`. |
| `electron/preload.ts` (modify) | Adds RPC + password/device IPC functions. |
| `electron/main.ts` (modify) | Starts the gateway, wires RPC/events, password + device handlers. |
| `src/terminals/replay-buffer.ts` (new) | Ring buffer of output chunks. |
| `src/terminals/remote-tap.ts` (new) | Per-key replay buffers + 16 ms batched `tile:data` emission. |
| `src/terminals/spawn-options.ts` (new) | `SPAWN_MODELS`/`SPAWN_EFFORTS` moved out of `terminals-grid.ts` (pure). |
| `src/terminals/floor-state.ts` (new) | `FloorState` types + `buildFloorState` (pure). |
| `src/terminals/terminal-tile.ts` (modify) | `onOutput`/`onRestart` hooks, `dims`. |
| `src/terminals/god-console.ts` (modify) | Same hooks, `dims`, `write(raw)`. |
| `src/terminals/terminals-grid.ts` (modify) | Full floor state, `onFloorChange`, public by-id actions, Kane access. |
| `src/app.ts` (modify) | Tap wiring, RPC dispatch, floor-state publishing, 📱 panel password/devices. |
| `src/web/bridge.ts` (new) | Browser WebSocket client: invoke/on/auth/reconnect. |
| `src/web/login.ts` (new) | Password form, remember-device, error copy. |
| `src/web/tile.ts` (new) | One browser xterm tile: snapshot-then-subscribe, input forwarding. |
| `src/web/floor.ts` (new) | Stage layout, toolbar, workspace bar, Kane dock, board panel, keyboard. |
| `src/web/main.ts` (new) | Boot: dom shim → bridge → login → floor. |
| `web/index.html` (new) | Browser page shell. |
| `esbuild.config.mjs` (modify) | Fourth bundle + copies into `dist/web/`. |
| `package.json` (modify) | `ws`, `@types/ws`; `dist/web/**` and `web/**` in `build.files`. |

---

### Task 1: Wire protocol

**Files:**
- Create: `electron/remote/protocol.ts`
- Test: `tests/remote-protocol.test.ts`

**Interfaces:**
- Produces: `ClientFrame`, `ServerFrame`, `parseClientFrame(raw: string): ClientFrame | null`, `MAX_FRAME_BYTES`, `DEVICE_REVOKED_ERROR`, `SLOW_CONSUMER_CLOSE_CODE`, `DEVICE_REVOKED_CLOSE_CODE`, `WS_PATH`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/remote-protocol.test.ts
import { describe, it, expect } from 'vitest';
import { parseClientFrame, MAX_FRAME_BYTES, DEVICE_REVOKED_ERROR, SLOW_CONSUMER_CLOSE_CODE, DEVICE_REVOKED_CLOSE_CODE, WS_PATH } from '../electron/remote/protocol';

describe('parseClientFrame', () => {
	it('parses an invoke with and without payload', () => {
		expect(parseClientFrame('{"t":"invoke","id":"1","channel":"floor:state"}')).toEqual({ t: 'invoke', id: '1', channel: 'floor:state' });
		expect(parseClientFrame('{"t":"invoke","id":"2","channel":"tile:write","payload":{"id":1,"data":"x"}}'))
			.toEqual({ t: 'invoke', id: '2', channel: 'tile:write', payload: { id: 1, data: 'x' } });
	});
	it('rejects an invoke missing id or channel', () => {
		expect(parseClientFrame('{"t":"invoke","channel":"x"}')).toBeNull();
		expect(parseClientFrame('{"t":"invoke","id":"1"}')).toBeNull();
		expect(parseClientFrame('{"t":"invoke","id":1,"channel":"x"}')).toBeNull();
	});
	it('parses auth with only the string fields present', () => {
		expect(parseClientFrame('{"t":"auth","password":"p","deviceLabel":"L","junk":1}')).toEqual({ t: 'auth', password: 'p', deviceLabel: 'L' });
		expect(parseClientFrame('{"t":"auth","deviceToken":"tok"}')).toEqual({ t: 'auth', deviceToken: 'tok' });
		expect(parseClientFrame('{"t":"auth","password":5}')).toEqual({ t: 'auth' });
	});
	it('parses ping', () => {
		expect(parseClientFrame('{"t":"ping"}')).toEqual({ t: 'ping' });
	});
	it('returns null for garbage, arrays, primitives, unknown t', () => {
		expect(parseClientFrame('not json')).toBeNull();
		expect(parseClientFrame('[]')).toBeNull();
		expect(parseClientFrame('"str"')).toBeNull();
		expect(parseClientFrame('null')).toBeNull();
		expect(parseClientFrame('{"t":"nope"}')).toBeNull();
		expect(parseClientFrame('{}')).toBeNull();
	});
});

describe('constants', () => {
	it('pins the wire constants', () => {
		expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
		expect(DEVICE_REVOKED_ERROR).toBe('device revoked');
		expect(SLOW_CONSUMER_CLOSE_CODE).toBe(4008);
		expect(DEVICE_REVOKED_CLOSE_CODE).toBe(4009);
		expect(WS_PATH).toBe('/ws');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/remote-protocol.test.ts`
Expected: FAIL — cannot resolve `../electron/remote/protocol`.

- [ ] **Step 3: Write the implementation**

```ts
// electron/remote/protocol.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/remote-protocol.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/protocol.ts tests/remote-protocol.test.ts
git commit -m "feat(remote): browser wire protocol (frames, parser, constants)"
```

---

### Task 2: Replay buffer

**Files:**
- Create: `src/terminals/replay-buffer.ts`
- Test: `tests/replay-buffer.test.ts`

**Interfaces:**
- Produces: `class ReplayBuffer { constructor(maxChars = 2_000_000); push(chunk: string): void; snapshot(): string; clear(): void; get length(): number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/replay-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { ReplayBuffer } from '../src/terminals/replay-buffer';

describe('ReplayBuffer', () => {
	it('joins pushed chunks in order', () => {
		const b = new ReplayBuffer(100);
		b.push('ab'); b.push('cd');
		expect(b.snapshot()).toBe('abcd');
		expect(b.length).toBe(4);
	});
	it('drops the oldest chunks past the cap', () => {
		const b = new ReplayBuffer(5);
		b.push('aaa'); b.push('bb'); b.push('c');
		expect(b.snapshot()).toBe('bbc');
	});
	it('slices a single oversized chunk to the tail', () => {
		const b = new ReplayBuffer(4);
		b.push('abcdefgh');
		expect(b.snapshot()).toBe('efgh');
		expect(b.length).toBe(4);
	});
	it('clear empties it', () => {
		const b = new ReplayBuffer(10);
		b.push('x'); b.clear();
		expect(b.snapshot()).toBe('');
		expect(b.length).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/replay-buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/terminals/replay-buffer.ts
/** Ring of raw PTY output chunks, capped by total characters. A browser that attaches late
 *  gets `snapshot()` first, then the live stream — so this is the only scrollback a remote
 *  viewer ever sees. Pure; no DOM, no Node. */
export class ReplayBuffer {
	private chunks: string[] = [];
	private total = 0;
	constructor(private maxChars = 2_000_000) {}

	push(chunk: string): void {
		if (!chunk) return;
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total > this.maxChars && this.chunks.length > 1) {
			this.total -= this.chunks[0]!.length;
			this.chunks.shift();
		}
		if (this.total > this.maxChars) { // a single giant chunk: keep only its tail
			const c = this.chunks[0]!;
			this.chunks[0] = c.slice(c.length - this.maxChars);
			this.total = this.maxChars;
		}
	}

	snapshot(): string { return this.chunks.join(''); }
	clear(): void { this.chunks = []; this.total = 0; }
	get length(): number { return this.total; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/replay-buffer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/terminals/replay-buffer.ts tests/replay-buffer.test.ts
git commit -m "feat(remote): replay buffer for remote scrollback"
```

---

### Task 3: Auth store, scrypt, device tokens, lockouts

**Files:**
- Create: `electron/remote/auth.ts`
- Test: `tests/remote-auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeviceRecord { id: string; label: string; tokenHash: string; createdAt: number; lastSeen: number }
  export interface AuthStore { passwordHash: string | null; devices: DeviceRecord[] }
  export type AuthResult = { ok: true; deviceToken?: string; deviceId: string } | { ok: false; error: string };
  export interface AuthFrame { password?: string; deviceToken?: string; deviceLabel?: string }
  export interface RemoteAuth {
    authenticate(frame: AuthFrame, ip: string): Promise<AuthResult>;
    hasPassword(): boolean;
    setPassword(plain: string): Promise<{ devicesSignedOut: number }>;
    listDevices(): Array<{ id: string; label: string; createdAt: number; lastSeen: number }>;
    revokeDevice(id: string): boolean;
  }
  export function loadAuthStore(file: string): AuthStore
  export function saveAuthStore(file: string, store: AuthStore): void
  export function hashPassword(plain: string): Promise<string>
  export function verifyPassword(stored: string, plain: string): Promise<boolean>
  export function createAuth(deps: { file: string; now?: () => number; onDevicesRevoked?: (ids: string[]) => void }): RemoteAuth
  export const MIN_PASSWORD_LENGTH = 12
  export const TOO_MANY_ATTEMPTS_ERROR = 'too many attempts -- try again later'
  export const NO_PASSWORD_ERROR = 'no password set'
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/remote-auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuth, hashPassword, verifyPassword, loadAuthStore, saveAuthStore, MIN_PASSWORD_LENGTH, TOO_MANY_ATTEMPTS_ERROR, NO_PASSWORD_ERROR } from '../electron/remote/auth';

const PW = 'correct horse battery';
let dir: string; let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-auth-')); file = path.join(dir, 'remote-auth.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('hashPassword / verifyPassword', () => {
	it('round-trips and embeds the cost params', async () => {
		const h = await hashPassword(PW);
		expect(h.startsWith('scrypt$131072$8$1$')).toBe(true);
		expect(h.split('$')).toHaveLength(6);
		expect(await verifyPassword(h, PW)).toBe(true);
		expect(await verifyPassword(h, 'wrong password here')).toBe(false);
	}, 20_000);
	it('fails closed on a corrupt stored hash', async () => {
		expect(await verifyPassword('garbage', PW)).toBe(false);
		expect(await verifyPassword('scrypt$abc$8$1$00$00', PW)).toBe(false);
		expect(await verifyPassword('scrypt$1099511627776$8$1$00$00', PW)).toBe(false);
	});
});

describe('store', () => {
	it('loads an empty store when the file is missing or corrupt', () => {
		expect(loadAuthStore(file)).toEqual({ passwordHash: null, devices: [] });
		fs.writeFileSync(file, '{not json', 'utf8');
		expect(loadAuthStore(file)).toEqual({ passwordHash: null, devices: [] });
	});
	it('saves atomically and reloads', () => {
		saveAuthStore(file, { passwordHash: 'h', devices: [{ id: 'd', label: 'L', tokenHash: 't', createdAt: 1, lastSeen: 2 }] });
		expect(fs.existsSync(file + '.tmp')).toBe(false);
		expect(loadAuthStore(file)).toEqual({ passwordHash: 'h', devices: [{ id: 'd', label: 'L', tokenHash: 't', createdAt: 1, lastSeen: 2 }] });
	});
});

describe('createAuth', () => {
	it('refuses everything until a password is set', async () => {
		const a = createAuth({ file });
		expect(a.hasPassword()).toBe(false);
		expect(await a.authenticate({ password: PW }, '1.1.1.1')).toEqual({ ok: false, error: NO_PASSWORD_ERROR });
	});
	it('enforces the minimum password length', async () => {
		const a = createAuth({ file });
		await expect(a.setPassword('short')).rejects.toThrow(String(MIN_PASSWORD_LENGTH));
	});
	it('password → device token → token reconnect', async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		const r = await a.authenticate({ password: PW, deviceLabel: 'Laptop' }, '1.1.1.1');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.deviceToken).toMatch(/^[0-9a-f]{64}$/);
		expect(a.listDevices()).toEqual([expect.objectContaining({ id: r.deviceId, label: 'Laptop' })]);
		const again = await a.authenticate({ deviceToken: r.deviceToken }, '2.2.2.2');
		expect(again).toEqual({ ok: true, deviceId: r.deviceId });
		expect(await a.authenticate({ deviceToken: 'f'.repeat(64) }, '2.2.2.2')).toEqual({ ok: false, error: 'unknown device token' });
	}, 20_000);
	it('expires a device token after 30 days of no use (sliding) and prunes it', async () => {
		let t = 1_000_000;
		const a = createAuth({ file, now: () => t });
		await a.setPassword(PW);
		const r = await a.authenticate({ password: PW }, '1.1.1.1');
		if (!r.ok) throw new Error('expected ok');
		t += 29 * 24 * 3600 * 1000;
		expect((await a.authenticate({ deviceToken: r.deviceToken }, '1.1.1.1')).ok).toBe(true); // slides lastSeen
		t += 29 * 24 * 3600 * 1000;
		expect((await a.authenticate({ deviceToken: r.deviceToken }, '1.1.1.1')).ok).toBe(true);
		t += 31 * 24 * 3600 * 1000;
		expect(await a.authenticate({ deviceToken: r.deviceToken }, '1.1.1.1')).toEqual({ ok: false, error: 'device token expired' });
		expect(a.listDevices()).toEqual([]);
	}, 20_000);
	it('locks an IP after 5 wrong passwords for 15 minutes', async () => {
		let t = 0;
		const a = createAuth({ file, now: () => t });
		await a.setPassword(PW);
		for (let i = 0; i < 5; i++) expect((await a.authenticate({ password: 'wrong wrong wrong' }, '9.9.9.9')).ok).toBe(false);
		expect(await a.authenticate({ password: PW }, '9.9.9.9')).toEqual({ ok: false, error: TOO_MANY_ATTEMPTS_ERROR });
		expect((await a.authenticate({ password: PW }, '8.8.8.8')).ok).toBe(true); // other IPs unaffected
		t += 15 * 60 * 1000 + 1;
		expect((await a.authenticate({ password: PW }, '9.9.9.9')).ok).toBe(true);
	}, 60_000);
	it('engages the account-wide cool-off after 20 failures from many IPs, but tokens still work', async () => {
		let t = 0;
		const a = createAuth({ file, now: () => t });
		await a.setPassword(PW);
		const tok = await a.authenticate({ password: PW }, '5.5.5.5');
		if (!tok.ok) throw new Error('expected ok');
		for (let i = 0; i < 20; i++) await a.authenticate({ password: 'wrong wrong wrong' }, `10.0.0.${i}`);
		expect(await a.authenticate({ password: PW }, '6.6.6.6')).toEqual({ ok: false, error: TOO_MANY_ATTEMPTS_ERROR });
		expect((await a.authenticate({ deviceToken: tok.deviceToken }, '6.6.6.6')).ok).toBe(true);
	}, 120_000);
	it('revokeDevice removes it and reports it; setPassword signs every device out', async () => {
		const revoked: string[][] = [];
		const a = createAuth({ file, onDevicesRevoked: (ids) => revoked.push(ids) });
		await a.setPassword(PW);
		const r1 = await a.authenticate({ password: PW }, '1.1.1.1');
		const r2 = await a.authenticate({ password: PW }, '1.1.1.2');
		if (!r1.ok || !r2.ok) throw new Error('expected ok');
		expect(a.revokeDevice(r1.deviceId)).toBe(true);
		expect(a.revokeDevice('nope')).toBe(false);
		expect(revoked).toEqual([[r1.deviceId]]);
		expect(await a.authenticate({ deviceToken: r1.deviceToken }, '1.1.1.1')).toEqual({ ok: false, error: 'unknown device token' });
		expect(await a.setPassword(PW + ' new')).toEqual({ devicesSignedOut: 1 });
		expect(revoked).toEqual([[r1.deviceId], [r2.deviceId]]);
		expect(loadAuthStore(file).devices).toEqual([]);
	}, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/remote-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// electron/remote/auth.ts
import { randomBytes, randomUUID, createHash, timingSafeEqual, scrypt as scryptCb, type ScryptOptions } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DeviceRecord { id: string; label: string; tokenHash: string; createdAt: number; lastSeen: number; }
export interface AuthStore { passwordHash: string | null; devices: DeviceRecord[]; }
export type AuthResult = { ok: true; deviceToken?: string; deviceId: string } | { ok: false; error: string };
export interface AuthFrame { password?: string; deviceToken?: string; deviceLabel?: string; }
export interface RemoteAuth {
	authenticate(frame: AuthFrame, ip: string): Promise<AuthResult>;
	hasPassword(): boolean;
	setPassword(plain: string): Promise<{ devicesSignedOut: number }>;
	listDevices(): Array<{ id: string; label: string; createdAt: number; lastSeen: number }>;
	revokeDevice(id: string): boolean;
}

export const MIN_PASSWORD_LENGTH = 12;
export const TOO_MANY_ATTEMPTS_ERROR = 'too many attempts -- try again later';
export const NO_PASSWORD_ERROR = 'no password set';

const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const GLOBAL_LOCKOUT_THRESHOLD = 20;
const GLOBAL_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const MAX_DEVICE_LABEL_LENGTH = 60;

const SCRYPT_N = 2 ** 17, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_N = 2 ** 20, MAX_R = 32, MAX_P = 16;

// Bounded KDF concurrency: every scrypt run occupies a libuv threadpool slot (default 4 for the
// whole main process) for ~100ms+. Two at a time keeps half the pool free for real work.
const MAX_CONCURRENT_KDF = 2, MAX_QUEUED_KDF = 32;
let kdfActive = 0;
const kdfWaiters: Array<() => void> = [];
async function withKdfSlot<T>(fn: () => Promise<T>): Promise<T | 'overloaded'> {
	if (kdfActive >= MAX_CONCURRENT_KDF) {
		if (kdfWaiters.length >= MAX_QUEUED_KDF) return 'overloaded';
		await new Promise<void>((r) => kdfWaiters.push(r));
	}
	kdfActive++;
	try { return await fn(); }
	finally {
		const next = kdfWaiters.shift();
		if (next) next(); else kdfActive--;
	}
}

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(plain: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await scryptAsync(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Always resolves (never rejects): a corrupt stored value is a wrong password, not a crash. */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
	const parts = String(stored).split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
	if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
	if (n > MAX_N || (n & (n - 1)) !== 0 || r > MAX_R || p > MAX_P) return false;
	const salt = Buffer.from(parts[4]!, 'hex');
	const expected = Buffer.from(parts[5]!, 'hex');
	if (expected.length === 0) return false;
	try {
		const key = await scryptAsync(plain, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
		return key.length === expected.length && timingSafeEqual(key, expected);
	} catch (err) {
		console.error('[remote] cannot verify stored password hash:', err);
		return false;
	}
}

export function loadAuthStore(file: string): AuthStore {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AuthStore>;
		const devices = Array.isArray(raw.devices) ? raw.devices.filter((d): d is DeviceRecord =>
			!!d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && typeof d.createdAt === 'number' && typeof d.lastSeen === 'number')
			.map((d) => ({ ...d, label: typeof d.label === 'string' ? d.label : '' })) : [];
		return { passwordHash: typeof raw.passwordHash === 'string' ? raw.passwordHash : null, devices };
	} catch { return { passwordHash: null, devices: [] }; }
}

/** tmp + rename so a crash mid-write can never leave a half file (which loadAuthStore would read as "no password"). */
export function saveAuthStore(file: string, store: AuthStore): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
	fs.renameSync(tmp, file);
}

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
function tokensMatch(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
	return ba.length === 32 && bb.length === 32 && timingSafeEqual(ba, bb);
}

export function createAuth(deps: { file: string; now?: () => number; onDevicesRevoked?: (ids: string[]) => void }): RemoteAuth {
	const now = deps.now ?? Date.now;
	let store = loadAuthStore(deps.file);
	const save = (): void => saveAuthStore(deps.file, store);

	const lockouts = new Map<string, { failCount: number; lockedUntil: number | null; lastFailAt: number }>();
	const global = { count: 0, windowStart: 0, lockedUntil: 0 };
	let lastPrune = 0;

	function pruneLockouts(): void {
		const t = now();
		if (t - lastPrune < 60_000) return;
		lastPrune = t;
		for (const [ip, e] of lockouts) {
			if (e.lockedUntil !== null && t < e.lockedUntil) continue;
			if (t - e.lastFailAt < LOCKOUT_DURATION_MS) continue;
			lockouts.delete(ip);
		}
	}
	function recordFailure(ip: string): void {
		const t = now();
		const e = lockouts.get(ip) ?? { failCount: 0, lockedUntil: null, lastFailAt: t };
		e.failCount++; e.lastFailAt = t;
		if (e.failCount >= LOCKOUT_THRESHOLD) { e.lockedUntil = t + LOCKOUT_DURATION_MS; e.failCount = 0; }
		lockouts.set(ip, e);
		if (t - global.windowStart > GLOBAL_LOCKOUT_WINDOW_MS) { global.windowStart = t; global.count = 0; }
		global.count++;
		if (global.count >= GLOBAL_LOCKOUT_THRESHOLD) {
			global.lockedUntil = t + GLOBAL_LOCKOUT_DURATION_MS; global.count = 0; global.windowStart = t;
			console.error('[remote] account-wide password cool-off engaged');
		}
	}

	function destroyDevices(select: (d: DeviceRecord) => boolean): string[] {
		const removed = store.devices.filter(select).map((d) => d.id);
		if (removed.length === 0) return [];
		store.devices = store.devices.filter((d) => !removed.includes(d.id));
		save();
		try { deps.onDevicesRevoked?.(removed); } catch (err) { console.error('[remote] onDevicesRevoked threw:', err); }
		return removed;
	}

	function mintDevice(label: string | undefined): AuthResult {
		const token = randomBytes(32).toString('hex');
		const t = now();
		const device: DeviceRecord = { id: randomUUID(), label: (label ?? 'device').slice(0, MAX_DEVICE_LABEL_LENGTH), tokenHash: hashToken(token), createdAt: t, lastSeen: t };
		store.devices.push(device);
		save();
		return { ok: true, deviceToken: token, deviceId: device.id };
	}

	async function tryPassword(plain: string, ip: string, label?: string): Promise<AuthResult> {
		if (!store.passwordHash) return { ok: false, error: NO_PASSWORD_ERROR };
		pruneLockouts();
		const e = lockouts.get(ip);
		if (e && e.lockedUntil !== null && now() < e.lockedUntil) return { ok: false, error: TOO_MANY_ATTEMPTS_ERROR };
		if (now() < global.lockedUntil) return { ok: false, error: TOO_MANY_ATTEMPTS_ERROR };
		const verdict = await withKdfSlot(() => verifyPassword(store.passwordHash!, plain));
		if (verdict === 'overloaded') return { ok: false, error: TOO_MANY_ATTEMPTS_ERROR };
		if (!verdict) { recordFailure(ip); return { ok: false, error: 'invalid password' }; }
		lockouts.delete(ip);
		global.count = 0;
		return mintDevice(label);
	}

	function tryDeviceToken(raw: string): AuthResult {
		const candidate = hashToken(raw);
		for (const d of store.devices) {
			if (!tokensMatch(d.tokenHash, candidate)) continue;
			if (now() - d.lastSeen > DEVICE_TOKEN_TTL_MS) {
				store.devices = store.devices.filter((x) => x.id !== d.id); save();
				return { ok: false, error: 'device token expired' };
			}
			d.lastSeen = now(); save();
			return { ok: true, deviceId: d.id };
		}
		return { ok: false, error: 'unknown device token' };
	}

	return {
		authenticate(frame, ip) {
			if (typeof frame.deviceToken === 'string') return Promise.resolve(tryDeviceToken(frame.deviceToken));
			if (typeof frame.password === 'string') return tryPassword(frame.password, ip, frame.deviceLabel);
			return Promise.resolve({ ok: false, error: 'no credentials supplied' });
		},
		hasPassword: () => !!store.passwordHash,
		async setPassword(plain) {
			if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
			store.passwordHash = await hashPassword(plain);
			save();
			const removed = destroyDevices(() => true);
			return { devicesSignedOut: removed.length };
		},
		listDevices: () => store.devices.map(({ id, label, createdAt, lastSeen }) => ({ id, label, createdAt, lastSeen })),
		revokeDevice: (id) => destroyDevices((d) => d.id === id).length > 0,
	};
}
```

Note: `store` is declared with `let` only so a future reload can reassign it; ESLint may flag it as never reassigned — change to `const` if lint complains.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/remote-auth.test.ts`
Expected: PASS (10 tests). The lockout tests run ~25 scrypt verifies each; allow up to a minute.

- [ ] **Step 5: Commit**

```bash
git add electron/remote/auth.ts tests/remote-auth.test.ts
git commit -m "feat(remote): scrypt password, device tokens, lockouts, remote-auth.json"
```

---

### Task 4: Payload validators and URL helpers

**Files:**
- Modify: `electron/remote-actions.ts` (append after `parseRemoteAction`)
- Modify: `electron/remote-net.ts:24-35`
- Test: `tests/remote-actions.test.ts` (append), `tests/remote-net.test.ts` (modify)

**Interfaces:**
- Produces in `remote-actions.ts`:
  ```ts
  export type TileInvoke =
    | { channel: 'floor:state' } | { channel: 'board:get' } | { channel: 'kane:snapshot' }
    | { channel: 'tile:snapshot' | 'tile:center' | 'tile:hide' | 'tile:show' | 'tile:kill'; id: number }
    | { channel: 'tile:write'; id: number; data: string }
    | { channel: 'kane:write'; data: string }
    | { channel: 'tile:rename'; id: number; name: string }
    | { channel: 'tile:spawn'; repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null }
    | { channel: 'workspace:switch'; id: string };
  export const FORWARDED_CHANNELS: ReadonlySet<string>;
  export const MAX_WRITE = 65536; export const MAX_NAME = 80;
  export function parseTileInvoke(channel: string, payload: unknown): TileInvoke | null
  ```
- Produces in `remote-net.ts`: `accessUrls` → `http://<h>:<port>/phone?t=<token>`; `httpsUrlFor` → `https://<host>/phone?t=<token>`; new `tailscaleIps(ifaces): string[]`; new `browserUrls(hosts, port): string[]` → `http://<h>:<port>/`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/remote-actions.test.ts`:

```ts
import { parseTileInvoke, FORWARDED_CHANNELS, MAX_WRITE, KANE_ID } from '../electron/remote-actions';

describe('parseTileInvoke', () => {
	it('accepts the payload-less channels with any payload', () => {
		expect(parseTileInvoke('floor:state', undefined)).toEqual({ channel: 'floor:state' });
		expect(parseTileInvoke('board:get', { junk: 1 })).toEqual({ channel: 'board:get' });
		expect(parseTileInvoke('kane:snapshot', null)).toEqual({ channel: 'kane:snapshot' });
	});
	it('validates id channels: non-negative integers only, never Kane', () => {
		for (const ch of ['tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill'] as const) {
			expect(parseTileInvoke(ch, { id: 3 })).toEqual({ channel: ch, id: 3 });
			expect(parseTileInvoke(ch, { id: -1 })).toBeNull();
			expect(parseTileInvoke(ch, { id: 1.5 })).toBeNull();
			expect(parseTileInvoke(ch, { id: '3' })).toBeNull();
			expect(parseTileInvoke(ch, {})).toBeNull();
		}
		expect(parseTileInvoke('tile:center', { id: KANE_ID })).toBeNull();
	});
	it('caps tile:write and kane:write data', () => {
		expect(parseTileInvoke('tile:write', { id: 1, data: 'ls\r' })).toEqual({ channel: 'tile:write', id: 1, data: 'ls\r' });
		expect(parseTileInvoke('tile:write', { id: 1, data: '' })).toBeNull();
		expect(parseTileInvoke('tile:write', { id: 1, data: 'x'.repeat(MAX_WRITE + 1) })).toBeNull();
		expect(parseTileInvoke('kane:write', { data: 'hi\r' })).toEqual({ channel: 'kane:write', data: 'hi\r' });
		expect(parseTileInvoke('kane:write', { data: 5 })).toBeNull();
	});
	it('trims and caps rename', () => {
		expect(parseTileInvoke('tile:rename', { id: 2, name: '  api  ' })).toEqual({ channel: 'tile:rename', id: 2, name: 'api' });
		expect(parseTileInvoke('tile:rename', { id: 2, name: '   ' })).toBeNull();
		expect(parseTileInvoke('tile:rename', { id: 2, name: 'x'.repeat(81) })).toBeNull();
	});
	it('spawn requires repo + task; optional fields normalize to null', () => {
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 'do it' })).toEqual({ channel: 'tile:spawn', repo: 'r', base: null, task: 'do it', model: null, effort: null, name: null });
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 'do it', base: 'main', model: 'claude-opus-4-8', effort: 'high', name: 'n' }))
			.toEqual({ channel: 'tile:spawn', repo: 'r', base: 'main', task: 'do it', model: 'claude-opus-4-8', effort: 'high', name: 'n' });
		expect(parseTileInvoke('tile:spawn', { repo: '', task: 't' })).toBeNull();
		expect(parseTileInvoke('tile:spawn', { repo: 'r' })).toBeNull();
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 't', effort: 'silly' })).toBeNull();
	});
	it('workspace:switch needs a non-empty string id', () => {
		expect(parseTileInvoke('workspace:switch', { id: ' ws-2 ' })).toEqual({ channel: 'workspace:switch', id: 'ws-2' });
		expect(parseTileInvoke('workspace:switch', { id: '' })).toBeNull();
	});
	it('rejects unknown channels and lists the forwarded set', () => {
		expect(parseTileInvoke('config:set', {})).toBeNull();
		expect([...FORWARDED_CHANNELS].sort()).toEqual(['board:get', 'floor:state', 'kane:snapshot', 'kane:write', 'tile:center', 'tile:hide', 'tile:kill', 'tile:rename', 'tile:show', 'tile:snapshot', 'tile:spawn', 'tile:write', 'workspace:switch']);
	});
});
```

In `tests/remote-net.test.ts` change the `accessUrls` and `httpsUrlFor` expectations to the `/phone` paths and add:

```ts
import { tailscaleIps, browserUrls } from '../electron/remote-net';

describe('accessUrls', () => {
  it('builds token URLs per host under /phone', () => {
    expect(accessUrls(['100.92.3.4', 'mybox'], 7420, 'abcd')).toEqual([
      'http://100.92.3.4:7420/phone?t=abcd', 'http://mybox:7420/phone?t=abcd',
    ]);
  });
});
describe('httpsUrlFor', () => {
  it('points at /phone and strips the trailing dot', () => {
    expect(httpsUrlFor('box.tail.ts.net.', 'tok')).toBe('https://box.tail.ts.net/phone?t=tok');
    expect(httpsUrlFor(null, 'tok')).toBeNull();
  });
});
describe('tailscaleIps / browserUrls', () => {
  it('returns only the CGNAT-range IPv4s', () => {
    expect(tailscaleIps({ eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }], ts0: [{ family: 'IPv4', address: '100.92.3.4', internal: false }] } as any)).toEqual(['100.92.3.4']);
    expect(tailscaleIps({} as any)).toEqual([]);
  });
  it('builds plain browser URLs', () => {
    expect(browserUrls(['127.0.0.1', '100.92.3.4'], 7420)).toEqual(['http://127.0.0.1:7420/', 'http://100.92.3.4:7420/']);
  });
});
```

(Replace the existing `accessUrls`/`httpsUrlFor` describe blocks rather than duplicating them. Keep every other test in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/remote-actions.test.ts tests/remote-net.test.ts`
Expected: FAIL — `parseTileInvoke` not exported; URL expectations mismatch.

- [ ] **Step 3: Implement**

Append to `electron/remote-actions.ts`:

```ts
import { EFFORT_LEVELS } from '../src/terminals/god';

/** The browser's forwarded invokes, validated in MAIN before they cross IPC to the renderer.
 *  Same discipline as parseRemoteAction: nothing reaches a live session until it parses cleanly.
 *  Unlike the phone's `input`, `tile:write` is RAW keystrokes — the browser holds live state from
 *  `floor:state` events (not a 2s poll), so the name-must-match guard is not needed here. */
export type TileInvoke =
	| { channel: 'floor:state' } | { channel: 'board:get' } | { channel: 'kane:snapshot' }
	| { channel: 'tile:snapshot' | 'tile:center' | 'tile:hide' | 'tile:show' | 'tile:kill'; id: number }
	| { channel: 'tile:write'; id: number; data: string }
	| { channel: 'kane:write'; data: string }
	| { channel: 'tile:rename'; id: number; name: string }
	| { channel: 'tile:spawn'; repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null }
	| { channel: 'workspace:switch'; id: string };

export const FORWARDED_CHANNELS: ReadonlySet<string> = new Set([
	'floor:state', 'board:get', 'kane:snapshot', 'tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill',
	'tile:write', 'kane:write', 'tile:rename', 'tile:spawn', 'workspace:switch',
]);
export const MAX_WRITE = 65536;
export const MAX_NAME = 80;

const ID_CHANNELS = new Set(['tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill']);
const optStr = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function parseTileInvoke(channel: string, payload: unknown): TileInvoke | null {
	if (channel === 'floor:state' || channel === 'board:get' || channel === 'kane:snapshot') return { channel };
	const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
	if (ID_CHANNELS.has(channel)) return isTileId(p.id) ? { channel: channel as 'tile:snapshot', id: p.id } : null;
	if (channel === 'tile:write') {
		if (!isTileId(p.id) || typeof p.data !== 'string' || !p.data || p.data.length > MAX_WRITE) return null;
		return { channel, id: p.id, data: p.data };
	}
	if (channel === 'kane:write') {
		if (typeof p.data !== 'string' || !p.data || p.data.length > MAX_WRITE) return null;
		return { channel, data: p.data };
	}
	if (channel === 'tile:rename') {
		if (!isTileId(p.id) || typeof p.name !== 'string') return null;
		const name = p.name.trim();
		if (!name || name.length > MAX_NAME) return null;
		return { channel, id: p.id, name };
	}
	if (channel === 'tile:spawn') {
		const repo = optStr(p.repo), task = optStr(p.task, MAX_INPUT);
		if (!repo || !task) return null;
		const effort = optStr(p.effort, 20);
		if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return null;
		return { channel, repo, base: optStr(p.base), task, model: optStr(p.model, 60), effort, name: optStr(p.name, MAX_NAME) };
	}
	if (channel === 'workspace:switch') {
		const id = optStr(p.id);
		return id ? { channel, id } : null;
	}
	return null;
}
```

Check that `src/terminals/god.ts` has no Node imports (it is imported by `terminals-grid.ts`, and `EFFORT_LEVELS` is a plain array). Run `grep -n "^import" src/terminals/god.ts`; if it imports `fs`/`path`, move `EFFORT_LEVELS` into the new `src/terminals/spawn-options.ts` (Task 9) and import from there instead — but do that in this task so the test passes now: create `src/terminals/spawn-options.ts` with just `export const EFFORT_LEVELS = [...] as const` copied verbatim from `god.ts`, make `god.ts` re-export it (`export { EFFORT_LEVELS } from './spawn-options'`), and import from `spawn-options` here.

In `electron/remote-net.ts` replace lines 24-35 with:

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/remote-actions.test.ts tests/remote-net.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/remote-actions.ts electron/remote-net.ts tests/remote-actions.test.ts tests/remote-net.test.ts src/terminals/spawn-options.ts src/terminals/god.ts
git commit -m "feat(remote): validate browser invokes in main; phone URLs move to /phone"
```

---

### Task 5: Phone routes become a handler, not a server

**Files:**
- Modify: `electron/remote-server.ts:1-61`
- Test: `tests/phone-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PhoneRouteDeps { token: string; getFloor: () => unknown; onAction: (action: RemoteAction) => void }
  /** Returns true if it handled the request. Handles GET /phone, GET /api/floor, POST /api/action, any other /api/*. */
  export function createPhoneRoutes(deps: PhoneRouteDeps): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean
  export const MOBILE_HTML: string  // unchanged template literal
  ```
- Removes: `startRemoteServer`, `RemoteServerOpts`, the module-level `floorState` and the `ipcMain` import. Floor-state caching moves to `main.ts` (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
// tests/phone-routes.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/phone-routes.test.ts`
Expected: FAIL — `createPhoneRoutes` is not exported.

- [ ] **Step 3: Implement**

Replace lines 1-61 of `electron/remote-server.ts` with:

```ts
import type { IncomingMessage, ServerResponse } from 'http';
import { parseRemoteAction, type RemoteAction } from './remote-actions';

export interface PhoneRouteDeps { token: string; getFloor: () => unknown; onAction: (action: RemoteAction) => void; }

/** The phone floor view's routes, mounted by the browser gateway (electron/remote/gateway.ts):
 *  GET /phone (the page, no token — it is a shell), GET /api/floor and POST /api/action (token
 *  in `?t=`). Returns true when it handled the request. The page's own fetches use absolute
 *  `/api/...` paths, so serving it at /phone instead of / needs no change to MOBILE_HTML. */
export function createPhoneRoutes(deps: PhoneRouteDeps): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
	const authed = (req: IncomingMessage): boolean => {
		try { return new URL(req.url ?? '/', 'http://x').searchParams.get('t') === deps.token; } catch { return false; }
	};
	const json = (res: ServerResponse, code: number, body: unknown): void => {
		res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
	};
	return (req, res, pathname) => {
		if (req.method === 'GET' && pathname === '/phone') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(MOBILE_HTML); return true;
		}
		if (!pathname.startsWith('/api/')) return false;
		if (!authed(req)) { json(res, 401, { error: 'bad token' }); return true; }
		if (req.method === 'GET' && pathname === '/api/floor') { json(res, 200, deps.getFloor()); return true; }
		if (req.method === 'POST' && pathname === '/api/action') {
			let body = '';
			req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
			req.on('end', () => {
				try {
					const action = parseRemoteAction(JSON.parse(body));
					if (!action) { json(res, 400, { error: 'bad action' }); return; }
					deps.onAction(action);
					json(res, 200, { ok: true });
				} catch { json(res, 400, { error: 'bad body' }); }
			});
			return true;
		}
		json(res, 404, { error: 'not found' });
		return true;
	};
}
```

Keep the `MOBILE_HTML` comment block and template literal below exactly as they are, but change `const MOBILE_HTML` to `export const MOBILE_HTML`. `main.ts` will not compile until Task 11 rewires it; that is expected — run only the named test file here, not `npm run build`.

- [ ] **Step 4: Run test**

Run: `npx vitest run tests/phone-routes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote-server.ts tests/phone-routes.test.ts
git commit -m "refactor(remote): phone floor view becomes routes for the shared gateway"
```

---

### Task 6: Gateway (HTTP + WebSocket)

**Files:**
- Create: `electron/remote/gateway.ts`
- Modify: `package.json` (add `"ws": "^8.18.0"` to dependencies, `"@types/ws": "^8.5.13"` to devDependencies; run `npm install`)
- Test: `tests/remote-gateway.test.ts`

**Interfaces:**
- Consumes: `parseClientFrame`, constants (Task 1); `AuthResult`/`AuthFrame` (Task 3); `createPhoneRoutes` handler type (Task 5).
- Produces:
  ```ts
  export type Handler = (payload: unknown) => Promise<unknown>;
  export type HandlerTable = Record<string, Handler>;
  export interface GatewayOpts {
    port: number;
    hosts: string[];                       // e.g. ['127.0.0.1', '100.92.3.4']
    staticDir: string;                     // dist/web
    table: HandlerTable;
    authenticate: (frame: AuthFrame, ip: string) => Promise<AuthResult>;
    phoneRoutes?: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;
    backpressureLimitBytes?: number;       // test seam; default 4 MB
    heartbeatSweepMs?: number;             // test seam; default 15 s
    heartbeatTimeoutMs?: number;           // test seam; default 60 s
  }
  export interface GatewayHandle {
    boundHosts(): string[];
    addHost(host: string): Promise<boolean>;     // late Tailscale bind; false if already bound or failed
    broadcast(channel: string, payload: unknown): void;
    endDeviceSessions(deviceIds: readonly string[]): number;
    clientCount(): number;                       // authed sockets
    onClientCount(cb: (n: number) => void): () => void;
    close(): Promise<void>;
  }
  export function startGateway(opts: GatewayOpts): Promise<GatewayHandle>
  export const APP_SHELL_SECURITY_HEADERS: Readonly<Record<string, string>>
  ```

- [ ] **Step 1: Install ws**

Run: `npm install ws@^8.18.0 && npm install -D @types/ws@^8.5.13`
Expected: both appear in `package.json`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/remote-gateway.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { startGateway, type GatewayHandle } from '../electron/remote/gateway';
import type { AuthFrame, AuthResult } from '../electron/remote/auth';

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
		s.pause();
		const done = closed(s);
		for (let i = 0; i < 50; i++) gw!.broadcast('tile:data', { chunk: 'y'.repeat(100_000) });
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
});
```

Add `boundPort(): number` to `GatewayHandle` (the test uses it; port `0` binds ephemeral).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/remote-gateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// electron/remote/gateway.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFile, stat } from 'fs/promises';
import { resolve as resolvePath, relative, isAbsolute, extname, join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { parseClientFrame, type ServerFrame, MAX_FRAME_BYTES, DEVICE_REVOKED_ERROR, DEVICE_REVOKED_CLOSE_CODE, SLOW_CONSUMER_CLOSE_CODE, WS_PATH } from './protocol';
import type { AuthFrame, AuthResult } from './auth';

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
const MAX_AUTH_ATTEMPTS_PER_SOCKET = 10;
const MAX_AUTH_ATTEMPTS_PER_IP = 12;
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export const APP_SHELL_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
};

interface ClientState { authed: boolean; deviceId?: string; lastSeen: number; authAttempts: number; unauthedFrames: number; blocked: boolean; }

function routePathname(url: string | undefined): string {
	try { return new URL(url ?? '/', 'http://localhost').pathname; } catch { return ''; }
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
	const notifyCount = (): void => {
		const n = [...sockets.values()].filter((s) => s.authed).length;
		if (n === lastCount) return;
		lastCount = n;
		for (const cb of countListeners) { try { cb(n); } catch (err) { console.error('[remote] client-count listener threw:', err); } }
	};
	const sendFrame = (ws: WebSocket, f: ServerFrame): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)); };

	function dispatch(raw: string, ip: string, ws: WebSocket, state: ClientState): void {
		if (state.blocked) return;
		state.lastSeen = Date.now();
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
			const origin = info.origin;
			if (!origin) { cb(true); return; }
			try { if (new URL(origin).host === info.req.headers.host) { cb(true); return; } } catch { /* malformed */ }
			cb(false, 403, 'Forbidden origin');
		},
	});
	wss.on('connection', (ws, req) => {
		const state: ClientState = { authed: false, lastSeen: Date.now(), authAttempts: 0, unauthedFrames: 0, blocked: false };
		sockets.set(ws, state);
		const ip = req.socket.remoteAddress ?? 'unknown';
		ws.on('message', (raw) => dispatch(raw.toString(), ip, ws, state));
		const drop = (): void => { sockets.delete(ws); notifyCount(); };
		ws.on('close', drop);
		ws.on('error', drop);
	});

	const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
		const pathname = routePathname(req.url);
		if (opts.phoneRoutes?.(req, res, pathname)) return;
		void serveStatic(opts.staticDir, req, res);
	};
	const upgradeHandler = (req: IncomingMessage, socket: import('stream').Duplex, head: Buffer): void => {
		if (routePathname(req.url) === WS_PATH) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
		else socket.destroy();
	};

	const servers = new Map<string, Server>();
	let port = opts.port;
	async function listenOn(host: string): Promise<boolean> {
		if (servers.has(host) || host === '0.0.0.0' || host === '::') return false;
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
				if (ws.bufferedAmount > backpressure) { ws.close(SLOW_CONSUMER_CLOSE_CODE, 'slow-consumer'); continue; }
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
			clearInterval(sweep);
			for (const ws of sockets.keys()) ws.terminate();
			wss.close();
			await Promise.all([...servers.values()].map((s) => new Promise<void>((r) => s.close(() => r()))));
			servers.clear();
		},
	};
}
```

- [ ] **Step 5: Run test**

Run: `npx vitest run tests/remote-gateway.test.ts`
Expected: PASS (13 tests). If the slow-consumer test is flaky on your machine, raise the loop to 200 broadcasts; the limit is 1 byte so any queued frame trips it.

- [ ] **Step 6: Commit**

```bash
git add electron/remote/gateway.ts tests/remote-gateway.test.ts package.json package-lock.json
git commit -m "feat(remote): HTTP+WebSocket gateway with auth gate, fan-out, backpressure"
```

---

### Task 7: Main ↔ renderer RPC

**Files:**
- Create: `electron/remote/renderer-rpc.ts`
- Test: `tests/renderer-rpc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RpcReply { id: string; ok: boolean; value?: unknown; error?: string }
  export interface RendererRpc {
    invoke(channel: string, payload: unknown): Promise<unknown>;  // rejects Error('request failed') on timeout / rejectAll
    handleReply(r: unknown): void;                                 // ignores unknown ids / malformed
    rejectAll(): void;                                             // renderer reloaded or gone
    pendingCount(): number;
  }
  export function createRendererRpc(deps: { send: (msg: { id: string; channel: string; payload: unknown }) => void; timeoutMs?: number; setTimer?: (cb: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }): RendererRpc
  ```
- Wire (Task 11): main sends `webContents.send('remote:invoke', msg)`; renderer answers `ipcRenderer.send('remote:reply', reply)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/renderer-rpc.test.ts
import { describe, it, expect } from 'vitest';
import { createRendererRpc } from '../electron/remote/renderer-rpc';

describe('createRendererRpc', () => {
	it('sends an invoke and resolves on the matching reply', async () => {
		const sent: any[] = [];
		const rpc = createRendererRpc({ send: (m) => sent.push(m) });
		const p = rpc.invoke('floor:state', { a: 1 });
		expect(sent).toHaveLength(1);
		expect(sent[0].channel).toBe('floor:state');
		expect(sent[0].payload).toEqual({ a: 1 });
		rpc.handleReply({ id: sent[0].id, ok: true, value: 42 });
		await expect(p).resolves.toBe(42);
		expect(rpc.pendingCount()).toBe(0);
	});
	it('rejects with the fixed error on a failed reply', async () => {
		const sent: any[] = [];
		const rpc = createRendererRpc({ send: (m) => sent.push(m) });
		const p = rpc.invoke('x', null);
		rpc.handleReply({ id: sent[0].id, ok: false, error: 'boom with C:\\path' });
		await expect(p).rejects.toThrow('request failed');
	});
	it('ignores unknown ids and garbage replies', () => {
		const rpc = createRendererRpc({ send: () => {} });
		expect(() => rpc.handleReply({ id: 'nope', ok: true })).not.toThrow();
		expect(() => rpc.handleReply(null)).not.toThrow();
		expect(() => rpc.handleReply('str')).not.toThrow();
	});
	it('times out with the fixed error', async () => {
		let fire: (() => void) | null = null;
		const rpc = createRendererRpc({ send: () => {}, timeoutMs: 10, setTimer: (cb) => { fire = cb; return 1; }, clearTimer: () => {} });
		const p = rpc.invoke('x', null);
		fire!();
		await expect(p).rejects.toThrow('request failed');
		expect(rpc.pendingCount()).toBe(0);
	});
	it('rejectAll fails every pending invoke', async () => {
		const rpc = createRendererRpc({ send: () => {} });
		const a = rpc.invoke('a', null), b = rpc.invoke('b', null);
		rpc.rejectAll();
		await expect(a).rejects.toThrow('request failed');
		await expect(b).rejects.toThrow('request failed');
	});
	it('uses distinct ids', () => {
		const sent: any[] = [];
		const rpc = createRendererRpc({ send: (m) => sent.push(m) });
		void rpc.invoke('a', null); void rpc.invoke('a', null);
		expect(sent[0].id).not.toBe(sent[1].id);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// electron/remote/renderer-rpc.ts
/** Main → desktop-renderer request/reply. The renderer owns every terminal, so most browser
 *  invokes are forwarded here and answered by src/app.ts. Pure (no electron import) so it
 *  unit-tests; main.ts supplies `send` = webContents.send('remote:invoke', ...). */
export interface RpcReply { id: string; ok: boolean; value?: unknown; error?: string; }
export interface RendererRpc {
	invoke(channel: string, payload: unknown): Promise<unknown>;
	handleReply(r: unknown): void;
	rejectAll(): void;
	pendingCount(): number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const FAILED = 'request failed';

export function createRendererRpc(deps: {
	send: (msg: { id: string; channel: string; payload: unknown }) => void;
	timeoutMs?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}): RendererRpc {
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
	let seq = 0;

	function settle(id: string): { resolve: (v: unknown) => void; reject: (e: Error) => void } | null {
		const p = pending.get(id);
		if (!p) return null;
		pending.delete(id);
		clearTimer(p.timer);
		return p;
	}

	return {
		invoke(channel, payload) {
			const id = String(++seq);
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimer(() => { settle(id)?.reject(new Error(FAILED)); }, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				try { deps.send({ id, channel, payload }); }
				catch (err) { console.error('[remote] rpc send failed:', err); settle(id)?.reject(new Error(FAILED)); }
			});
		},
		handleReply(r) {
			if (!r || typeof r !== 'object') return;
			const { id, ok, value, error } = r as Partial<RpcReply>;
			if (typeof id !== 'string') return;
			const p = settle(id);
			if (!p) return;
			if (ok) p.resolve(value);
			else { if (error) console.error('[remote] renderer rpc failed:', error); p.reject(new Error(FAILED)); }
		},
		rejectAll() { for (const id of [...pending.keys()]) settle(id)?.reject(new Error(FAILED)); },
		pendingCount: () => pending.size,
	};
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run tests/renderer-rpc.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/renderer-rpc.ts tests/renderer-rpc.test.ts
git commit -m "feat(remote): main→renderer rpc with timeout"
```

---

### Task 8: The browser handler table

**Files:**
- Create: `electron/remote/handlers.ts`
- Test: `tests/remote-handlers.test.ts`

**Interfaces:**
- Consumes: `HandlerTable` (Task 6), `RendererRpc` (Task 7), `parseTileInvoke`/`FORWARDED_CHANNELS` (Task 4).
- Produces:
  ```ts
  export interface HandlerDeps { rpc: RendererRpc; readConfig: () => unknown }
  export function createRemoteHandlers(deps: HandlerDeps): HandlerTable
  /** Only these keys survive from config.json on the wire. */
  export const CONFIG_PUBLIC_KEYS = ['repos', 'workspaces', 'activeWorkspace', 'theme'] as const;
  ```
- Table contents: `config:get` (sanitized), plus one entry per `FORWARDED_CHANNELS` member that validates with `parseTileInvoke` (throws `Error('invalid payload')` on null) and then `rpc.invoke(channel, parsed)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/remote-handlers.test.ts
import { describe, it, expect } from 'vitest';
import { createRemoteHandlers, CONFIG_PUBLIC_KEYS } from '../electron/remote/handlers';
import { FORWARDED_CHANNELS } from '../electron/remote-actions';

function fakeRpc() {
	const calls: any[] = [];
	return { calls, rpc: { invoke: async (channel: string, payload: unknown) => { calls.push({ channel, payload }); return 'ok'; }, handleReply: () => {}, rejectAll: () => {}, pendingCount: () => 0 } };
}

describe('createRemoteHandlers', () => {
	it('exposes config:get and every forwarded channel, nothing else', () => {
		const t = createRemoteHandlers({ rpc: fakeRpc().rpc, readConfig: () => ({}) });
		expect(Object.keys(t).sort()).toEqual(['config:get', ...FORWARDED_CHANNELS].sort());
		expect('config:set' in t).toBe(false);
		expect('addFolder' in t).toBe(false);
	});
	it('config:get returns only the public keys', async () => {
		const t = createRemoteHandlers({ rpc: fakeRpc().rpc, readConfig: () => ({ repos: [{ name: 'r', path: 'C:\\r' }], theme: 'iris', linearConvert: { token: 'SECRET' }, god: { x: 1 } }) });
		expect(await t['config:get']!(undefined)).toEqual({ repos: [{ name: 'r', path: 'C:\\r' }], theme: 'iris' });
		expect(CONFIG_PUBLIC_KEYS).toEqual(['repos', 'workspaces', 'activeWorkspace', 'theme']);
	});
	it('forwards a valid payload as its parsed form', async () => {
		const f = fakeRpc();
		const t = createRemoteHandlers({ rpc: f.rpc, readConfig: () => ({}) });
		expect(await t['tile:rename']!({ id: 1, name: ' api ' })).toBe('ok');
		expect(f.calls).toEqual([{ channel: 'tile:rename', payload: { channel: 'tile:rename', id: 1, name: 'api' } }]);
	});
	it('throws the fixed invalid-payload error without forwarding', async () => {
		const f = fakeRpc();
		const t = createRemoteHandlers({ rpc: f.rpc, readConfig: () => ({}) });
		await expect(t['tile:write']!({ id: -1, data: 'x' })).rejects.toThrow('invalid payload');
		expect(f.calls).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/remote-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// electron/remote/handlers.ts
import type { HandlerTable } from './gateway';
import type { RendererRpc } from './renderer-rpc';
import { FORWARDED_CHANNELS, parseTileInvoke } from '../remote-actions';

export interface HandlerDeps { rpc: RendererRpc; readConfig: () => unknown; }

/** config.json holds more than the browser needs (linearConvert credentials, Kane's self-improve
 *  paths). Only these keys ever leave the machine. */
export const CONFIG_PUBLIC_KEYS = ['repos', 'workspaces', 'activeWorkspace', 'theme'] as const;

/** The whole set of channels a logged-in browser may invoke. Anything not in here answers
 *  'unknown channel' at the gateway. Every forwarded channel is validated HERE (main) before it
 *  crosses IPC — the renderer trusts what arrives on remote:invoke. */
export function createRemoteHandlers(deps: HandlerDeps): HandlerTable {
	const table: HandlerTable = {
		'config:get': async () => {
			const cfg = (deps.readConfig() ?? {}) as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const k of CONFIG_PUBLIC_KEYS) if (k in cfg) out[k] = cfg[k];
			return out;
		},
	};
	for (const channel of FORWARDED_CHANNELS) {
		table[channel] = async (payload) => {
			const parsed = parseTileInvoke(channel, payload);
			if (!parsed) throw new Error('invalid payload');
			return deps.rpc.invoke(channel, parsed);
		};
	}
	return table;
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run tests/remote-handlers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/handlers.ts tests/remote-handlers.test.ts
git commit -m "feat(remote): browser handler table (sanitized config + validated forwards)"
```

---

### Task 9: Remote tap, spawn options, floor state (pure renderer modules)

**Files:**
- Create: `src/terminals/remote-tap.ts`, `src/terminals/floor-state.ts`, `src/terminals/spawn-options.ts` (if not already created in Task 4; otherwise extend it)
- Modify: `src/terminals/terminals-grid.ts:59-72` (delete `SPAWN_MODELS`/`SPAWN_EFFORTS`, import them)
- Test: `tests/remote-tap.test.ts`, `tests/floor-state.test.ts`

**Interfaces:**
- Produces in `remote-tap.ts`:
  ```ts
  export type TapKey = string;  // `${workspaceId}:${tileId}` or `${workspaceId}:kane`
  export interface TapDeps { emit: (channel: string, payload: unknown) => void; batchMs?: number; maxChars?: number; setTimer?: (cb: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }
  export class RemoteTap {
    constructor(deps: TapDeps);
    setClientCount(n: number): void;
    push(key: TapKey, chunk: string): void;      // always buffers; emits batched `tile:data` {key, chunk} only when clients > 0
    restart(key: TapKey): void;                   // clears the buffer, pushes + emits the restart marker
    snapshot(key: TapKey): string;
    detach(key: TapKey): void;                    // drops the buffer, emits `tile:exit` {key}
    keys(): TapKey[];
  }
  export const RESTART_MARKER = '\r\n\x1b[2m— restarted —\x1b[0m\r\n';
  ```
- Produces in `spawn-options.ts`: `SPAWN_MODELS`, `SPAWN_EFFORTS` (moved verbatim from `terminals-grid.ts`), `EFFORT_LEVELS` (re-exported or moved per Task 4).
- Produces in `floor-state.ts`:
  ```ts
  export interface FloorTile { id: number; name: string; repo: string; branch: string; state: string; remoteOn: boolean; hidden: boolean; cols: number; rows: number; model: string | null; effort: string | null; locked: boolean }
  export interface FloorKane { name: string; state: string; cols: number; rows: number; visible: boolean }
  export interface FloorState {
    workspaceId: string; centeredId: number | null; terminals: FloorTile[]; kane: FloorKane | null;
    workspaces: Array<{ id: string; name: string; active: boolean }>; repos: string[]; theme: string;
    usage: { sessionPct: number | null; sessionReset: string | null; weekPct: number | null; weekReset: string | null; fablePct: number | null } | null;
  }
  export function debounceFloor(publish: (s: FloorState) => void, build: () => FloorState, ms?: number, setTimer?, clearTimer?): { request(): void; flush(): void }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/remote-tap.test.ts
import { describe, it, expect } from 'vitest';
import { RemoteTap, RESTART_MARKER } from '../src/terminals/remote-tap';

function make(clients = 1) {
	const events: any[] = [];
	let timers: Array<() => void> = [];
	const tap = new RemoteTap({ emit: (channel, payload) => events.push({ channel, payload }), setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {} });
	tap.setClientCount(clients);
	const tick = (): void => { const t = timers; timers = []; for (const cb of t) cb(); };
	return { tap, events, tick };
}

describe('RemoteTap', () => {
	it('buffers always, emits batched tile:data only with clients', () => {
		const { tap, events, tick } = make(0);
		tap.push('ws:1', 'a'); tap.push('ws:1', 'b');
		tick();
		expect(events).toEqual([]);
		expect(tap.snapshot('ws:1')).toBe('ab');
		tap.setClientCount(1);
		tap.push('ws:1', 'c'); tap.push('ws:1', 'd'); tap.push('ws:2', 'z');
		expect(events).toEqual([]); // not before the batch window
		tick();
		expect(events).toEqual([
			{ channel: 'tile:data', payload: { key: 'ws:1', chunk: 'cd' } },
			{ channel: 'tile:data', payload: { key: 'ws:2', chunk: 'z' } },
		]);
	});
	it('restart clears the buffer and emits the marker', () => {
		const { tap, events, tick } = make(1);
		tap.push('ws:1', 'old'); tick(); events.length = 0;
		tap.restart('ws:1'); tick();
		expect(tap.snapshot('ws:1')).toBe(RESTART_MARKER);
		expect(events).toEqual([{ channel: 'tile:data', payload: { key: 'ws:1', chunk: RESTART_MARKER } }]);
	});
	it('detach drops the buffer and emits tile:exit', () => {
		const { tap, events } = make(1);
		tap.push('ws:1', 'x');
		tap.detach('ws:1');
		expect(tap.snapshot('ws:1')).toBe('');
		expect(tap.keys()).toEqual([]);
		expect(events).toEqual([{ channel: 'tile:exit', payload: { key: 'ws:1' } }]);
	});
	it('caps the buffer', () => {
		const events: any[] = [];
		const tap = new RemoteTap({ emit: (c, p) => events.push(p), maxChars: 3 });
		tap.push('k', 'abcd');
		expect(tap.snapshot('k')).toBe('bcd');
	});
});
```

```ts
// tests/floor-state.test.ts
import { describe, it, expect } from 'vitest';
import { debounceFloor, type FloorState } from '../src/terminals/floor-state';

const state = (n: number): FloorState => ({ workspaceId: 'w', centeredId: n, terminals: [], kane: null, workspaces: [], repos: [], theme: 'default', usage: null });

describe('debounceFloor', () => {
	it('coalesces a burst into one publish after the window', () => {
		const out: FloorState[] = [];
		let n = 0;
		let timers: Array<() => void> = [];
		const d = debounceFloor((s) => out.push(s), () => state(++n), 100, (cb) => { timers.push(cb); return 1; }, () => {});
		d.request(); d.request(); d.request();
		expect(out).toEqual([]);
		const t = timers; timers = []; for (const cb of t) cb();
		expect(out).toHaveLength(1);
		expect(out[0]!.centeredId).toBe(1); // built once, at fire time
	});
	it('flush publishes immediately and cancels the pending timer', () => {
		const out: FloorState[] = [];
		let cleared = 0;
		const d = debounceFloor((s) => out.push(s), () => state(7), 100, () => 1, () => { cleared++; });
		d.request(); d.flush();
		expect(out.map((s) => s.centeredId)).toEqual([7]);
		expect(cleared).toBe(1);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/remote-tap.test.ts tests/floor-state.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/terminals/remote-tap.ts
import { ReplayBuffer } from './replay-buffer';

export type TapKey = string;
export interface TapDeps {
	emit: (channel: string, payload: unknown) => void;
	batchMs?: number;
	maxChars?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}
export const RESTART_MARKER = '\r\n\x1b[2m— restarted —\x1b[0m\r\n';

/** Desktop-side tap on every terminal's output. Each key (one tile or Kane, per workspace) keeps
 *  a ReplayBuffer so a browser that attaches later gets scrollback; while at least one browser
 *  is connected, chunks are batched per key for `batchMs` and emitted as ONE `tile:data` event,
 *  so a chatty floor does not turn into one IPC message per PTY read. Pure: timers injectable. */
export class RemoteTap {
	private buffers = new Map<TapKey, ReplayBuffer>();
	private pending = new Map<TapKey, string[]>();
	private timer: unknown = null;
	private clients = 0;
	private readonly batchMs: number;
	private readonly setTimer: (cb: () => void, ms: number) => unknown;
	private readonly clearTimer: (h: unknown) => void;

	constructor(private deps: TapDeps) {
		this.batchMs = deps.batchMs ?? 16;
		this.setTimer = deps.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
		this.clearTimer = deps.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	setClientCount(n: number): void { this.clients = n; }
	keys(): TapKey[] { return [...this.buffers.keys()]; }

	private buf(key: TapKey): ReplayBuffer {
		let b = this.buffers.get(key);
		if (!b) { b = new ReplayBuffer(this.deps.maxChars); this.buffers.set(key, b); }
		return b;
	}

	push(key: TapKey, chunk: string): void {
		if (!chunk) return;
		this.buf(key).push(chunk);
		if (this.clients <= 0) return;
		let q = this.pending.get(key);
		if (!q) { q = []; this.pending.set(key, q); }
		q.push(chunk);
		if (this.timer === null) this.timer = this.setTimer(() => this.flush(), this.batchMs);
	}

	private flush(): void {
		this.timer = null;
		const batch = this.pending; this.pending = new Map();
		for (const [key, chunks] of batch) this.deps.emit('tile:data', { key, chunk: chunks.join('') });
	}

	restart(key: TapKey): void {
		this.buf(key).clear();
		this.pending.delete(key);
		this.push(key, RESTART_MARKER);
	}

	snapshot(key: TapKey): string { return this.buffers.get(key)?.snapshot() ?? ''; }

	detach(key: TapKey): void {
		this.buffers.delete(key);
		this.pending.delete(key);
		this.deps.emit('tile:exit', { key });
	}
}
```

```ts
// src/terminals/spawn-options.ts
/** Toolbar dropdown options for new terminals — pure so the browser bundle can share them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const; // MUST match the array previously in god.ts — copy it verbatim from there and make god.ts re-export this one.
export const SPAWN_MODELS: { label: string; value: string }[] = [
	{ label: 'Model: Default', value: '' },
	{ label: 'Opus 4.8', value: 'claude-opus-4-8' },
	{ label: 'Sonnet 5', value: 'claude-sonnet-5' },
	{ label: 'Fable 5', value: 'claude-fable-5' },
	{ label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
];
export const SPAWN_EFFORTS: { label: string; value: string }[] = [
	{ label: 'Effort: Default', value: '' },
	...EFFORT_LEVELS.map((l) => ({ label: l === 'xhigh' ? 'XHigh' : l[0]!.toUpperCase() + l.slice(1), value: l })),
];
```

Check the real `EFFORT_LEVELS` in `src/terminals/god.ts` with `grep -n "EFFORT_LEVELS" src/terminals/god.ts` and copy its exact members; then replace that declaration in `god.ts` with `export { EFFORT_LEVELS } from './spawn-options';` (keep every other export). In `terminals-grid.ts` delete lines 59-72 and add `import { SPAWN_MODELS, SPAWN_EFFORTS } from './spawn-options';`. Run `npx tsc --noEmit -skipLibCheck` to confirm nothing else referenced them.

```ts
// src/terminals/floor-state.ts
/** What the browser renders from. Published by the desktop on every grid change (debounced) and
 *  on the phone's 2s timer. Pure types + a debounce helper; the builder lives in app.ts because it
 *  needs the live grid, workspaces and usage widget. */
export interface FloorTile { id: number; name: string; repo: string; branch: string; state: string; remoteOn: boolean; hidden: boolean; cols: number; rows: number; model: string | null; effort: string | null; locked: boolean; }
export interface FloorKane { name: string; state: string; cols: number; rows: number; visible: boolean; }
export interface FloorUsage { sessionPct: number | null; sessionReset: string | null; weekPct: number | null; weekReset: string | null; fablePct: number | null; }
export interface FloorState {
	workspaceId: string;
	centeredId: number | null;
	terminals: FloorTile[];
	kane: FloorKane | null;
	workspaces: Array<{ id: string; name: string; active: boolean }>;
	repos: string[];
	theme: string;
	usage: FloorUsage | null;
}

export function debounceFloor(
	publish: (s: FloorState) => void,
	build: () => FloorState,
	ms = 100,
	setTimer: (cb: () => void, ms: number) => unknown = (cb, m) => globalThis.setTimeout(cb, m),
	clearTimer: (h: unknown) => void = (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
): { request(): void; flush(): void } {
	let timer: unknown = null;
	const fire = (): void => { timer = null; publish(build()); };
	return {
		request() { if (timer === null) timer = setTimer(fire, ms); },
		flush() { if (timer !== null) { clearTimer(timer); timer = null; } publish(build()); },
	};
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/remote-tap.test.ts tests/floor-state.test.ts && npx tsc --noEmit -skipLibCheck`
Expected: tests PASS (6); tsc reports only errors in `electron/main.ts` (from Task 5's removal of `startRemoteServer`) — nothing in `src/`.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/remote-tap.ts src/terminals/floor-state.ts src/terminals/spawn-options.ts src/terminals/god.ts src/terminals/terminals-grid.ts tests/remote-tap.test.ts tests/floor-state.test.ts
git commit -m "feat(remote): output tap with replay buffers, floor-state types, shared spawn options"
```

---

### Task 10: Tile/Kane hooks, grid by-id API, app.ts wiring

This task has no new unit tests (it is DOM/Electron glue); its verification is `npx tsc --noEmit -skipLibCheck` (only `electron/main.ts` may still error) plus the manual smoke in Task 15.

**Files:**
- Modify: `src/terminals/terminal-tile.ts` (opts, `writeOut`, `restartInPlace`, new getters)
- Modify: `src/terminals/god-console.ts` (opts, output line, `restartInPlace`, new methods)
- Modify: `src/terminals/terminals-grid.ts` (deps, floor state, by-id methods, change hook)
- Modify: `src/app.ts` (tap, RPC dispatch, publish, `window.wcc` types)

**Interfaces:**
- `TerminalTileOpts` gains `onOutput?: (tile: TerminalTile, chunk: string) => void; onRestart?: (tile: TerminalTile) => void`.
- `TerminalTile` gains `get dims(): { cols: number; rows: number }`, `get model(): string | null`, `get effort(): string | null`.
- `GodConsoleOpts` gains `onOutput?: (chunk: string) => void; onRestart?: () => void`.
- `GodConsole` gains `get dims()`, `write(raw: string): void`, `get visible(): boolean` (backed by `this.el.style.display !== 'none'`).
- `GridDeps` gains `onTileOutput?: (id: number | 'kane', chunk: string) => void; onTileRestart?: (id: number | 'kane') => void; onTileGone?: (id: number) => void; onFloorChange?: () => void`.
- `TerminalsGrid` gains:
  ```ts
  fullFloorState(): { centeredId: number | null; terminals: FloorTile[]; kane: FloorKane | null }
  writeToId(id: number, data: string): boolean
  kaneWrite(data: string): boolean
  renameById(id: number, name: string): boolean
  hideById(id: number): boolean
  showById(id: number): boolean
  closeById(id: number): Promise<boolean>
  boardSummary(): { hidden: Array<{ id: number; name: string; branch: string; repo: string }>; registry: string }
  get lockedId(): number | null
  ```

- [ ] **Step 1: terminal-tile.ts**

In `TerminalTileOpts` (after `initialLastActivity?: number;` at line 46) add:
```ts
	/** Remote mirror taps (see remote-tap.ts): every output chunk, and each in-place restart. */
	onOutput?: (tile: TerminalTile, chunk: string) => void;
	onRestart?: (tile: TerminalTile) => void;
```
In `writeOut` (line 363) make the first statement `this.opts.onOutput?.(this, d);`.
In `restartInPlace` (line 636), right after `this.term?.reset();` add `this.opts.onRestart?.(this);`. Also find the `--continue` fallback branch in `startSession`'s `onExit` (line 607, `this.term?.reset();`) and add the same call after it.
After `get repoName()` (line 443) add:
```ts
	get dims(): { cols: number; rows: number } { return { cols: this.term?.cols ?? 80, rows: this.term?.rows ?? 24 }; }
	get model(): string | null { return this.opts.model ?? null; }
	get effort(): string | null { return this.opts.effort ?? null; }
```

- [ ] **Step 2: god-console.ts**

In `GodConsoleOpts` add `onOutput?: (chunk: string) => void; onRestart?: () => void;`.
Line 195: change `this.term?.write(d);` inside the `onData` callback to `this.opts.onOutput?.(d); this.term?.write(d);`. Line 202 (the "session ended" line): prefix with `this.opts.onOutput?.(...)` using the same string — simplest is to build the string into a `const end = ...` then call both.
In `restartInPlace` after `this.term?.reset();` add `this.opts.onRestart?.();` — and the same in its `--continue` fallback branch if one exists (search for the second `this.term?.reset()`).
Add public methods next to `focus()`:
```ts
	get dims(): { cols: number; rows: number } { return { cols: this.term?.cols ?? 80, rows: this.term?.rows ?? 24 }; }
	get visible(): boolean { return !!this.el && this.el.style.display !== 'none'; }
	/** Raw keystrokes from the browser mirror (no auto-Enter). */
	write(raw: string): void { this.bridge?.write(raw); }
```

- [ ] **Step 3: terminals-grid.ts**

Add to `GridDeps` (after `promptForTopic`):
```ts
	onTileOutput?: (id: number | 'kane', chunk: string) => void;
	onTileRestart?: (id: number | 'kane') => void;
	onTileGone?: (id: number) => void;
	onFloorChange?: () => void;
```
Add `import type { FloorTile, FloorKane } from './floor-state';`.

In `makeTile` (line 1212) add to the options object:
```ts
			onOutput: (t, chunk) => this.deps.onTileOutput?.(t.tileId, chunk),
			onRestart: (t) => this.deps.onTileRestart?.(t.tileId),
```
and inside the existing `onClosed` arrow, before `void this.persist()`, add `this.deps.onTileGone?.(t.tileId);`. Also add `this.deps.onFloorChange?.();` at the end of `onRename`'s body (`onRename: () => { void this.persist(); this.deps.onFloorChange?.(); },`).

In `toggleGod` (line 744) and `addKane` (line 774), add to the primary Kane's opts only: `onOutput: (chunk) => this.deps.onTileOutput?.('kane', chunk), onRestart: () => this.deps.onTileRestart?.('kane'),` (duplicates are not mirrored in v1).

At the end of `applyLayout()` (after line 1037) add `this.deps.onFloorChange?.();`. At the end of `showGod()` and `hideGod()` add the same call. In `handleReady` add the same call at its end.

Add the public methods (place after `sendToId`, line 719):
```ts
	/** Browser mirror: every session with the fields the browser needs to draw a tile. */
	fullFloorState(): { centeredId: number | null; terminals: FloorTile[]; kane: FloorKane | null } {
		const hiddenIds = new Set(this.hidden.map((t) => t.tileId));
		const terminals: FloorTile[] = (this.allSessions().filter((t) => !t.isJournal) as TerminalTile[]).map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch, state: this.tileState(t),
			remoteOn: t.isRemoteOn, hidden: hiddenIds.has(t.tileId), cols: t.dims.cols, rows: t.dims.rows,
			model: t.model, effort: t.effort, locked: this.lockedTileId === t.tileId,
		}));
		const k = this.godConsole;
		const ko = k?.recentOutput();
		const kane: FloorKane | null = !k || ko === undefined ? null
			: { name: KANE_NAME, state: looksLikePrompt(ko) ? 'prompt' : looksLikeMenu(ko) ? 'menu' : 'running', cols: k.dims.cols, rows: k.dims.rows, visible: this.godVisible };
		return { centeredId: this.centeredId, terminals, kane };
	}
	get lockedId(): number | null { return this.lockedTileId; }
	private terminalById(id: number): TerminalTile | null {
		const t = this.allSessions().find((x) => x.tileId === id);
		return t && !t.isJournal ? (t as TerminalTile) : null;
	}
	writeToId(id: number, data: string): boolean { const t = this.terminalById(id); if (!t) return false; t.sendKeys(data); return true; }
	kaneWrite(data: string): boolean { if (!this.godConsole) return false; this.godConsole.write(data); return true; }
	renameById(id: number, name: string): boolean { const t = this.terminalById(id); if (!t) return false; t.setName(name); return true; }
	hideById(id: number): boolean { const t = this.tiles.find((x) => x.tileId === id); if (!t) return false; this.hideTile(t); return true; }
	showById(id: number): boolean { if (!this.hidden.some((t) => t.tileId === id)) return false; this.showTile(id); return true; }
	/** × from the browser: same as the tile's own × — kill + delete worktree + branch, no confirm. */
	async closeById(id: number): Promise<boolean> {
		const t = this.terminalById(id);
		if (!t) return false;
		if (this.hidden.includes(t)) { this.hidden = this.hidden.filter((x) => x !== t); this.idleTiles.delete(id); if (this.lockedTileId === id) this.lockedTileId = null; }
		await t.close(); // fires onClosed for stage tiles; for hidden ones the filter above did the bookkeeping
		void this.persist(); this.board?.refresh(); this.deps.onFloorChange?.();
		return true;
	}
	boardSummary(): { hidden: Array<{ id: number; name: string; branch: string; repo: string }>; registry: string } {
		let registry = '';
		try { registry = fsSync.readFileSync(this.registryPath(), 'utf8'); } catch { /* not written yet */ }
		return { hidden: this.hidden.map((t) => ({ id: t.tileId, name: t.name, branch: t.branch, repo: t.repoName })), registry };
	}
```
`fsSync` is already imported at the top of the file. `looksLikePrompt`/`looksLikeMenu` are already imported.

- [ ] **Step 4: app.ts**

Extend the `window.wcc` declaration (lines 26-37) with:
```ts
			onRemoteInvoke(cb: (m: { id: string; channel: string; payload: unknown }) => void): void;
			remoteReply(r: { id: string; ok: boolean; value?: unknown; error?: string }): void;
			remoteEvent(channel: string, payload: unknown): void;
			onRemoteClients(cb: (n: number) => void): void;
			remotePasswordSet(pw: string): Promise<{ devicesSignedOut: number }>;
			remoteDevices(): Promise<Array<{ id: string; label: string; createdAt: number; lastSeen: number }>>;
			remoteDeviceRevoke(id: string): Promise<boolean>;
			remoteHasPassword(): Promise<boolean>;
```
and change `remoteInfo()`'s return type to `Promise<{ token: string; port: number; urls: string[]; httpsUrl: string | null; browserUrls: string[] }>`.

Add imports: `import { RemoteTap } from './terminals/remote-tap'; import { debounceFloor, type FloorState } from './terminals/floor-state';`.

After `const grids = new Map<string, TerminalsGrid>();` (line 111) add:
```ts
		// Browser mirror (spec 2026-09-07): one tap for every workspace; keys are `${wsId}:${tileId}`.
		const tap = new RemoteTap({ emit: (channel, payload) => window.wcc.remoteEvent(channel, payload) });
		window.wcc.onRemoteClients((n) => tap.setClientCount(n));
		const tapKey = (ws: string, id: number | 'kane'): string => `${ws}:${id}`;
```
In `depsFor(id)` add:
```ts
			onTileOutput: (tid, chunk) => tap.push(tapKey(id, tid), chunk),
			onTileRestart: (tid) => tap.restart(tapKey(id, tid)),
			onTileGone: (tid) => tap.detach(tapKey(id, tid)),
			onFloorChange: () => floorPublisher.request(),
```
`floorPublisher` is declared below with `let`, so hoist: declare `let floorPublisher: { request(): void; flush(): void } = { request() {}, flush() {} };` right above `depsFor`, and assign the real one after `usageWidget` and `switchTo` exist:
```ts
		const buildFloor = (): FloorState => ({
			workspaceId: activeId,
			...activeGrid.fullFloorState(),
			workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, active: w.id === activeId })),
			repos: activeGrid.repoNames(),
			theme: themeId,
			usage: usageWidget?.lastReadout() ?? null,
		});
		floorPublisher = debounceFloor((s) => window.wcc.remoteEvent('floor:state', s), buildFloor);
```
`UsageWidget` needs a one-line accessor: add `lastReadout(): FloorUsage | null { const r = this.last; return r ? { sessionPct: r.sessionPct, sessionReset: r.sessionReset, weekPct: r.weekPct, weekReset: r.weekReset, fablePct: r.fablePct } : null; }` to `src/ui/usage-widget.ts` (import the `FloorUsage` type). Also call `floorPublisher.request()` at the end of `switchTo` and inside the theme `change` handler, and in the existing 2 s interval (line 302) add `floorPublisher.flush();` after `pushFloorState(...)` so state-only changes (prompt/menu detection) reach the browser within 2 s.

Replace the RPC dispatch — add after `window.wcc.onRemoteAction(...)` (line 314):
```ts
		// Browser mirror: answer forwarded invokes (validated in main — see electron/remote/handlers.ts).
		window.wcc.onRemoteInvoke(({ id, channel, payload }) => {
			const p = payload as any;
			void (async (): Promise<unknown> => {
				switch (channel) {
					case 'floor:state': return buildFloor();
					case 'tile:snapshot': return tap.snapshot(tapKey(activeId, p.id));
					case 'kane:snapshot': return tap.snapshot(tapKey(activeId, 'kane'));
					case 'tile:write': return activeGrid.writeToId(p.id, p.data);
					case 'kane:write': return activeGrid.kaneWrite(p.data);
					case 'tile:center': activeGrid.centerById(p.id); return true;
					case 'tile:hide': return activeGrid.hideById(p.id);
					case 'tile:show': return activeGrid.showById(p.id);
					case 'tile:kill': return activeGrid.closeById(p.id);
					case 'tile:rename': return activeGrid.renameById(p.id, p.name);
					case 'tile:spawn': return (await activeGrid.spawnFromName(p.repo, p.base, p.task, p.model ?? undefined, p.effort ?? undefined, p.name ?? undefined)) !== null;
					case 'workspace:switch': await switchTo(p.id); return true;
					case 'board:get': return activeGrid.boardSummary();
					default: throw new Error('unknown channel');
				}
			})().then(
				(value) => window.wcc.remoteReply({ id, ok: true, value }),
				(err) => window.wcc.remoteReply({ id, ok: false, error: String((err as Error)?.message ?? err) }),
			);
		});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -skipLibCheck`
Expected: only `electron/main.ts` errors remain (missing `startRemoteServer`). Fix any `src/` error before moving on.

- [ ] **Step 6: Commit**

```bash
git add src/terminals/terminal-tile.ts src/terminals/god-console.ts src/terminals/terminals-grid.ts src/ui/usage-widget.ts src/app.ts
git commit -m "feat(remote): desktop taps tile output, answers browser rpc, publishes floor state"
```

---

### Task 11: Preload, main.ts wiring, desktop 📱 panel

No new unit tests (Electron glue). Verification: `npm run build` succeeds and the app starts with the gateway log line; the 📱 panel shows browser URLs and the password controls.

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `src/app.ts` (📱 panel, lines 316-360)
- Modify: `app.css` (a few panel rows)

- [ ] **Step 1: preload.ts**

Replace the `pushFloorState`/`onRemoteAction`/`remoteInfo` block with:
```ts
		// Phone floor view + browser mirror (electron/remote/*).
		pushFloorState: (s: unknown) => ipcRenderer.send('remote:state', s),
		onRemoteAction: (cb: (a: unknown) => void) => ipcRenderer.on('remote:action', (_e, a) => cb(a)),
		remoteInfo: () => ipcRenderer.invoke('remote:info'),
		onRemoteInvoke: (cb: (m: unknown) => void) => ipcRenderer.on('remote:invoke', (_e, m) => cb(m)),
		remoteReply: (r: unknown) => ipcRenderer.send('remote:reply', r),
		remoteEvent: (channel: string, payload: unknown) => ipcRenderer.send('remote:event', { channel, payload }),
		onRemoteClients: (cb: (n: number) => void) => ipcRenderer.on('remote:clients', (_e, n) => cb(n)),
		remotePasswordSet: (pw: string) => ipcRenderer.invoke('remote:password:set', pw),
		remoteHasPassword: () => ipcRenderer.invoke('remote:password:has'),
		remoteDevices: () => ipcRenderer.invoke('remote:devices'),
		remoteDeviceRevoke: (id: string) => ipcRenderer.invoke('remote:devices:revoke', id),
```

- [ ] **Step 2: main.ts**

Replace imports at lines 5-7 with:
```ts
import { createPhoneRoutes } from './remote-server';
import { remoteInfoPath, writeRemoteInfo, removeRemoteInfo } from './remote-info';
import { pickHosts, accessUrls, httpsUrlFor, hasServeHandlerFor, tailscaleIps, browserUrls } from './remote-net';
import { randomBytes } from 'crypto';
import { startGateway, type GatewayHandle } from './remote/gateway';
import { createAuth } from './remote/auth';
import { createRendererRpc } from './remote/renderer-rpc';
import { createRemoteHandlers } from './remote/handlers';
```
Add module-level state under `let win`:
```ts
let gateway: GatewayHandle | null = null;
let floorState: unknown = { workspaces: [], centeredId: null, kane: null, terminals: [], repos: [] };
const phoneToken = randomBytes(8).toString('hex');
```
Replace lines 101-108 (the `startRemoteServer` call and `remote:info` handler) with:
```ts
	// Browser mirror + phone floor view: one gateway, loopback + Tailscale only (spec 2026-09-07).
	const webDir = app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'dist', 'web') : path.join(__dirname, 'web');
	const auth = createAuth({ file: path.join(userData, 'remote-auth.json'), onDevicesRevoked: (ids) => gateway?.endDeviceSessions(ids) });
	const rpc = createRendererRpc({ send: (m) => { if (!win || win.isDestroyed()) throw new Error('no window'); win.webContents.send('remote:invoke', m); } });
	ipcMain.removeAllListeners('remote:state'); ipcMain.removeAllListeners('remote:reply'); ipcMain.removeAllListeners('remote:event');
	ipcMain.on('remote:state', (_e, s: unknown) => { floorState = s; });
	ipcMain.on('remote:reply', (_e, r: unknown) => rpc.handleReply(r));
	ipcMain.on('remote:event', (_e, m: { channel?: unknown; payload?: unknown }) => { if (typeof m?.channel === 'string') gateway?.broadcast(m.channel, m.payload); });
	win.webContents.on('did-start-loading', () => rpc.rejectAll());
	win.on('closed', () => rpc.rejectAll());
	const readConfig = (): unknown => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')); } catch { return {}; } };
	const tsIps = (): string[] => tailscaleIps(os.networkInterfaces());
	void startGateway({
		port: REMOTE_PORT,
		hosts: ['127.0.0.1', ...tsIps()],
		staticDir: webDir,
		table: createRemoteHandlers({ rpc, readConfig }),
		authenticate: (frame, ip) => auth.authenticate(frame, ip),
		phoneRoutes: createPhoneRoutes({ token: phoneToken, getFloor: () => floorState, onAction: (a) => win?.webContents.send('remote:action', a) }),
	}).then((gw) => {
		gateway = gw;
		gw.onClientCount((n) => win?.webContents.send('remote:clients', n));
		writeRemoteInfo(remoteInfoPath(), { url: `http://127.0.0.1:${gw.boundPort()}/phone`, token: phoneToken });
		// Tailscale often finishes starting after we do: re-check once a minute and bind late.
		const rebind = setInterval(() => { for (const ip of tsIps()) if (!gw.boundHosts().includes(ip)) void gw.addHost(ip); }, 60_000);
		rebind.unref();
	}).catch((err) => console.error('[remote] gateway failed to start:', err));

	ipcMain.handle('remote:info', async () => {
		const hosts = gateway?.boundHosts() ?? ['127.0.0.1'];
		return {
			token: phoneToken,
			port: REMOTE_PORT,
			urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname()).filter((h) => hosts.includes(h) || !/^\d/.test(h)), REMOTE_PORT, phoneToken),
			httpsUrl: httpsUrlFor(await tailscaleVoiceDnsName(REMOTE_PORT), phoneToken),
			browserUrls: browserUrls(hosts.filter((h) => h !== '127.0.0.1'), REMOTE_PORT),
			tailscaleUp: hosts.length > 1,
		};
	});
	ipcMain.handle('remote:password:set', (_e, pw: unknown) => auth.setPassword(String(pw ?? '')));
	ipcMain.handle('remote:password:has', () => auth.hasPassword());
	ipcMain.handle('remote:devices', () => auth.listDevices());
	ipcMain.handle('remote:devices:revoke', (_e, id: unknown) => auth.revokeDevice(String(id ?? '')));
```
Note the `webDir` for dev: esbuild (Task 12) writes the browser bundle to `dist/web/`, and `__dirname` is `dist/` in dev, so `path.join(__dirname, 'web')` is right. When packaged, `dist/web/**` is inside the asar (Task 15 adds it to `build.files`); reading static files from inside an asar via `fs` works in Electron's main process.

Also in `app.on('before-quit', ...)` add `void gateway?.close();`.

- [ ] **Step 3: 📱 panel in app.ts**

Inside the `phoneBtn` click handler, after the existing `urlsBox` block and before `close`, add:
```ts
			panel.createDiv({ cls: 'wcc-phone-h', text: '🖥 Browser (Tailscale)' });
			const browserBox = panel.createDiv();
			const pwRow = panel.createDiv({ cls: 'wcc-phone-row' });
			const pwInput = pwRow.createEl('input', { type: 'password', placeholder: 'New password (12+ chars)', cls: 'wcc-phone-pw' });
			const pwBtn = pwRow.createEl('button', { text: 'Set password' });
			const pwNote = panel.createDiv({ cls: 'wcc-phone-sub' });
			const devicesBox = panel.createDiv();
			const renderDevices = (): void => {
				devicesBox.empty();
				void window.wcc.remoteDevices().then((list) => {
					if (phonePanel !== panel) return;
					if (list.length === 0) { devicesBox.createDiv({ cls: 'wcc-phone-sub', text: 'No devices signed in.' }); return; }
					for (const d of list) {
						const row = devicesBox.createDiv({ cls: 'wcc-phone-row' });
						row.createSpan({ text: `${d.label || 'device'} · last seen ${new Date(d.lastSeen).toLocaleString()}` });
						const rv = row.createEl('button', { text: 'Revoke' });
						rv.addEventListener('click', () => void window.wcc.remoteDeviceRevoke(d.id).then(renderDevices));
					}
				});
			};
			pwBtn.addEventListener('click', () => {
				void window.wcc.remotePasswordSet(pwInput.value).then((r) => {
					pwInput.value = '';
					pwNote.setText(`Password set. ${r.devicesSignedOut} device(s) signed out.`);
					renderDevices();
				}).catch((e) => pwNote.setText(String((e as Error).message ?? e).replace(/^.*Error: /, '')));
			});
			void window.wcc.remoteHasPassword().then((has) => { if (phonePanel === panel && !has) pwNote.setText('No password yet — set one to enable browser login.'); });
			renderDevices();
```
and inside the existing `remoteInfo().then((info) => {...})` add:
```ts
				browserBox.empty();
				if (!info.tailscaleUp) browserBox.createDiv({ cls: 'wcc-phone-sub', text: 'Tailscale IP not found — browser access is local-only right now.' });
				for (const u of info.browserUrls) browserBox.createEl('div', { cls: 'wcc-phone-url', text: u });
```
Update the `remoteInfo()` type in the `window.wcc` declaration to include `tailscaleUp: boolean`.

Add to `app.css` after `.wcc-phone-close`:
```css
.wcc-phone-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; color: var(--text-muted); }
.wcc-phone-row button { background: var(--background-secondary-alt); color: var(--text-normal); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
.wcc-phone-pw { flex: 1 1 auto; background: var(--background-primary); color: var(--text-normal); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
```

- [ ] **Step 4: Build and typecheck**

Run: `npx tsc --noEmit -skipLibCheck && node esbuild.config.mjs`
Expected: clean typecheck; esbuild builds main, preload, renderer (the web bundle arrives in Task 12).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every test file passes, including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add electron/preload.ts electron/main.ts src/app.ts app.css
git commit -m "feat(remote): start the gateway from main; password + device panel on the desktop"
```

---

### Task 12: Browser bridge + web build

**Files:**
- Create: `src/web/bridge.ts`, `web/index.html`, `src/web/main.ts` (placeholder that only connects; replaced in Task 14)
- Modify: `esbuild.config.mjs`
- Test: `tests/web-bridge.test.ts`

**Interfaces:**
- Produces in `bridge.ts`:
  ```ts
  export type BridgeStatus = 'connecting' | 'login' | 'open' | 'offline';
  export interface AuthOutcome { ok: boolean; error?: string }
  export interface SocketLike { readyState: number; send(d: string): void; close(): void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null }
  export interface BridgeDeps { url: string; createSocket?: (url: string) => SocketLike; storage?: { get(): string | null; set(t: string, remember: boolean): void; clear(): void }; setTimer?; clearTimer?; setInterval?; clearInterval?; document?: { visibilityState: string; addEventListener(t: string, cb: () => void): void } }
  export interface Bridge {
    invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
    on(channel: string, cb: (payload: unknown) => void): () => void;
    status(): BridgeStatus;
    onStatus(cb: (s: BridgeStatus) => void): () => void;
    submitPassword(password: string, remember: boolean, deviceLabel: string): Promise<AuthOutcome>;
    logout(): void;   // clears the stored token, closes, reconnects into 'login'
  }
  export function createBridge(deps: BridgeDeps): Bridge
  export const TOKEN_KEY = 'wcc.deviceToken';
  export function defaultStorage(): BridgeDeps['storage']   // localStorage (remember) or sessionStorage; exactly one holds the token
  ```
- Constants: ping `20 s`, missed pongs `3`, backoff `1 s → 60 s` doubling, reset only on auth success, invoke timeout `30 s`, offline queue cap `100`, auth timeout `30 s`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { createBridge, type SocketLike } from '../src/web/bridge';

class FakeSocket implements SocketLike {
	static OPEN = 1;
	readyState = 0;
	sent: any[] = [];
	onopen: (() => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
	send(d: string): void { this.sent.push(JSON.parse(d)); }
	close(): void { this.readyState = 3; this.onclose?.(); }
	open(): void { this.readyState = 1; this.onopen?.(); }
	receive(f: unknown): void { this.onmessage?.({ data: JSON.stringify(f) }); }
}

function harness(token: string | null = null) {
	const sockets: FakeSocket[] = [];
	let stored: string | null = token; let remembered: boolean | null = null;
	const timers: Array<{ cb: () => void; ms: number }> = [];
	const intervals: Array<{ cb: () => void; ms: number }> = [];
	const bridge = createBridge({
		url: 'ws://x/ws',
		createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
		storage: { get: () => stored, set: (t, r) => { stored = t; remembered = r; }, clear: () => { stored = null; } },
		setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
		clearTimer: (h) => { const i = (h as number) - 1; if (timers[i]) timers[i] = { cb: () => {}, ms: -1 }; },
		setInterval: (cb, ms) => { intervals.push({ cb, ms }); return intervals.length; },
		clearInterval: () => {},
	});
	const fireTimers = (): void => { const t = timers.splice(0); for (const x of t) x.cb(); };
	return { bridge, sockets, timers, intervals, fireTimers, get stored() { return stored; }, get remembered() { return remembered; } };
}

describe('createBridge', () => {
	it('with no token: opens the socket and lands in login', () => {
		const h = harness();
		const s = h.sockets[0]!;
		expect(h.bridge.status()).toBe('connecting');
		s.open();
		expect(h.bridge.status()).toBe('login');
		expect(s.sent).toEqual([]);
	});
	it('with a stored token: sends auth, becomes open on ok, flushes queued invokes', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		const p = h.bridge.invoke('floor:state');
		s.open();
		expect(s.sent).toEqual([{ t: 'auth', deviceToken: 'tok' }]);
		s.receive({ t: 'auth', ok: true, deviceId: 'd' });
		expect(h.bridge.status()).toBe('open');
		expect(s.sent[1]).toMatchObject({ t: 'invoke', channel: 'floor:state' });
		s.receive({ t: 'reply', id: s.sent[1].id, ok: true, value: { x: 1 } });
		await expect(p).resolves.toEqual({ x: 1 });
	});
	it('a rejected token is cleared and the bridge falls to login', () => {
		const h = harness('dead');
		const s = h.sockets[0]!;
		s.open();
		s.receive({ t: 'auth', ok: false, error: 'unknown device token' });
		expect(h.stored).toBeNull();
		expect(h.bridge.status()).toBe('login');
	});
	it('submitPassword stores the returned token (remember flag honoured) and opens', async () => {
		const h = harness();
		const s = h.sockets[0]!;
		s.open();
		const p = h.bridge.submitPassword('pw', true, 'Laptop');
		expect(s.sent).toEqual([{ t: 'auth', password: 'pw', deviceLabel: 'Laptop' }]);
		s.receive({ t: 'auth', ok: true, deviceToken: 'new', deviceId: 'd' });
		await expect(p).resolves.toEqual({ ok: true });
		expect(h.stored).toBe('new'); expect(h.remembered).toBe(true);
		expect(h.bridge.status()).toBe('open');
	});
	it('a wrong password resolves ok:false with the server error and stays in login', async () => {
		const h = harness();
		const s = h.sockets[0]!;
		s.open();
		const p = h.bridge.submitPassword('bad', false, 'L');
		s.receive({ t: 'auth', ok: false, error: 'invalid password' });
		await expect(p).resolves.toEqual({ ok: false, error: 'invalid password' });
		expect(h.bridge.status()).toBe('login');
	});
	it('events reach listeners; unsubscribe works', () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const got: unknown[] = [];
		const off = h.bridge.on('tile:data', (p) => got.push(p));
		s.receive({ t: 'event', channel: 'tile:data', payload: { key: 'w:1', chunk: 'x' } });
		off();
		s.receive({ t: 'event', channel: 'tile:data', payload: { key: 'w:1', chunk: 'y' } });
		expect(got).toEqual([{ key: 'w:1', chunk: 'x' }]);
	});
	it('in-flight invokes are rejected (not replayed) on drop; the reconnect is scheduled with backoff', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const p = h.bridge.invoke('tile:kill', { id: 1 });
		s.close();
		await expect(p).rejects.toThrow();
		expect(h.bridge.status()).toBe('offline');
		const delays = h.timers.filter((t) => t.ms > 0).map((t) => t.ms);
		expect(delays).toContain(1000);
		h.fireTimers();
		expect(h.sockets).toHaveLength(2);
		h.sockets[1]!.close(); // fails again: 2s next
		expect(h.timers.filter((t) => t.ms > 0).map((t) => t.ms)).toContain(2000);
	});
	it('an "unauthenticated" reply flips to login', async () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const p = h.bridge.invoke('x');
		s.receive({ t: 'reply', id: s.sent[1].id, ok: false, error: 'unauthenticated' });
		await expect(p).rejects.toThrow('unauthenticated');
		expect(h.bridge.status()).toBe('login');
	});
	it('pings on the interval and declares the socket dead after 3 missed pongs', () => {
		const h = harness('tok');
		const s = h.sockets[0]!;
		s.open(); s.receive({ t: 'auth', ok: true });
		const ping = h.intervals[0]!;
		expect(ping.ms).toBe(20_000);
		ping.cb(); ping.cb();
		expect(s.sent.filter((f) => f.t === 'ping')).toHaveLength(2);
		s.receive({ t: 'pong' });
		ping.cb(); ping.cb(); ping.cb();
		expect(h.bridge.status()).toBe('offline');
	});
	it('queue is bounded at 100 while offline', async () => {
		const h = harness();
		for (let i = 0; i < 100; i++) void h.bridge.invoke('x').catch(() => {});
		await expect(h.bridge.invoke('x')).rejects.toThrow(/too many/);
	});
	it('logout clears the token and returns to login on the next socket', () => {
		const h = harness('tok');
		h.sockets[0]!.open(); h.sockets[0]!.receive({ t: 'auth', ok: true });
		h.bridge.logout();
		expect(h.stored).toBeNull();
		h.fireTimers();
		h.sockets[1]!.open();
		expect(h.bridge.status()).toBe('login');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement bridge.ts**

```ts
// src/web/bridge.ts
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
	const authWaiters: Array<{ id: string; resolve: (o: AuthOutcome) => void }> = [];

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
				authWaiters.push({ id, remember, resolve: (o) => { clearTimer(timer); resolve(o); } } as { id: string; remember: boolean; resolve: (o: AuthOutcome) => void });
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
```
The `authWaiters` element type needs `remember: boolean` — declare the array as `Array<{ id: string; remember: boolean; resolve: (o: AuthOutcome) => void }>` and drop the cast.

- [ ] **Step 4: web/index.html and a placeholder src/web/main.ts**

```html
<!-- web/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Worktree Command Center</title>
	<link rel="stylesheet" href="/xterm.css" />
	<link rel="stylesheet" href="/styles.css" />
	<link rel="stylesheet" href="/app.css" />
	<link rel="stylesheet" href="/web.css" />
</head>
<body>
	<div id="app"></div>
	<script src="/app.js"></script>
</body>
</html>
```

```ts
// src/web/main.ts  (placeholder — Task 14 replaces it)
import { createBridge } from './bridge';
const bridge = createBridge({ url: location.origin.replace(/^http/, 'ws') + '/ws' });
bridge.onStatus((s) => { document.getElementById('app')!.textContent = `bridge: ${s}`; });
```

- [ ] **Step 5: esbuild.config.mjs**

Append before the final `console.log`:
```js
// Browser mirror bundle (spec 2026-09-07): a plain-browser build of src/web. platform 'browser'
// makes any accidental Node import (fs, path, child_process, electron) a hard build error.
mkdirSync('dist/web', { recursive: true });
await esbuild.build({ ...common, entryPoints: ['src/web/main.ts'], outfile: 'dist/web/app.js', platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
copyFileSync('web/index.html', 'dist/web/index.html');
copyFileSync('web/web.css', 'dist/web/web.css');
copyFileSync('app.css', 'dist/web/app.css');
copyFileSync('styles.css', 'dist/web/styles.css');
copyFileSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/web/xterm.css');
```
and change the final log to `'esbuild: built main, preload, renderer, web'`. Create an empty `web/web.css` now (Task 14 fills it).

- [ ] **Step 6: Run test + build**

Run: `npx vitest run tests/web-bridge.test.ts && node esbuild.config.mjs && ls dist/web`
Expected: 11 tests pass; `dist/web` holds `app.js`, `index.html`, `web.css`, `app.css`, `styles.css`, `xterm.css`.

- [ ] **Step 7: Commit**

```bash
git add src/web/bridge.ts src/web/main.ts web/index.html web/web.css esbuild.config.mjs tests/web-bridge.test.ts
git commit -m "feat(web): browser bridge with reconnect/auth; web bundle build"
```

---

### Task 13: Login screen

**Files:**
- Create: `src/web/login.ts`
- Test: `tests/web-login.test.ts` (pure helpers only)

**Interfaces:**
- Produces:
  ```ts
  export function describeAuthFailure(error: string | undefined): string   // allow-listed copy
  export function guessDeviceLabel(ua: string): string
  export function mountLogin(root: HTMLElement, bridge: Bridge, onDone: () => void): () => void  // returns unmount
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-login.test.ts
import { describe, it, expect } from 'vitest';
import { describeAuthFailure, guessDeviceLabel } from '../src/web/login';

describe('describeAuthFailure', () => {
	it('maps known server errors to friendly copy and everything else to a generic line', () => {
		expect(describeAuthFailure('invalid password')).toBe('Wrong password.');
		expect(describeAuthFailure('too many attempts -- try again later')).toBe('Too many attempts. Wait 15 minutes and try again.');
		expect(describeAuthFailure('no password set')).toBe('No password is set yet. Set one in the desktop app (📱 panel).');
		expect(describeAuthFailure('device revoked')).toBe('This device was signed out from the desktop.');
		expect(describeAuthFailure('not connected')).toBe('Not connected to the desktop. Retrying…');
		expect(describeAuthFailure('C:\\secret\\path')).toBe('Login failed.');
		expect(describeAuthFailure(undefined)).toBe('Login failed.');
	});
});
describe('guessDeviceLabel', () => {
	it('names the OS + browser roughly', () => {
		expect(guessDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('Windows · Chrome');
		expect(guessDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15')).toBe('Mac · Safari');
		expect(guessDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
		expect(guessDeviceLabel('')).toBe('Browser');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-login.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/login.ts
import type { Bridge } from './bridge';

/** Allow-list: the server's error strings are fixed literals, but nothing else is ever echoed. */
export function describeAuthFailure(error: string | undefined): string {
	switch (error) {
		case 'invalid password': return 'Wrong password.';
		case 'too many attempts -- try again later': return 'Too many attempts. Wait 15 minutes and try again.';
		case 'no password set': return 'No password is set yet. Set one in the desktop app (📱 panel).';
		case 'device revoked': return 'This device was signed out from the desktop.';
		case 'not connected': return 'Not connected to the desktop. Retrying…';
		default: return 'Login failed.';
	}
}

export function guessDeviceLabel(ua: string): string {
	if (!ua) return 'Browser';
	const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
	const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
	return `${os} · ${br}`;
}

/** Password form. Resolves the page into the floor via onDone once the bridge reports 'open'. */
export function mountLogin(root: HTMLElement, bridge: Bridge, onDone: () => void): () => void {
	root.empty();
	const box = root.createDiv({ cls: 'web-login' });
	box.createDiv({ cls: 'web-login-h', text: '🌳 Worktree Command Center' });
	const sub = box.createDiv({ cls: 'web-login-sub', text: bridge.status() === 'login' ? 'Enter the password from the desktop app.' : 'Connecting to the desktop…' });
	const form = box.createEl('form', { cls: 'web-login-form' });
	const pw = form.createEl('input', { type: 'password', placeholder: 'Password', cls: 'web-login-pw', attr: { autocomplete: 'current-password', autofocus: 'true' } });
	const rememberRow = form.createDiv({ cls: 'web-login-row' });
	const remember = rememberRow.createEl('input', { type: 'checkbox', attr: { id: 'remember' } });
	remember.checked = true;
	rememberRow.createEl('label', { text: 'Remember this device for 30 days', attr: { for: 'remember' } });
	const btn = form.createEl('button', { text: 'Sign in', cls: 'web-login-btn', attr: { type: 'submit' } });
	const err = box.createDiv({ cls: 'web-login-err' });

	let busy = false;
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		if (busy) return;
		busy = true; btn.disabled = true; err.setText('');
		void bridge.submitPassword(pw.value, remember.checked, guessDeviceLabel(navigator.userAgent)).then((o) => {
			busy = false; btn.disabled = false;
			if (!o.ok) { err.setText(describeAuthFailure(o.error)); pw.select(); }
		});
	});
	const offStatus = bridge.onStatus((s) => {
		if (s === 'open') { onDone(); return; }
		sub.setText(s === 'login' ? 'Enter the password from the desktop app.' : s === 'offline' ? 'Desktop unreachable. Retrying…' : 'Connecting to the desktop…');
		btn.disabled = s !== 'login';
	});
	btn.disabled = bridge.status() !== 'login';
	pw.focus();
	return () => { offStatus(); box.remove(); };
}
```
`root.empty()`/`createDiv` come from the dom shim (`src/ui/dom-shim.ts`), which Task 14's `main.ts` installs first. The test imports only the two pure helpers; the module has no top-level DOM access.

- [ ] **Step 4: Run test**

Run: `npx vitest run tests/web-login.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/login.ts tests/web-login.test.ts
git commit -m "feat(web): login screen with remember-device"
```

---

### Task 14: Browser tiles and floor

Verification is the build (`node esbuild.config.mjs`) plus one pure test for the tile-set diff helper; the rest is DOM and is smoke-tested in Task 15.

**Files:**
- Create: `src/web/tile.ts`, `src/web/floor.ts`, `src/web/diff.ts`
- Replace: `src/web/main.ts`
- Modify: `web/web.css`
- Test: `tests/web-diff.test.ts`

**Interfaces:**
- `diff.ts`: `export function diffIds(prev: number[], next: number[]): { added: number[]; removed: number[] }`
- `tile.ts`:
  ```ts
  export interface WebTileDeps { key: string; snapshot: () => Promise<string>; write: (data: string) => void; onData: (cb: (chunk: string) => void) => () => void; onClick: () => void }
  export class WebTile {
    constructor(deps: WebTileDeps);
    render(parent: HTMLElement, head: { name: string; repo: string; branch: string }): void;
    setRect(r: { x: number; y: number; w: number; h: number }): void;
    setCentered(on: boolean): void;
    setSize(cols: number, rows: number): void;      // follows the desktop; never resizes the PTY
    setHead(name: string, state: string, locked: boolean): void;
    setBadge(text: string | null): void;
    setPalette(p: Record<string, string>): void;
    attach(): Promise<void>;                          // snapshot, THEN subscribe
    resume(): Promise<void>;                          // term.reset() + fresh snapshot (reconnect)
    focus(): void; blur(): void;
    dispose(): void;
  }
  ```
- `floor.ts`: `export function mountFloor(root: HTMLElement, bridge: Bridge): () => void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-diff.test.ts
import { describe, it, expect } from 'vitest';
import { diffIds } from '../src/web/diff';

describe('diffIds', () => {
	it('reports added and removed ids, order-stable', () => {
		expect(diffIds([1, 2, 3], [2, 3, 4])).toEqual({ added: [4], removed: [1] });
		expect(diffIds([], [])).toEqual({ added: [], removed: [] });
		expect(diffIds([5], [5])).toEqual({ added: [], removed: [] });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: diff.ts**

```ts
// src/web/diff.ts
export function diffIds(prev: number[], next: number[]): { added: number[]; removed: number[] } {
	const p = new Set(prev), n = new Set(next);
	return { added: next.filter((id) => !p.has(id)), removed: prev.filter((id) => !n.has(id)) };
}
```

- [ ] **Step 4: tile.ts**

```ts
// src/web/tile.ts
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { scrollIntentForKey } from '../terminals/scroll-keys';

export interface WebTileDeps {
	key: string;
	snapshot: () => Promise<string>;
	write: (data: string) => void;
	onData: (cb: (chunk: string) => void) => () => void;
	onClick: () => void;
}

/** One mirrored terminal. The xterm is sized to the DESKTOP's PTY (setSize); the tile box scales
 *  around it — the browser never resizes the PTY, so the two screens cannot fight. */
export class WebTile {
	private el: HTMLElement | null = null;
	private nameEl: HTMLElement | null = null;
	private stateEl: HTMLElement | null = null;
	private badgeEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private off: (() => void) | null = null;
	private centered = false;

	constructor(private deps: WebTileDeps) {}

	render(parent: HTMLElement, head: { name: string; repo: string; branch: string }): void {
		this.el = parent.createDiv({ cls: 'cos-term-tile web-tile' });
		const h = this.el.createDiv({ cls: 'cos-term-head' });
		this.badgeEl = h.createSpan({ cls: 'cos-term-badge' });
		this.nameEl = h.createSpan({ cls: 'cos-term-name', text: head.name });
		h.createSpan({ cls: 'web-tile-repo', text: `${head.repo} · ${head.branch}` });
		this.stateEl = h.createSpan({ cls: 'web-tile-state' });
		this.el.addEventListener('click', () => this.deps.onClick());
		const body = this.el.createDiv({ cls: 'cos-term-body' });
		body.addEventListener('mousedown', (e) => { if (!this.centered) { e.preventDefault(); e.stopImmediatePropagation(); this.deps.onClick(); } }, true);
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: false, scrollback: 5000, linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); } } });
		this.term.open(body);
		try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); this.term.loadAddon(gl); } catch { /* DOM renderer */ }
		this.term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener'); }));
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && this.term?.hasSelection()) { void navigator.clipboard?.writeText(this.term.getSelection()); return false; }
			if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) { void navigator.clipboard?.readText().then((t) => { if (t) this.deps.write(t); }); return false; }
			const intent = scrollIntentForKey(e);
			if (intent) { if (intent.kind === 'lines') this.term?.scrollLines(intent.amount); else if (intent.kind === 'pages') this.term?.scrollPages(intent.amount); else if (intent.kind === 'top') this.term?.scrollToTop(); else this.term?.scrollToBottom(); return false; }
			return true;
		});
		this.term.onData((d) => this.deps.write(d)); // everything forwarded, like the desktop (focus/DSR replies included)
	}

	setRect(r: { x: number; y: number; w: number; h: number }): void {
		if (!this.el) return;
		this.el.style.left = `${r.x}px`; this.el.style.top = `${r.y}px`; this.el.style.width = `${r.w}px`; this.el.style.height = `${r.h}px`;
	}
	setCentered(on: boolean): void { this.centered = on; this.el?.toggleClass('centered', on); }
	setSize(cols: number, rows: number): void { if (this.term && (this.term.cols !== cols || this.term.rows !== rows)) this.term.resize(cols, rows); }
	setHead(name: string, state: string, locked: boolean): void { this.nameEl?.setText(name); this.stateEl?.setText(state); this.el?.toggleClass('cos-term-lockon', locked); this.el?.setAttr('data-state', state); }
	setBadge(text: string | null): void { if (!this.badgeEl) return; this.badgeEl.setText(text ?? ''); this.badgeEl.style.display = text ? 'inline-block' : 'none'; }
	setPalette(p: Record<string, string>): void { if (this.term) this.term.options.theme = p; }

	/** Snapshot FIRST, then subscribe — nothing missed, nothing doubled. */
	async attach(): Promise<void> {
		const snap = await this.deps.snapshot();
		this.term?.write(snap);
		this.off?.();
		this.off = this.deps.onData((chunk) => this.term?.write(chunk));
	}
	/** Reconnect: replace the whole buffer with a fresh snapshot (the stream may have gaps). */
	async resume(): Promise<void> {
		const snap = await this.deps.snapshot();
		this.term?.reset();
		this.term?.write(snap);
	}
	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }
	dispose(): void { this.off?.(); this.off = null; this.term?.dispose(); this.term = null; this.el?.remove(); this.el = null; }
}
```
Check `scrollIntentForKey`'s real signature in `src/terminals/scroll-keys.ts` and adapt the call (it is pure — no Node imports). If it needs extra arguments (e.g. a "TUI owns mouse" flag), pass `false`.

- [ ] **Step 5: floor.ts**

```ts
// src/web/floor.ts
import type { Bridge } from './bridge';
import { WebTile } from './tile';
import { diffIds } from './diff';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, nextSpotlight } from '../terminals/bubble-layout';
import { SPAWN_MODELS, SPAWN_EFFORTS } from '../terminals/spawn-options';
import { normalizeTheme, setActiveTheme, activeTerminalPalette } from '../terminals/theme-store';
import type { FloorState } from '../terminals/floor-state';
import { toast } from '../ui/toast';

const GAP = 8;

/** The mirrored floor: renders from `floor:state`, sends every action to the desktop. One source
 *  of truth — the desktop's centeredId is the browser's centeredId. */
export function mountFloor(root: HTMLElement, bridge: Bridge): () => void {
	root.empty();
	let state: FloorState | null = null;
	const tiles = new Map<number, WebTile>();
	let kane: WebTile | null = null;
	let kaneOpen = false;
	let altDown = false;

	// --- chrome ---
	const top = root.createDiv({ cls: 'wcc-topbar' });
	top.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center · browser' });
	const status = top.createSpan({ cls: 'wcc-status', text: '' });
	const usage = top.createSpan({ cls: 'wcc-usage-session web-usage', text: '' });
	const logout = top.createEl('button', { text: 'Sign out' });
	logout.addEventListener('click', () => bridge.logout());
	const tabs = root.createDiv({ cls: 'wcc-tabs' });
	const container = root.createDiv({ cls: 'wcc-grid-container' });
	const controls = container.createDiv({ cls: 'cos-terminals-controls' });
	const repoSel = controls.createEl('select');
	const modelSel = controls.createEl('select'); for (const m of SPAWN_MODELS) modelSel.createEl('option', { text: m.label, value: m.value });
	modelSel.value = SPAWN_MODELS.find((m) => m.label.startsWith('Opus'))?.value ?? '';
	const effortSel = controls.createEl('select'); for (const e of SPAWN_EFFORTS) effortSel.createEl('option', { text: e.label, value: e.value });
	const task = controls.createEl('input', { type: 'text', placeholder: 'Task for the new terminal', cls: 'web-task' });
	const play = controls.createEl('button', { text: '▶ Play', cls: 'cos-play-btn' });
	play.addEventListener('click', () => {
		if (!repoSel.value || !task.value.trim()) { toast('Pick a repo and type a task'); return; }
		void bridge.invoke('tile:spawn', { repo: repoSel.value, task: task.value.trim(), model: modelSel.value || null, effort: effortSel.value || null }).then((ok) => { if (ok) task.value = ''; else toast('Spawn failed'); }, () => toast('Spawn failed'));
	});
	const kaneBtn = controls.createEl('button', { text: '🜲 Kane', cls: 'cos-god-btn' });
	kaneBtn.addEventListener('click', () => toggleKane());
	const boardBtn = controls.createEl('button', { text: '📋 Coordination' });
	const board = container.createDiv({ cls: 'web-board' }); board.style.display = 'none';
	boardBtn.addEventListener('click', () => { board.style.display = board.style.display === 'none' ? '' : 'none'; if (board.style.display !== 'none') void refreshBoard(); });
	const wrap = container.createDiv({ cls: 'cos-stage-wrap' });
	const stage = wrap.createDiv({ cls: 'cos-terminals-stage' });
	const dock = wrap.createDiv({ cls: 'cos-god-panel web-kane' }); dock.style.display = 'none';

	// --- helpers ---
	const key = (id: number | 'kane'): string => `${state?.workspaceId ?? ''}:${id}`;
	const tileDeps = (id: number | 'kane') => ({
		key: key(id),
		snapshot: () => bridge.invoke<string>(id === 'kane' ? 'kane:snapshot' : 'tile:snapshot', id === 'kane' ? undefined : { id }),
		write: (data: string) => { void bridge.invoke(id === 'kane' ? 'kane:write' : 'tile:write', id === 'kane' ? { data } : { id, data }).catch(() => {}); },
		onData: (cb: (chunk: string) => void) => bridge.on('tile:data', (p) => { const m = p as { key: string; chunk: string }; if (m.key === key(id)) cb(m.chunk); }),
		onClick: () => { if (id !== 'kane') void bridge.invoke('tile:center', { id }); },
	});

	async function refreshBoard(): Promise<void> {
		const b = await bridge.invoke<{ hidden: Array<{ id: number; name: string; branch: string; repo: string }>; registry: string }>('board:get').catch(() => null);
		board.empty();
		if (!b) { board.createDiv({ text: 'Board unavailable' }); return; }
		board.createDiv({ cls: 'web-board-h', text: `Hidden sessions (${b.hidden.length})` });
		for (const h of b.hidden) {
			const row = board.createDiv({ cls: 'web-board-row' });
			row.createSpan({ text: `${h.name} · ${h.repo} · ${h.branch}` });
			const show = row.createEl('button', { text: 'Show' }); show.addEventListener('click', () => void bridge.invoke('tile:show', { id: h.id }).then(refreshBoard));
			const kill = row.createEl('button', { text: '×' }); kill.addEventListener('click', () => { if (confirm(`Close "${h.name}"? Deletes its worktree + branch.`)) void bridge.invoke('tile:kill', { id: h.id }).then(refreshBoard); });
		}
		board.createEl('pre', { cls: 'web-board-reg', text: b.registry });
	}

	function toggleKane(): void {
		kaneOpen = !kaneOpen;
		dock.style.display = kaneOpen ? '' : 'none';
		kaneBtn.toggleClass('cos-god-on', kaneOpen);
		if (kaneOpen && !kane && state?.kane) {
			kane = new WebTile(tileDeps('kane'));
			kane.render(dock, { name: state.kane.name, repo: 'overseer', branch: '' });
			kane.setSize(state.kane.cols, state.kane.rows);
			kane.setPalette(activeTerminalPalette());
			void kane.attach();
		}
		if (kaneOpen) kane?.focus();
		layout();
	}

	function layout(): void {
		if (!state) return;
		const W = stage.clientWidth || 800, H = stage.clientHeight || 500;
		const visible = state.terminals.filter((t) => !t.hidden).map((t) => t.id);
		const center = state.centeredId !== null && visible.includes(state.centeredId) ? state.centeredId : null;
		const rects = center !== null ? centeredLayout(visible, W, H, GAP, center) : settledLayout(visible, W, H, GAP);
		for (const [id, tile] of tiles) {
			const r = rects.find((x) => x.id === id);
			if (r) tile.setRect(r);
			tile.setCentered(id === center);
		}
		if (altDown) visible.forEach((id, i) => tiles.get(id)?.setBadge(keyForIndex(i)));
	}

	function applyState(next: FloorState): void {
		const prevWs = state?.workspaceId;
		state = next;
		if (prevWs !== undefined && prevWs !== next.workspaceId) { for (const t of tiles.values()) t.dispose(); tiles.clear(); kane?.dispose(); kane = null; }
		// theme
		const themeId = normalizeTheme(next.theme);
		if (document.documentElement.dataset.theme !== themeId) { document.documentElement.dataset.theme = themeId; setActiveTheme(themeId); const p = activeTerminalPalette(); for (const t of tiles.values()) t.setPalette(p); kane?.setPalette(p); }
		// tabs
		tabs.empty();
		for (const w of next.workspaces) { const tab = tabs.createDiv({ cls: 'wcc-tab' }); tab.toggleClass('active', w.active); tab.createSpan({ cls: 'wcc-tab-name', text: w.name }); tab.addEventListener('click', () => void bridge.invoke('workspace:switch', { id: w.id })); }
		// repos
		const cur = repoSel.value; repoSel.empty(); for (const r of next.repos) repoSel.createEl('option', { text: r, value: r }); if (next.repos.includes(cur)) repoSel.value = cur;
		// usage
		usage.setText(next.usage && next.usage.sessionPct !== null ? `session ${next.usage.sessionPct}% · week ${next.usage.weekPct ?? '?'}%` : '');
		status.setText(`${next.terminals.length} sessions`);
		// tiles
		const wanted = next.terminals.filter((t) => !t.hidden).map((t) => t.id);
		const { added, removed } = diffIds([...tiles.keys()], wanted);
		for (const id of removed) { tiles.get(id)?.dispose(); tiles.delete(id); }
		for (const id of added) {
			const info = next.terminals.find((t) => t.id === id)!;
			const tile = new WebTile(tileDeps(id));
			tile.render(stage, { name: info.name, repo: info.repo, branch: info.branch });
			tile.setPalette(activeTerminalPalette());
			tiles.set(id, tile);
			void tile.attach();
		}
		for (const info of next.terminals) { const t = tiles.get(info.id); if (!t) continue; t.setSize(info.cols, info.rows); t.setHead(info.name, info.state, info.locked); }
		if (next.kane && kane) kane.setSize(next.kane.cols, next.kane.rows);
		kaneBtn.disabled = !next.kane;
		layout();
		const c = state.centeredId; if (c !== null) tiles.get(c)?.focus();
	}

	// --- wiring ---
	const offState = bridge.on('floor:state', (p) => applyState(p as FloorState));
	const offExit = bridge.on('tile:exit', (p) => { const k = (p as { key: string }).key; for (const [id, t] of tiles) if (key(id) === k) { t.dispose(); tiles.delete(id); } layout(); });
	const offStatus = bridge.onStatus((s) => {
		if (s !== 'open') return;
		void bridge.invoke<FloorState>('floor:state').then((st) => { applyState(st); for (const t of tiles.values()) void t.resume(); void kane?.resume(); });
	});
	void bridge.invoke<FloorState>('floor:state').then(applyState).catch(() => toast('Could not load the floor'));
	const onResize = (): void => layout();
	window.addEventListener('resize', onResize);
	const ro = new ResizeObserver(onResize); ro.observe(stage);

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Alt') { altDown = true; layout(); return; }
		if (!e.altKey || !state) return;
		const visible = state.terminals.filter((t) => !t.hidden).map((t) => t.id);
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const want = nextSpotlight(visible, state.centeredId, e.key === 'ArrowRight' ? 1 : -1); if (want !== null) void bridge.invoke('tile:center', { id: want }); return; }
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const ws = state.workspaces; if (ws.length < 2) return; const i = Math.max(0, ws.findIndex((w) => w.active)); const n = ws[(i + (e.key === 'ArrowDown' ? 1 : -1) + ws.length) % ws.length]!; void bridge.invoke('workspace:switch', { id: n.id }); return; }
		if (e.key === 'k' || e.key === 'K') { e.preventDefault(); if (!kaneOpen) toggleKane(); else kane?.focus(); return; }
		const norm = e.key.length === 1 ? e.key.toUpperCase() : e.key;
		const idx = keyToIndex(norm);
		if (idx !== null && visible[idx] !== undefined) { e.preventDefault(); void bridge.invoke('tile:center', { id: visible[idx] }); }
	};
	const onKeyUp = (e: KeyboardEvent): void => { if (e.key === 'Alt') { altDown = false; for (const t of tiles.values()) t.setBadge(null); } };
	document.addEventListener('keydown', onKeyDown, true);
	document.addEventListener('keyup', onKeyUp, true);

	return () => {
		offState(); offExit(); offStatus();
		window.removeEventListener('resize', onResize); ro.disconnect();
		document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('keyup', onKeyUp, true);
		for (const t of tiles.values()) t.dispose(); tiles.clear(); kane?.dispose();
		root.empty();
	};
}
```
Check `src/ui/toast.ts` and `src/terminals/theme-store.ts` for Node imports before importing them (`grep -n "^import" src/ui/toast.ts src/terminals/theme-store.ts`); both are expected to be DOM-only/pure. If `toast` touches Node, inline a two-line toast in `floor.ts` instead.

- [ ] **Step 6: main.ts (final)**

```ts
// src/web/main.ts
import { installDomShim } from '../ui/dom-shim';
import { createBridge } from './bridge';
import { mountLogin } from './login';
import { mountFloor } from './floor';

installDomShim();
const root = document.getElementById('app')!;
const bridge = createBridge({ url: location.origin.replace(/^http/, 'ws') + '/ws' });

let unmount: (() => void) | null = null;
function showLogin(): void { unmount?.(); unmount = mountLogin(root, bridge, showFloor); }
function showFloor(): void { unmount?.(); unmount = mountFloor(root, bridge); }

bridge.onStatus((s) => { if (s === 'login' && !root.querySelector('.web-login')) showLogin(); });
if (bridge.status() === 'open') showFloor(); else showLogin();
```

- [ ] **Step 7: web.css**

```css
/* web/web.css — browser-only additions on top of app.css + styles.css */
html, body { height: 100%; margin: 0; background: var(--background-primary); color: var(--text-normal); font-family: var(--font-interface, system-ui, sans-serif); }
#app { display: flex; flex-direction: column; height: 100vh; }
.wcc-grid-container { flex: 1 1 auto; min-height: 0; padding: 0 12px 12px; }
.cos-stage-wrap { height: 100%; }
.cos-terminals-stage { height: 100%; }
.web-tile-repo { margin-left: 8px; color: var(--text-faint); }
.web-tile-state { margin-left: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--text-faint); }
.web-tile[data-state="prompt"] .web-tile-state, .web-tile[data-state="menu"] .web-tile-state { color: #e0a92e; }
.web-tile[data-state="errored"] .web-tile-state { color: #d21e12; }
.web-tile[data-state="idle"] .web-tile-state { color: #2fae6e; }
.web-task { flex: 1 1 240px; background: var(--background-primary); color: var(--text-normal); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 4px 8px; }
.web-kane { flex: 0 0 380px; }
.web-board { max-height: 30vh; overflow: auto; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; font-size: 12px; }
.web-board-h { font-weight: 600; margin-bottom: 4px; }
.web-board-row { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.web-board-reg { white-space: pre-wrap; font-size: 11px; color: var(--text-muted); }
.web-login { max-width: 360px; margin: 18vh auto 0; padding: 28px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 12px; }
.web-login-h { font-weight: 600; font-size: 16px; margin-bottom: 6px; }
.web-login-sub { color: var(--text-muted); font-size: 12px; margin-bottom: 14px; }
.web-login-form { display: flex; flex-direction: column; gap: 10px; }
.web-login-pw { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); font-size: 14px; }
.web-login-row { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-muted); }
.web-login-btn { padding: 8px 12px; border-radius: 6px; border: none; background: var(--interactive-accent); color: var(--text-on-accent); font-weight: 600; cursor: pointer; }
.web-login-btn:disabled { opacity: .5; cursor: default; }
.web-login-err { color: #d21e12; font-size: 12px; margin-top: 10px; min-height: 16px; }
.web-usage { margin-left: auto; }
```

- [ ] **Step 8: Test + build + typecheck**

Run: `npx vitest run tests/web-diff.test.ts && npx tsc --noEmit -skipLibCheck && node esbuild.config.mjs`
Expected: test passes; typecheck clean; the web bundle builds with no "Could not resolve" errors. If esbuild reports a Node built-in being pulled in, find the import chain (`npx esbuild src/web/main.ts --bundle --platform=browser --metafile=meta.json --outfile=/dev/null` and inspect `meta.json`) and cut it.

- [ ] **Step 9: Commit**

```bash
git add src/web tests/web-diff.test.ts web/web.css
git commit -m "feat(web): mirrored floor with tiles, Kane dock, spawn, workspaces, keyboard"
```

---

### Task 15: Package files, README, smoke test

**Files:**
- Modify: `package.json` (`build.files`)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-07-tailscale-browser-remote-design.md` (record the device-management deviation)

- [ ] **Step 1: package.json**

In `build.files` add `"dist/web/**"`. (The `web/` sources are not needed at runtime since esbuild copies them into `dist/web/`.)

- [ ] **Step 2: README**

Under "What it does", replace the **Phone floor view** bullet with:
```
- **Browser mirror (Tailscale)** — open `http://<tailscale-ip>:7420/` from any machine on your tailnet: the same tiles, Kane, spawn and workspace controls, typing straight into live sessions. Set a password once in the desktop 📱 panel (12+ chars); browsers get a 30-day device token you can revoke there. The server binds only to loopback and your Tailscale IPs. The phone page still lives at `/phone?t=…` (URLs in the same panel); for voice run `tailscale serve --bg 7420` once.
```

- [ ] **Step 3: Spec note**

Append to the spec under "Decisions already made": `| Device list/revoke from the browser | Not exposed; desktop-only (matches The Spire) |`.

- [ ] **Step 4: Full suite + build**

Run: `npm test && npm run build`
Expected: all tests pass; build clean.

- [ ] **Step 5: Smoke (manual, on the real floor)**

Run `npm start` (do NOT run `install-local`). Then:
1. Desktop: 📱 panel shows a browser URL with a `100.x.y.z` host and "No password yet". Set a 12+ char password. Note says set, 0 devices signed out.
2. Same machine: open `http://127.0.0.1:7420/`. Login page. Wrong password → "Wrong password." Right password → the floor renders with the same tiles as the desktop.
3. Click a satellite tile in the browser → it centers on BOTH screens. Type `echo hi` + Enter in the browser → appears on the desktop tile.
4. Browser Play with a repo + task → a new tile appears on both screens within ~1 s.
5. Alt+K in the browser → Kane dock shows his scrollback; type to him.
6. Alt+↓ → workspace switches on both screens; browser tiles re-attach with scrollback.
7. Second tailnet machine: open `http://<tailscale-ip>:7420/`, log in, repeat step 3.
8. Desktop panel → Revoke that device → the browser drops to the login page within a second with "This device was signed out from the desktop."
9. Close the laptop lid for a minute, reopen → the page reconnects and repaints without a reload.
10. `curl -s -o /dev/null -w "%{http_code}" http://<LAN-ip>:7420/` from another LAN (non-tailnet) machine → connection refused.

Record any failure as a bug against the task that owns that file before fixing.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md docs/superpowers/specs/2026-09-07-tailscale-browser-remote-design.md
git commit -m "docs(remote): browser mirror in README; package web bundle"
```
