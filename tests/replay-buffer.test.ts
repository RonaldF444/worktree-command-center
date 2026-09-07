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
