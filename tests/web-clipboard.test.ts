import { describe, it, expect, vi } from 'vitest';
import { copyText } from '../src/web/clipboard';

describe('copyText — browser mirror clipboard', () => {
	it('uses the async Clipboard API when the page is a secure context', async () => {
		const writeAsync = vi.fn(async () => {});
		const writeLegacy = vi.fn(() => true);
		expect(await copyText('hello', { writeAsync, writeLegacy })).toBe(true);
		expect(writeAsync).toHaveBeenCalledWith('hello');
		expect(writeLegacy).not.toHaveBeenCalled();
	});

	it('falls back to execCommand when the Clipboard API is absent — the http/Tailscale case', async () => {
		const writeLegacy = vi.fn(() => true);
		expect(await copyText('hello', { writeLegacy })).toBe(true);
		expect(writeLegacy).toHaveBeenCalledWith('hello');
	});

	it('falls back when the Clipboard API exists but rejects (permission denied)', async () => {
		const writeAsync = vi.fn(async () => { throw new Error('denied'); });
		const writeLegacy = vi.fn(() => true);
		expect(await copyText('hi', { writeAsync, writeLegacy })).toBe(true);
		expect(writeLegacy).toHaveBeenCalledWith('hi');
	});

	it('reports failure when both paths fail, and never throws', async () => {
		const writeAsync = vi.fn(async () => { throw new Error('denied'); });
		const writeLegacy = vi.fn(() => { throw new Error('execCommand blew up'); });
		expect(await copyText('hi', { writeAsync, writeLegacy })).toBe(false);
		expect(await copyText('hi', { writeLegacy: () => false })).toBe(false);
		expect(await copyText('hi', {})).toBe(false);
	});

	it('empty selections are a no-op — never clobber the clipboard with nothing', async () => {
		const writeAsync = vi.fn(async () => {});
		const writeLegacy = vi.fn(() => true);
		expect(await copyText('', { writeAsync, writeLegacy })).toBe(false);
		expect(writeAsync).not.toHaveBeenCalled();
		expect(writeLegacy).not.toHaveBeenCalled();
	});
});
