import { describe, it, expect } from 'vitest';
import { openUrlFor, portsSignature } from '../src/web/ports';
import { toFloorPorts } from '../src/terminals/floor-state';

describe('openUrlFor', () => {
	it('swaps the desktop-local host for the host the page was served from', () => {
		expect(openUrlFor('http://localhost:3000/', '100.80.212.98')).toBe('http://100.80.212.98:3000/');
		expect(openUrlFor('http://localhost:5173/app?x=1', 'desk.tail1234.ts.net')).toBe('http://desk.tail1234.ts.net:5173/app?x=1');
		expect(openUrlFor('https://localhost:8443/a', '100.80.212.98')).toBe('https://100.80.212.98:8443/a');
	});
	it('leaves a LAN address alone (there is no tunnel for it)', () => {
		expect(openUrlFor('http://192.168.1.20:8080/', '100.80.212.98')).toBe('http://192.168.1.20:8080/');
	});
});

describe('portsSignature', () => {
	it('changes when a port, path or owner changes and ignores timestamps', () => {
		const a = [{ port: 3000, host: 'localhost', path: '/', url: 'http://localhost:3000/', tileId: 1, name: 'a', repo: 'r' }];
		const same = [{ ...a[0]! }];
		const moved = [{ ...a[0]!, tileId: 2 }];
		expect(portsSignature(a)).toBe(portsSignature(same));
		expect(portsSignature(a)).not.toBe(portsSignature(moved));
		expect(portsSignature([])).not.toBe(portsSignature(a));
	});
});

describe('toFloorPorts', () => {
	it('keeps only what the browser renders and forwards', () => {
		const item = { key: 'localhost:3000', url: 'http://localhost:3000/x', host: 'localhost', port: 3000, path: '/x', tileId: 4, firstSeenMs: 1, lastSeenMs: 2, name: 'Bins', repo: 'cj' };
		expect(toFloorPorts([item])).toEqual([{ port: 3000, host: 'localhost', path: '/x', url: 'http://localhost:3000/x', tileId: 4, name: 'Bins', repo: 'cj' }]);
	});
});
