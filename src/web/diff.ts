export function diffIds(prev: number[], next: number[]): { added: number[]; removed: number[] } {
	const p = new Set(prev), n = new Set(next);
	return { added: next.filter((id) => !p.has(id)), removed: prev.filter((id) => !n.has(id)) };
}
