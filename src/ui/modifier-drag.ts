/** Windows-key drags belong to the window manager, not to us. Ronald runs komorebi with Super =
 *  the Windows key: Win+left-drag moves the whole WCC window, Win+right-drag resizes it. The
 *  drag still reaches the page as ordinary mouse events, so every xterm started a text
 *  selection and a tile took the release as "click to center". While the Windows key is held
 *  (and no Ctrl/Alt, which keep their own meanings) the mouse press is swallowed at the
 *  capture phase, before xterm or any tile sees it. Chromium reports the Windows key as
 *  `metaKey` on Windows. */

export interface ModifierState { metaKey: boolean; ctrlKey: boolean; altKey: boolean; button: number }

export function isWindowDrag(e: ModifierState): boolean {
	return e.metaKey && !e.ctrlKey && !e.altKey;
}

const TYPES = ['mousedown', 'mouseup', 'click'] as const;

/** Install once per page (document by default). Returns the uninstaller. */
export function installWindowDragGuard(target: EventTarget = document): () => void {
	const guard = (e: Event): void => {
		const m = e as unknown as ModifierState;
		if (typeof m.metaKey !== 'boolean' || !isWindowDrag(m)) return;
		e.preventDefault();
		e.stopImmediatePropagation();
	};
	for (const t of TYPES) target.addEventListener(t, guard, true);
	return () => { for (const t of TYPES) target.removeEventListener(t, guard, true); };
}
