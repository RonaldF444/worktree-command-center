/** Ring of raw PTY output chunks, capped by total characters. A browser that attaches late
 *  gets `snapshot()` first, then the live stream — so this is the only scrollback a remote
 *  viewer ever sees. Pure; no DOM, no Node. */
export class ReplayBuffer {
	private chunks: string[] = [];
	private total = 0;
	constructor(private maxChars = 2_000_000) {}

	push(chunk: string): void {
		if (!chunk) return;
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total > this.maxChars && this.chunks.length > 1) {
			this.total -= this.chunks[0]!.length;
			this.chunks.shift();
		}
		if (this.total > this.maxChars) { // a single giant chunk: keep only its tail
			const c = this.chunks[0]!;
			this.chunks[0] = c.slice(c.length - this.maxChars);
			this.total = this.maxChars;
		}
	}

	snapshot(): string { return this.chunks.join(''); }
	clear(): void { this.chunks = []; this.total = 0; }
	get length(): number { return this.total; }
}
