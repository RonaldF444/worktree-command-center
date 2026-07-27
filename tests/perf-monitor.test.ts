import { describe, it, expect } from 'vitest';
import { perfSampleLine, perfStallLine } from '../src/ui/perf-monitor';

describe('perfStallLine', () => {
	it('serializes a longtask stall as one JSON line', () => {
		const line = perfStallLine(1_800_000_000, 'longtask', 412.7);
		expect(JSON.parse(line)).toEqual({ t: new Date(1_800_000_000).toISOString(), stall: 'longtask', ms: 413 });
		expect(line).not.toContain('\n');
	});
	it('serializes a heartbeat gap stall', () => {
		expect(JSON.parse(perfStallLine(5_000, 'gap', 300)).stall).toBe('gap');
	});
});

describe('perfSampleLine', () => {
	it('serializes a sample with heap info as one JSON line', () => {
		const line = perfSampleLine(1_800_060_000, 1_800_000_000, { usedJSHeapSize: 104857600, totalJSHeapSize: 209715200 }, 12345);
		expect(JSON.parse(line)).toEqual({
			t: new Date(1_800_060_000).toISOString(),
			uptimeMin: 1,
			heapUsedMB: 100,
			heapTotalMB: 200,
			domNodes: 12345,
		});
		expect(line).not.toContain('\n');
	});

	it('handles a missing heap API (non-Chromium performance.memory) with nulls', () => {
		const parsed = JSON.parse(perfSampleLine(5_000, 5_000, null, 7));
		expect(parsed.heapUsedMB).toBeNull();
		expect(parsed.heapTotalMB).toBeNull();
		expect(parsed.uptimeMin).toBe(0);
		expect(parsed.domNodes).toBe(7);
	});

	it('rounds uptime to whole minutes', () => {
		expect(JSON.parse(perfSampleLine(90_000 + 29_000, 0, null, 1)).uptimeMin).toBe(2);
		expect(JSON.parse(perfSampleLine(89_000, 0, null, 1)).uptimeMin).toBe(1);
	});
});
