import { describe, it, expect } from 'vitest';
import { isWindowDrag, installWindowDragGuard } from '../src/ui/modifier-drag';

const ev = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; button: number }>) =>
	({ metaKey: false, ctrlKey: false, altKey: false, button: 0, ...o });

describe('isWindowDrag', () => {
	it('is a Windows-key press with no other modifier, any mouse button', () => {
		expect(isWindowDrag(ev({ metaKey: true }))).toBe(true);
		expect(isWindowDrag(ev({ metaKey: true, button: 2 }))).toBe(true); // Win+right drag = resize
	});
	it('is not a plain click, nor Ctrl/Alt combos (those keep their meanings)', () => {
		expect(isWindowDrag(ev({}))).toBe(false);
		expect(isWindowDrag(ev({ ctrlKey: true }))).toBe(false);
		expect(isWindowDrag(ev({ metaKey: true, ctrlKey: true }))).toBe(false);
		expect(isWindowDrag(ev({ metaKey: true, altKey: true }))).toBe(false);
	});
});

/** Minimal EventTarget stand-in: records capture listeners and lets a test fire synthetic events. */
class FakeTarget {
	listeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean }>>();
	addEventListener(type: string, fn: (e: any) => void, capture?: boolean | AddEventListenerOptions): void {
		const list = this.listeners.get(type) ?? [];
		list.push({ fn, capture: capture === true || (typeof capture === 'object' && !!capture.capture) });
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, fn: (e: any) => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn));
	}
	fire(type: string, e: any): void { for (const l of this.listeners.get(type) ?? []) l.fn(e); }
}
const synthetic = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; button: number }>) => {
	const calls: string[] = [];
	return { ...ev(o), preventDefault: () => calls.push('preventDefault'), stopImmediatePropagation: () => calls.push('stop'), calls };
};

describe('installWindowDragGuard', () => {
	it('swallows mousedown/mouseup/click in the capture phase while the Windows key is held', () => {
		const t = new FakeTarget();
		installWindowDragGuard(t as unknown as EventTarget);
		for (const type of ['mousedown', 'mouseup', 'click']) {
			expect(t.listeners.get(type)?.every((l) => l.capture)).toBe(true);
			const e = synthetic({ metaKey: true });
			t.fire(type, e);
			expect(e.calls).toEqual(['preventDefault', 'stop']);
		}
	});
	it('lets every other press through untouched, and uninstalls cleanly', () => {
		const t = new FakeTarget();
		const off = installWindowDragGuard(t as unknown as EventTarget);
		const e = synthetic({ ctrlKey: true });
		t.fire('mousedown', e);
		expect(e.calls).toEqual([]);
		off();
		expect([...t.listeners.values()].every((l) => l.length === 0)).toBe(true);
	});
});
