import { describe, it, expect } from 'vitest';
import { shouldDisableGpu } from '../electron/gpu-flag';

describe('shouldDisableGpu', () => {
	it('defaults to DISABLED (GPU off) with no env and no config', () => {
		expect(shouldDisableGpu(undefined, undefined)).toBe(true);
		expect(shouldDisableGpu(undefined, {})).toBe(true);
		expect(shouldDisableGpu('', null)).toBe(true);
	});

	it('config disableGpu:false is the persistent opt-back-in; anything else stays off', () => {
		expect(shouldDisableGpu(undefined, { disableGpu: false })).toBe(false);
		expect(shouldDisableGpu(undefined, { disableGpu: true })).toBe(true);
		// Only the boolean false re-enables — a stringly or garbage value must not.
		expect(shouldDisableGpu(undefined, { disableGpu: 'false' })).toBe(true);
		expect(shouldDisableGpu(undefined, { disableGpu: 0 })).toBe(true);
		expect(shouldDisableGpu(undefined, 'not-an-object')).toBe(true);
		expect(shouldDisableGpu(undefined, [])).toBe(true);
	});

	it('env WCC_DISABLE_GPU wins over config, both directions', () => {
		for (const on of ['0', 'false', 'off', ' FALSE ', 'Off']) {
			expect(shouldDisableGpu(on, { disableGpu: true })).toBe(false);
		}
		for (const off of ['1', 'true', 'on', ' TRUE ']) {
			expect(shouldDisableGpu(off, { disableGpu: false })).toBe(true);
		}
		// Unrecognized env values fall through to the config/default.
		expect(shouldDisableGpu('yes-please', { disableGpu: false })).toBe(false);
		expect(shouldDisableGpu('yes-please', {})).toBe(true);
	});
});
