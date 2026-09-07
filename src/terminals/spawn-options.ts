/** Toolbar dropdown options for new terminals — pure so the browser bundle can share them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

// Model options for the spawn toolbar dropdown. Empty value = inherit the claude CLI default.
export const SPAWN_MODELS: { label: string; value: string }[] = [
	{ label: 'Model: Default', value: '' },
	{ label: 'Opus 4.8', value: 'claude-opus-4-8' },
	{ label: 'Sonnet 5', value: 'claude-sonnet-5' },
	{ label: 'Fable 5', value: 'claude-fable-5' },
	{ label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
];

// Effort options for the spawn toolbar dropdown. Empty value = inherit the claude CLI default.
export const SPAWN_EFFORTS: { label: string; value: string }[] = [
	{ label: 'Effort: Default', value: '' },
	...EFFORT_LEVELS.map((l) => ({ label: l === 'xhigh' ? 'XHigh' : l[0]!.toUpperCase() + l.slice(1), value: l })),
];
