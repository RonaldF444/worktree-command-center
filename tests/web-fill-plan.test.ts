import { describe, it, expect } from 'vitest';
import { planFillTransition } from '../src/web/fill-plan';

describe('planFillTransition — manual-read fill for the browser floor', () => {
	it('fills only when the desk confirms the centre the user asked for', () => {
		expect(planFillTransition({ filledId: null, wantFillId: 2, wantExpired: false, centeredId: 2 }))
			.toEqual({ release: null, fill: 2, clearWant: true });
	});

	it('a desk-driven spotlight move (FIFO / cycling) never fills', () => {
		// No user request in flight: centre moves to 3, nothing fills.
		expect(planFillTransition({ filledId: null, wantFillId: null, wantExpired: false, centeredId: 3 }))
			.toEqual({ release: null, fill: null, clearWant: false });
	});

	it('the filled tile is released once the spotlight is confirmed elsewhere, filling nothing new', () => {
		expect(planFillTransition({ filledId: 2, wantFillId: null, wantExpired: false, centeredId: 3 }))
			.toEqual({ release: 2, fill: null, clearWant: false });
	});

	it('click A then click B: one release, one fill, in the same pass', () => {
		expect(planFillTransition({ filledId: 1, wantFillId: 2, wantExpired: false, centeredId: 2 }))
			.toEqual({ release: 1, fill: 2, clearWant: true });
	});

	it('a stale confirm (auto won the race) keeps the want pending for OUR confirm', () => {
		// User clicked 2; auto centred 3 first. No fill yet, want survives for when 2 lands.
		expect(planFillTransition({ filledId: null, wantFillId: 2, wantExpired: false, centeredId: 3 }))
			.toEqual({ release: null, fill: null, clearWant: false });
	});

	it('an expired want is dropped, never resurrected by a later auto-move onto that tile', () => {
		expect(planFillTransition({ filledId: null, wantFillId: 2, wantExpired: true, centeredId: 2 }))
			.toEqual({ release: null, fill: null, clearWant: true });
	});

	it('steady state: filled tile still centred → nothing happens', () => {
		expect(planFillTransition({ filledId: 2, wantFillId: null, wantExpired: false, centeredId: 2 }))
			.toEqual({ release: null, fill: null, clearWant: false });
	});
});
