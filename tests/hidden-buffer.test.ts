import { describe, it, expect } from 'vitest';
import { HiddenOutputBuffer } from '../src/terminals/hidden-buffer';

describe('HiddenOutputBuffer', () => {
	it('accumulates chunks and drains them in order on takeAll', () => {
		const b = new HiddenOutputBuffer();
		b.push('hello ');
		b.push('world');
		expect(b.takeAll()).toEqual({ data: 'hello world', dropped: false });
	});

	it('takeAll drains: a second takeAll returns nothing', () => {
		const b = new HiddenOutputBuffer();
		b.push('once');
		b.takeAll();
		expect(b.takeAll()).toEqual({ data: '', dropped: false });
	});

	it('drops everything (including the overflowing chunk) when the cap is exceeded', () => {
		const b = new HiddenOutputBuffer(10);
		b.push('123456');
		b.push('7890X'); // total 11 > cap 10 → whole pending window is superseded
		expect(b.takeAll()).toEqual({ data: '', dropped: true });
	});

	it('keeps accumulating after a drop and reports dropped once', () => {
		const b = new HiddenOutputBuffer(10);
		b.push('12345678901'); // overflow → dropped
		b.push('tail');        // fresh accumulation under cap
		expect(b.takeAll()).toEqual({ data: 'tail', dropped: true });
		b.push('more');
		expect(b.takeAll()).toEqual({ data: 'more', dropped: false });
	});

	it('a single chunk larger than the cap is itself dropped', () => {
		const b = new HiddenOutputBuffer(4);
		b.push('abcdefgh');
		expect(b.takeAll()).toEqual({ data: '', dropped: true });
	});

	it('clear resets pending data and the dropped flag', () => {
		const b = new HiddenOutputBuffer(4);
		b.push('abcdefgh'); // dropped
		b.push('xy');
		b.clear();
		expect(b.takeAll()).toEqual({ data: '', dropped: false });
	});
});
