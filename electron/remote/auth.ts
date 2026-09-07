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
	const store = loadAuthStore(deps.file);
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
