import { describe, it, expect } from 'vitest';
import { diffIds } from '../src/web/diff';

describe('diffIds', () => {
	it('reports added and removed ids, order-stable', () => {
		expect(diffIds([1, 2, 3], [2, 3, 4])).toEqual({ added: [4], removed: [1] });
		expect(diffIds([], [])).toEqual({ added: [], removed: [] });
		expect(diffIds([5], [5])).toEqual({ added: [], removed: [] });
	});
});
