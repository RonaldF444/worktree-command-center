export interface AutosaveOpts {
	idleMs?: number; // quiet time before a save fires
	maxMs?: number; // ceiling: continuous typing may never outrun disk by more than this
}

/** Debounced save trigger for the journal textarea. schedule() on every keystroke; the save
 *  fires after idleMs of quiet, or maxMs after the oldest unsaved keystroke — whichever comes
 *  first — so a crash can only ever eat the last few seconds of typing. */
export class Autosave {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private oldest: number | null = null;

	constructor(private saveFn: () => void, private opts: AutosaveOpts = {}) {}

	schedule(): void {
		const now = Date.now();
		if (this.oldest === null) this.oldest = now;
		const idle = this.opts.idleMs ?? 1000;
		const max = this.opts.maxMs ?? 10000;
		const due = Math.max(0, Math.min(idle, this.oldest + max - now));
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.fire(), due);
	}

	/** Save now if anything is pending; no-op otherwise. */
	flush(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.fire();
	}

	/** Drop any pending save without firing it (e.g. the tile switched documents). */
	cancel(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.oldest = null;
	}

	private fire(): void {
		this.timer = null;
		this.oldest = null;
		this.saveFn();
	}
}
