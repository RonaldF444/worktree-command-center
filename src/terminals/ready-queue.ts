// Pure logic for the "ready" FIFO queue + input-box composing state. No DOM/IO.
//
// Behavior (2026-07-24 spec — first finished, first served):
// - A terminal that becomes ready joins the BACK of the queue; the FRONT (waiting
//   longest) is served first. Whether a fresh finisher may STEAL the center is the
//   grid's call (event-driven, gated by an activity grace window) — this module only
//   reports whether the tile is newly ready (`added`).
// - Submitting (Enter) to a terminal finishes it: removed; the decider then serves
//   the queue front.
// - Clicking a tile pins it (manual override). Clicking AWAY from a centered ready
//   tile demotes that tile to the back of the queue — it gave up its turn.

export interface QueueState {
	queue: number[];         // ready tile ids, FIFO (front = index 0 = waiting longest)
	pinnedId: number | null; // manual click pin — held until you act or a steal replaces it
	composingLen: number;    // approx. number of chars in the focused terminal's input box
}

export function emptyState(): QueueState {
	return { queue: [], pinnedId: null, composingLen: 0 };
}

/** Approximate the input-box length after a raw keystroke chunk from xterm. */
export function applyKeystroke(len: number, data: string): number {
	if (data === '\x1b') return 0;                            // bare Escape: cancels/clears the box
	if (data.startsWith('\x1b')) return len;                  // escape seq (arrows, fn keys) — ignore
	if (data.includes('\r') || data.includes('\n')) return 0; // submit clears the box
	let n = len;
	for (const ch of data) {
		if (ch === '\x7f' || ch === '\b') n = Math.max(0, n - 1); // backspace
		else if (ch === '\x15' || ch === '\x03') n = 0;            // ctrl-u (kill line) / ctrl-c
		else if (ch.charCodeAt(0) >= 0x20) n += 1;                 // printable
	}
	return n;
}

/** A tile became ready → back of the queue. `added` distinguishes a fresh finish
 *  (a potential steal event) from an idle re-fire (never a steal). */
export function onReady(s: QueueState, id: number): { state: QueueState; added: boolean } {
	if (s.queue.includes(id)) return { state: s, added: false };
	return { state: { ...s, queue: [...s.queue, id] }, added: true };
}

/** User submitted (Enter) to a tile — finished with it. Remove it; drop a matching pin. */
export function onSubmit(s: QueueState, id: number): { state: QueueState } {
	return { state: { queue: s.queue.filter((x) => x !== id), pinnedId: s.pinnedId === id ? null : s.pinnedId, composingLen: 0 } };
}

/** A tile closed/hid. Remove it; drop a matching pin. */
export function onClose(s: QueueState, id: number): { state: QueueState } {
	return { state: { ...s, queue: s.queue.filter((x) => x !== id), pinnedId: s.pinnedId === id ? null : s.pinnedId } };
}

/** User cycled past the last tile into the equal-grid overview: everything ready has
 *  been SEEN. Clear the queue + pin so idle tiles stop attracting the spotlight; a
 *  fresh finish re-queues via onReady, and prompts/errors break in regardless. */
export function onOverview(s: QueueState): { state: QueueState } {
	return { state: { ...s, queue: [], pinnedId: null } };
}

/** Manual click / Alt-key: pin the tile (it need not be ready). If a DIFFERENT ready
 *  tile held the center (`displacedId`), it gave up its turn → back of the queue. */
export function onClick(s: QueueState, id: number, displacedId?: number | null): { state: QueueState } {
	let queue = s.queue;
	if (displacedId != null && displacedId !== id && queue.includes(displacedId)) {
		queue = [...queue.filter((x) => x !== displacedId), displacedId];
	}
	return { state: { ...s, queue, pinnedId: id } };
}
