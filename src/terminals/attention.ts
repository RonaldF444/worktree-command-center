import { looksLikePrompt } from './chat-room';
import { looksLikeMenu, looksErrored } from './prompt-detect';

export type AttentionState = 'prompt' | 'menu' | 'errored' | 'idle';
export interface AttentionInput { id: number; name: string; repo: string; output: string; idle: boolean; }
export interface AttentionItem { id: number; name: string; repo: string; state: AttentionState; }

const RANK: Record<AttentionState, number> = { prompt: 0, menu: 1, errored: 2, idle: 3 };

/** Classify tiles by precedence prompt > menu > errored > idle; drop tiles with nothing to
 *  flag (busy + clean). Sorted by precedence, then id. */
export function classifyAttention(tiles: AttentionInput[]): AttentionItem[] {
	const out: AttentionItem[] = [];
	for (const t of tiles) {
		let state: AttentionState | null = null;
		if (looksLikePrompt(t.output)) state = 'prompt';
		else if (looksLikeMenu(t.output)) state = 'menu';
		else if (looksErrored(t.output)) state = 'errored';
		else if (t.idle) state = 'idle';
		if (state) out.push({ id: t.id, name: t.name, repo: t.repo, state });
	}
	return out.sort((a, b) => RANK[a.state] - RANK[b.state] || a.id - b.id);
}

/** Items that count toward the badge — everything except idle. */
export function actionCount(items: AttentionItem[]): number {
	return items.filter((i) => i.state !== 'idle').length;
}
