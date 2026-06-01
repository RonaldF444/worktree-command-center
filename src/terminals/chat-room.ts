import * as fs from 'fs';
import * as path from 'path';
import { parseChatLine, formatChatLine, isChatPost, CHAT_POLL_MS, type ChatPost, type ChatRaw } from './coordination';

export interface Delivery { to: string; text: string; }

/** Decide who a single new chat post is delivered to + the new round budget.
 *  Never echoes to the author, never delivers a `you` broadcast, no-op at budget 0. */
export function planDeliveries(post: ChatPost, memberNames: string[], budget: number): { deliveries: Delivery[]; budget: number } {
	if (budget <= 0 || post.terminal === 'you') return { deliveries: [], budget };
	const deliveries = memberNames
		.filter((n) => n !== post.terminal)
		.map((to) => ({ to, text: `[chat from ${post.terminal}] ${post.message}` }));
	if (deliveries.length === 0) return { deliveries: [], budget };
	return { deliveries, budget: budget - 1 };
}

/** Parse only the chat lines after `prevCount` (blank lines ignored so the
 *  trailing newline never shifts the index). Returns the new posts + total count. */
export function tail(prevCount: number, text: string): { posts: Array<ChatPost | ChatRaw>; count: number } {
	const lines = String(text).split('\n').filter((l) => l.trim().length > 0);
	const posts = lines.slice(prevCount).map(parseChatLine).filter((x): x is ChatPost | ChatRaw => x !== null);
	return { posts, count: lines.length };
}

/** Append a waiting member name unless already queued (dedup, preserve order). */
export function enqueueWaiting(queue: string[], name: string): string[] {
	return queue.includes(name) ? queue : [...queue, name];
}

/** Heuristic: does this terminal output look like it is WAITING for the user's input
 *  (a permission/confirm prompt, a numbered menu, or a trailing question)? Used to
 *  decide whether to surface an idle agent in the chat so you can answer it there. */
export function looksLikePrompt(output: string): boolean {
	const t = String(output);
	// Explicit tool-permission gating Claude Code emits when a tool call is blocked.
	if (/requires approval|grant permission|allow this (command|tool|edit)/i.test(t)) return true;
	// Explicit yes/no prompts.
	if (/\(y\/n\)|\[y\/n\]|\by\/n\b|\byes\/no\b/i.test(t)) return true;
	// Claude's confirm/selection menu: the ❯ cursor sitting on a numbered option, or an
	// explicit "1. Yes / 2. No" pair. A bare "?", a "do you want…" phrase, or a numbered
	// list in prose is NOT a prompt — that's conversation (answered in the chat box, not a
	// card). Matching only the menu signature is what stops conversing agents from each
	// trailing "?" surfacing a phantom approval card every poll.
	if (/❯\s*\d+[.)]/.test(t)) return true;
	if (/\b1[.)]\s*Yes\b/i.test(t) && /\b2[.)]\s*No\b/i.test(t)) return true;
	return false;
}

export interface ChatMember { name: string; sendLine: (t: string) => void; sendKeys: (raw: string) => void; isAlive: () => boolean; recentOutput: () => string; }

/** Drives a moderated chat between member terminals over the group `chat.md`.
 *  Polls the channel; auto-delivers each new agent post into the OTHER members'
 *  inputs under a per-broadcast round budget. */
export class ChatRoom {
	private seen = 0;
	private paused = false; // manual Pause: hold relay (the in-flight agent finishes, then it stops)
	private timer: number | null = null;
	private onChange: (() => void) | null = null;
	private waiting: string[] = [];
	private answeredAt: Record<string, number> = {}; // name → ts of last answer, to avoid re-detecting a stale prompt
	private armedTs = 0; // 0 until the first broadcast — gates pause-for-input so opening/priming never hijacks

	// surfacePrompts=false for bypass-permission groups (e.g. one launched with
	// --dangerously-skip-permissions): no Claude approval prompt ever appears, so an
	// input-request card there is always a phantom — don't detect them at all.
	constructor(private coordDir: string, private members: ChatMember[], private surfacePrompts = true) {}

	private chatPath(): string { return path.join(this.coordDir, 'chat.md'); }
	private readText(): string { try { return fs.readFileSync(this.chatPath(), 'utf8'); } catch { return ''; } }

	setOnChange(cb: () => void): void { this.onChange = cb; }
	get isPaused(): boolean { return this.paused; }
	/** Pause/resume the relay. Pausing lets the in-flight agent finish its current message
	 *  (it's running in its own terminal); its post simply isn't relayed onward, so the
	 *  conversation stops. Resume (or sending a message) starts it flowing again. */
	setPaused(on: boolean): void { this.paused = on; this.onChange?.(); }
	get memberNames(): string[] { return this.members.map((m) => m.name); }

	start(): void {
		// Fresh chat every time: clear the channel so a new room never shows the previous
		// chat's transcript (the coordination board.md is a separate file, untouched).
		try { fs.mkdirSync(this.coordDir, { recursive: true }); fs.writeFileSync(this.chatPath(), '', 'utf8'); } catch { /* best effort */ }
		this.seen = 0;
		this.prime();
		this.timer = window.setInterval(() => this.poll(), CHAT_POLL_MS);
	}

	private prime(): void {
		for (const m of this.members) {
			const others = this.memberNames.filter((n) => n !== m.name).join(', ');
			m.sendLine(`You have joined a live group TEXT CHAT with the user and: ${others}. This chat is your ONLY way to talk to them — your terminal output is NOT visible to them. RULES: (1) Reply to EVERY message here by running: cos-coord chat "<message>". (2) Write like you are TEXTING — ONE or TWO short sentences per message, casual. NO long explanations, NO reports, NO pasted code or command output. If you have a lot to say, send it as a couple of short messages. (3) Do your real work in this terminal as usual, but tell the group the gist via cos-coord chat. (4) When you need a decision or input from the USER, ask briefly via cos-coord chat and wait. Messages from others arrive tagged [chat from <name>]; reply via cos-coord chat. Start with a one-line hello about what you're working on.`);
		}
	}

	broadcast(message: string): void {
		for (const m of this.members) if (m.isAlive()) m.sendLine(message);
		try {
			fs.mkdirSync(this.coordDir, { recursive: true });
			fs.appendFileSync(this.chatPath(), formatChatLine({ ts: Date.now(), terminal: 'you', message }), 'utf8');
		} catch { /* transcript is best-effort */ }
		this.paused = false; // sending a message resumes the conversation
		this.armedTs = Date.now(); // the chat is now active — idle agents may now pause it
		this.onChange?.();
	}

	/** A member went idle. Surface it for in-chat answering ONLY if its screen actually
	 *  shows a prompt waiting for input. Opening/priming and plain done-replying never surface. */
	noteIdle(name: string): void {
		if (!this.surfacePrompts) return;          // bypass-permission group — no real prompts to surface
		if (this.armedTs === 0) return;            // chat not started yet — ignore open/priming idle
		if (!this.memberNames.includes(name)) return;
		if (this.waiting.includes(name)) return;   // already surfaced
		const m = this.members.find((x) => x.name === name);
		if (!m || !looksLikePrompt(m.recentOutput())) return; // only surface a real input prompt
		this.waiting = enqueueWaiting(this.waiting, name);
		this.onChange?.();
	}

	/** ALL members currently showing an input request (each gets its own card in the chat). */
	waitingList(): string[] { return [...this.waiting]; }
	get waitingCount(): number { return this.waiting.length; }

	/** The on-screen prompt (recent output) for a specific waiting member. */
	promptFor(name: string): string {
		const m = this.members.find((x) => x.name === name);
		return m ? m.recentOutput() : '';
	}

	/** Answer ONE waiting member with raw keystrokes (Approve = "\\r", Deny = "\\x1b",
	 *  reply = "<text>\\r"); log a muted line, drop it from the list, resume. */
	respond(name: string, keys: string, label: string): void {
		if (!this.waiting.includes(name)) return;
		const m = this.members.find((x) => x.name === name);
		if (m && m.isAlive()) m.sendKeys(keys);
		try {
			fs.mkdirSync(this.coordDir, { recursive: true });
			fs.appendFileSync(this.chatPath(), formatChatLine({ ts: Date.now(), terminal: '→', message: `${label} ${name}` }), 'utf8');
		} catch { /* transcript best-effort */ }
		this.waiting = this.waiting.filter((n) => n !== name);
		this.answeredAt[name] = Date.now(); // don't immediately re-detect the now-stale prompt
		this.paused = false; // answering resumes the conversation
		this.onChange?.();
	}

	private poll(): void {
		const { posts, count } = tail(this.seen, this.readText());
		this.seen = count;
		let changed = posts.length > 0;
		const names = this.memberNames;
		for (const p of posts) {
			if (!isChatPost(p)) continue;
			if (!names.includes(p.terminal)) continue;            // skip you / → / non-members
			if (this.paused || this.waiting.length > 0) continue; // paused, or awaiting your input: hold relay
			// No round limit — relay every agent post to the other live members until you pause.
			for (const m of this.members) {
				if (m.name !== p.terminal && m.isAlive()) m.sendLine(`[chat from ${p.terminal}] ${p.message}`);
			}
		}
		// Actively surface any member showing an input prompt on screen — don't rely on the
		// idle signal (Claude's permission UI keeps redrawing and may never report idle).
		if (this.armedTs > 0 && this.surfacePrompts) {
			const now = Date.now();
			for (const m of this.members) {
				if (!m.isAlive()) continue;
				if (this.waiting.includes(m.name)) continue;
				if (now - (this.answeredAt[m.name] ?? 0) < 2500) continue; // just answered — let its screen change
				if (looksLikePrompt(m.recentOutput())) { this.waiting = enqueueWaiting(this.waiting, m.name); changed = true; }
			}
		}
		if (changed) this.onChange?.();
	}

	transcript(): Array<ChatPost | ChatRaw> { return tail(0, this.readText()).posts; }

	dispose(): void { if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; } }
}
