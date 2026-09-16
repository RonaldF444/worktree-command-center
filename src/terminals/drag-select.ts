// Plain-drag text selection while the TUI owns the mouse.
//
// Claude's new TUI (v2.1.227+) enables mouse tracking, so xterm forwards every plain
// press/drag to the TUI instead of selecting text — selection suddenly required
// Shift+drag, which nobody discovers. xterm has no "drag selects, click reports"
// option, so this module adds it at the DOM layer:
//
//   - plain LEFT press: held back until we know what it is.
//       - moves past the threshold  -> a DRAG: replay the press as Shift+press so
//         xterm's SelectionService takes it (Shift is xterm's documented
//         force-selection override) and the following real mousemoves extend the
//         selection natively.
//       - released without moving   -> a CLICK: replay the original press unmodified,
//         then let the real release propagate — the TUI sees press+release as before,
//         so clicking menu options still works.
//   - double/triple press (detail >= 2): selection immediately (word/line select);
//     the TUI has no double-click behaviour worth keeping.
//   - Shift/Ctrl/Alt/Meta-modified, non-left, or TUI-not-tracking presses: untouched
//     (Ctrl+click opens links, Shift+drag stays native, plain shells select natively).
//
// The decision logic is pure and unit-tested; only the thin listeners touch the DOM.

export type MouseSig = {
	button: number;
	detail: number;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
};

export type DownAction = 'pass' | 'hold' | 'select';

/** What to do with a mousedown. `synthetic` = one of our own replays (never touch those). */
export function decideMouseDown(e: MouseSig, tuiOwnsMouse: boolean, synthetic: boolean): DownAction {
	if (synthetic) return 'pass';
	if (e.button !== 0) return 'pass';
	if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return 'pass';
	if (!tuiOwnsMouse) return 'pass'; // xterm selects natively when nothing tracks the mouse
	return e.detail >= 2 ? 'select' : 'hold';
}

/** Has the pointer moved far enough from the press to count as a drag (not click jitter)? */
export function isDrag(dx: number, dy: number, threshold = 5): boolean {
	return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}

export interface DragSelectDeps {
	/** Is the running app tracking the mouse? (term.modes.mouseTrackingMode !== 'none') */
	tuiOwnsMouse(): boolean;
	/** Clear the xterm selection — a replayed Shift+press would otherwise EXTEND an old one. */
	clearSelection(): void;
}

/** Our replayed events, so the capture listener passes them through instead of re-holding. */
const synthetic = new WeakSet<Event>();

function replay(src: MouseEvent, shift: boolean): MouseEvent {
	const e = new MouseEvent('mousedown', {
		bubbles: true, cancelable: true, composed: true, view: window,
		clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY,
		button: src.button, buttons: src.buttons, detail: src.detail,
		shiftKey: shift, ctrlKey: src.ctrlKey, altKey: src.altKey, metaKey: src.metaKey,
	});
	synthetic.add(e);
	return e;
}

/** After a selection gesture ends, the browser still fires a native `click` for the press —
 *  and the tiles' click-to-center handlers treat it as "center me", which (in the browser
 *  mirror) fills + RESIZES the tile, and xterm clears the selection on a row change. That is
 *  exactly the "unhighlights the second I let go" bug. A drag is not a click: arm a one-shot
 *  capture listener at release that eats that single click before anyone reacts to it. */
function swallowGestureClick(): void {
	const arm = () => {
		const eat = (c: MouseEvent) => { c.stopImmediatePropagation(); c.preventDefault(); };
		window.addEventListener('click', eat, { capture: true, once: true });
		// A release with no click after it (e.g. release over a different element) must not
		// leave the eater armed for some future real click.
		setTimeout(() => window.removeEventListener('click', eat, true), 500);
	};
	window.addEventListener('mouseup', arm, { capture: true, once: true });
	setTimeout(() => window.removeEventListener('mouseup', arm, true), 30_000);
}

/** Wire plain-drag selection onto a terminal body. Registered in the CAPTURE phase, so it
 *  must be attached AFTER any focus-guard capture listener on the same element (a guard's
 *  stopImmediatePropagation then still wins for unfocused tiles). */
export function attachDragSelect(el: HTMLElement, deps: DragSelectDeps): void {
	el.addEventListener('mousedown', (down) => {
		const action = decideMouseDown(down, deps.tuiOwnsMouse(), synthetic.has(down));
		if (action === 'pass') return;
		const target = down.target as EventTarget | null;
		if (!target) return;
		down.preventDefault();
		down.stopImmediatePropagation();
		if (action === 'select') { // double/triple click — word/line select right away
			deps.clearSelection();
			swallowGestureClick();
			target.dispatchEvent(replay(down, true));
			return;
		}
		// 'hold': wait to see whether this press becomes a drag or stays a click.
		const done = () => {
			window.removeEventListener('mousemove', onMove, true);
			window.removeEventListener('mouseup', onUp, true);
			window.removeEventListener('blur', onBlur);
		};
		const onMove = (move: MouseEvent) => {
			if (!isDrag(move.clientX - down.clientX, move.clientY - down.clientY)) return;
			done();
			deps.clearSelection();
			swallowGestureClick();
			// Shift+press at the ORIGINAL coords anchors the selection where the drag began;
			// xterm registers its document-level drag listeners synchronously in here, so the
			// real mousemoves from now on (this one included) extend the selection.
			target.dispatchEvent(replay(down, true));
		};
		const onUp = () => {
			done();
			// A click after all: give the TUI its press now; the real release is mid-flight
			// (we are in its capture phase) and reaches xterm right after, completing the pair.
			target.dispatchEvent(replay(down, false));
		};
		const onBlur = () => done();
		window.addEventListener('mousemove', onMove, true);
		window.addEventListener('mouseup', onUp, true);
		window.addEventListener('blur', onBlur);
	}, true);
}
