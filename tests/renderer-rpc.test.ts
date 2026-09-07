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
