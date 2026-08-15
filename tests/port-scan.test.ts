import { describe, it, expect } from 'vitest';
import { PortScanner, scanText, stripAnsi } from '../src/terminals/port-scan';

const urls = (hits: { url: string }[]): string[] => hits.map((h) => h.url);

describe('stripAnsi', () => {
	it('drops SGR colour but keeps the text around it', () => {
		expect(stripAnsi('\x1b[32m➜\x1b[0m  Local: http://localhost:5173/')).toBe('➜  Local: http://localhost:5173/');
	});
	it('keeps an OSC 8 hyperlink TARGET as plain text (the visible label may not be the URL)', () => {
		expect(stripAnsi('\x1b]8;;http://localhost:3000\x07open me\x1b]8;;\x07')).toContain('http://localhost:3000');
	});
});

describe('scanText', () => {
	it('finds a coloured vite Local line', () => {
		expect(urls(scanText(stripAnsi('  \x1b[32m➜\x1b[0m  Local:   http://localhost:5173/\n')))).toEqual(['http://localhost:5173/']);
	});
	it('normalises loopback aliases to localhost', () => {
		expect(urls(scanText('http://127.0.0.1:3000/ http://0.0.0.0:8080/'))).toEqual(['http://localhost:3000/', 'http://localhost:8080/']);
	});
	it('accepts a bare host:port and defaults the scheme', () => {
		expect(urls(scanText('server ready at localhost:3000'))).toEqual(['http://localhost:3000']);
	});
	it('keeps private LAN addresses — that is the URL that works from a phone', () => {
		expect(urls(scanText('Network: http://192.168.1.42:5173/'))).toEqual(['http://192.168.1.42:5173/']);
	});
	it('ignores public hosts — this is a dev-server list, not browser history', () => {
		expect(scanText('https://github.com:443/x https://example.com:8080/')).toEqual([]);
	});
	it('does not match a localhost-suffixed hostname', () => {
		expect(scanText('http://notlocalhost:3000/')).toEqual([]);
	});
	it('trims trailing sentence punctuation off the path', () => {
		expect(urls(scanText('see http://localhost:3000/api. done'))).toEqual(['http://localhost:3000/api']);
	});
});

describe('PortScanner', () => {
	it('reassembles a URL split across two pty writes', () => {
		const s = new PortScanner();
		expect(s.feed('  Local: http://localho')).toEqual([]);
		expect(urls(s.feed('st:3000/\n'))).toEqual(['http://localhost:3000/']);
	});
	it('never reports the same occurrence twice as the carry window slides', () => {
		const s = new PortScanner();
		expect(urls(s.feed('http://localhost:5173/\n'))).toEqual(['http://localhost:5173/']);
		expect(s.feed('building…\n')).toEqual([]);
		expect(s.feed('done\n')).toEqual([]);
	});
	it('holds a hit that ends exactly at the chunk boundary until it is proven complete', () => {
		const s = new PortScanner();
		expect(s.feed('http://localhost:300')).toEqual([]); // could be :3000 — do not report :300
		expect(urls(s.feed('0/\n'))).toEqual(['http://localhost:3000/']);
	});
	it('reports two distinct servers printed on one line', () => {
		const s = new PortScanner();
		expect(urls(s.feed('web http://localhost:3000/ api http://localhost:3001/api\n')))
			.toEqual(['http://localhost:3000/', 'http://localhost:3001/api']);
	});
	it('exposes host, port and path as parsed fields', () => {
		const s = new PortScanner();
		expect(s.feed('http://127.0.0.1:8080/health\n')).toEqual([
			{ url: 'http://localhost:8080/health', host: 'localhost', port: 8080, path: '/health' },
		]);
	});
	it('does not emit truncated URLs at punctuation boundaries', () => {
		const s = new PortScanner();
		// URL ends with .json — the . is in the trim set, so without raw length tracking,
		// the shortened length would make absEnd land short of textEnd, emitting truncated :3000/api.
		// This would then prevent the real URL from being emitted on the next feed.
		expect(s.feed('http://localhost:3000/api.')).toEqual([]); // boundary case: held
		expect(urls(s.feed('json\n'))).toEqual(['http://localhost:3000/api.json']);
	});
	it('slides the carry window past CARRY_CHARS without re-reporting', () => {
		const s = new PortScanner();
		// Feed a URL, then feed > 256 chars to push absBase forward, then feed the same URL again.
		// Without proper absBase advancement in absEnd >= textEnd check, a duplicate could be reported.
		expect(urls(s.feed('http://localhost:3000/api\n'))).toEqual(['http://localhost:3000/api']);
		// Feed 300 chars of filler to advance absBase > 0 (absBase += text.length - keep.length where keep is 256 chars).
		const filler = 'x'.repeat(300);
		expect(s.feed(filler + '\n')).toEqual([]);
		// Feed the same URL again — must not re-report.
		expect(urls(s.feed('http://localhost:3000/api\n'))).toEqual(['http://localhost:3000/api']);
	});
});
