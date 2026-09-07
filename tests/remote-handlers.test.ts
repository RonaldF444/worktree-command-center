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
