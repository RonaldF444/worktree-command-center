// tests/remote-auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuth, hashPassword, verifyPassword, loadAuthStore, saveAuthStore, MIN_PASSWORD_LENGTH, TOO_MANY_ATTEMPTS_ERROR, NO_PASSWORD_ERROR, STORAGE_FAILED_ERROR, _kdfState } from '../electron/remote/auth';

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
	it('rejects a stored hash whose key length does not match the KDF output length', async () => {
		expect(await verifyPassword('scrypt$131072$8$1$00$ab', PW)).toBe(false);
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
	it('drops malformed device entries but keeps well-formed ones', () => {
		fs.writeFileSync(file, JSON.stringify({ passwordHash: 'h', devices: [null, 5, { id: 'x' }, { id: 'ok', tokenHash: 't', createdAt: 1, lastSeen: 2 }] }), 'utf8');
		expect(loadAuthStore(file)).toEqual({ passwordHash: 'h', devices: [{ id: 'ok', tokenHash: 't', createdAt: 1, lastSeen: 2, label: '' }] });
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
	it("returns the 'invalid password' literal on a wrong password", async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		expect(await a.authenticate({ password: 'nope nope nope' }, '1.1.1.1')).toEqual({ ok: false, error: 'invalid password' });
	}, 20_000);
	it("returns 'no credentials supplied' when the frame has neither password nor deviceToken", async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		expect(await a.authenticate({}, '1.1.1.1')).toEqual({ ok: false, error: 'no credentials supplied' });
	});
	it('a correct password clears the per-IP entry but does not lift an active account-wide lock', async () => {
		let t = 0;
		const a = createAuth({ file, now: () => t });
		await a.setPassword(PW);
		for (let i = 0; i < 20; i++) await a.authenticate({ password: 'wrong wrong wrong' }, `20.0.0.${i}`);
		expect(await a.authenticate({ password: PW }, '30.0.0.1')).toEqual({ ok: false, error: TOO_MANY_ATTEMPTS_ERROR });
		t += 15 * 60 * 1000 + 1;
		expect((await a.authenticate({ password: PW }, '30.0.0.1')).ok).toBe(true);
	}, 60_000);
	it('a correct password clears the per-IP failure count, restarting it from 0', async () => {
		let t = 0;
		const a = createAuth({ file, now: () => t });
		await a.setPassword(PW);
		for (let i = 0; i < 4; i++) expect(await a.authenticate({ password: 'wrong wrong wrong' }, '7.7.7.7')).toEqual({ ok: false, error: 'invalid password' });
		expect((await a.authenticate({ password: PW }, '7.7.7.7')).ok).toBe(true);
		// If the per-IP entry had NOT been cleared by the success above, cumulative failures would
		// already be at 4 here, and just one more wrong attempt would cross LOCKOUT_THRESHOLD (5) --
		// the very next call after it would then report the lock instead of 'invalid password'. All
		// four succeeding as 'invalid password' proves the counter actually restarted from 0.
		for (let i = 0; i < 4; i++) expect(await a.authenticate({ password: 'wrong wrong wrong' }, '7.7.7.7')).toEqual({ ok: false, error: 'invalid password' });
		// The 5th cumulative failure since the reset crosses the threshold and engages the lock; that
		// failing call still reports the password as wrong (as in "locks an IP after 5 wrong passwords"
		// above) -- the lock itself surfaces on the next attempt.
		expect(await a.authenticate({ password: 'wrong wrong wrong' }, '7.7.7.7')).toEqual({ ok: false, error: 'invalid password' });
		expect(await a.authenticate({ password: PW }, '7.7.7.7')).toEqual({ ok: false, error: TOO_MANY_ATTEMPTS_ERROR });
	}, 60_000);
	it('resolves storage failures instead of rejecting authenticate()', async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		fs.mkdirSync(file + '.tmp');
		await expect(a.authenticate({ password: PW }, '1.1.1.1')).resolves.toEqual({ ok: false, error: STORAGE_FAILED_ERROR });
	}, 20_000);
	it('does not leak KDF slots under concurrent load (regression)', async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		const results = await Promise.all([
			a.authenticate({ password: 'wrong wrong wrong' }, '1.1.1.1'),
			a.authenticate({ password: PW }, '1.1.1.1'),
			a.authenticate({ password: 'wrong wrong wrong' }, '1.1.1.1'),
			a.authenticate({ password: PW }, '1.1.1.1'),
			a.authenticate({ password: 'wrong wrong wrong' }, '1.1.1.1'),
		]);
		expect(results).toHaveLength(5);
		const sixth = await a.authenticate({ password: PW }, '2.2.2.2');
		expect(sixth.ok).toBe(true);
		expect(_kdfState()).toEqual({ active: 0, queued: 0 });
	}, 20_000);
	it('reserves lockout capacity before the KDF await so a concurrent burst cannot overshoot the threshold', async () => {
		const a = createAuth({ file });
		await a.setPassword(PW);
		const results = await Promise.all(Array.from({ length: 8 }, () => a.authenticate({ password: 'wrong wrong wrong' }, '3.3.3.3')));
		const invalid = results.filter((r) => !r.ok && r.error === 'invalid password');
		const throttled = results.filter((r) => !r.ok && r.error === TOO_MANY_ATTEMPTS_ERROR);
		expect(invalid.length).toBeLessThanOrEqual(5);
		expect(invalid.length + throttled.length).toBe(8);
	}, 20_000);
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
