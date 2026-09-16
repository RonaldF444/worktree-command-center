// Pure mapping: keyboard event -> terminal scrollback intent. No DOM/IO.
//
// Uses Shift+<nav> combos so normal Claude input (plain arrows / PageUp / Home /
// End / Enter / Esc) is never intercepted — only Shift-held variants scroll.

export type ScrollIntent =
	| { kind: 'lines'; amount: number }
	| { kind: 'pages'; amount: number }
	| { kind: 'top' }
	| { kind: 'bottom' };

/** The escape sequence that asks the RUNNING TUI to scroll, for when there is no xterm
 *  scrollback to move. Claude's flicker-free TUI keeps the conversation in the alternate screen
 *  buffer, so `term.scrollLines()` has nothing to scroll — the intent has to go down the PTY as
 *  keys Claude itself binds: PgUp/PgDn, Ctrl+Home/End, and a mouse-wheel tick for line scrolling
 *  (one tick = scroll:lineUp/Down = CLAUDE_CODE_SCROLL_SPEED lines, default 3 — matching the
 *  3-line xterm scroll, not a page). Shared so the desktop tile and the browser mirror cannot
 *  drift apart; both call it behind the same alternate-buffer check. */
export function scrollKeySequence(intent: ScrollIntent): string {
	if (intent.kind === 'top') return '\x1b[1;5H';                    // Ctrl+Home -> scroll to top
	if (intent.kind === 'bottom') return '\x1b[1;5F';                 // Ctrl+End  -> scroll to bottom
	if (intent.kind === 'pages') return intent.amount < 0 ? '\x1b[5~' : '\x1b[6~';        // PgUp / PgDn
	return intent.amount < 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M';     // SGR wheel up / down
}

/** Map a key event to a scroll intent, or null if it isn't a scroll key. */
export function scrollIntentForKey(e: { key: string; shiftKey: boolean }): ScrollIntent | null {
	if (!e.shiftKey) return null;
	switch (e.key) {
		case 'PageUp': return { kind: 'pages', amount: -1 };
		case 'PageDown': return { kind: 'pages', amount: 1 };
		case 'ArrowUp': return { kind: 'lines', amount: -3 };
		case 'ArrowDown': return { kind: 'lines', amount: 3 };
		case 'Home': return { kind: 'top' };
		case 'End': return { kind: 'bottom' };
		default: return null;
	}
}
