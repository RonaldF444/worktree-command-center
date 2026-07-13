import { describe, it, expect } from 'vitest';
import { coordBoardStartsCollapsed } from '../src/terminals/board-view';

describe('coordBoardStartsCollapsed (Coordination panel default)', () => {
	it('collapses by default when nothing is stored — no auto-open on workspace switch', () => {
		expect(coordBoardStartsCollapsed(null)).toBe(true);
	});
	it('stays collapsed when the user collapsed it', () => {
		expect(coordBoardStartsCollapsed('1')).toBe(true);
	});
	it('opens ONLY when the user explicitly expanded it', () => {
		expect(coordBoardStartsCollapsed('0')).toBe(false);
	});
});
