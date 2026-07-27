/** Pure theme-list logic for the shell theme switcher (see the 2026-07-24 themes spec).
 *  Olympus/Hades are ported from Sargent's report themes; Iris is WCC's own vibrant
 *  violet/neon addition (replaced the retired Olis, 2026-07-24). 'default' is WCC's
 *  original Forge & River look and MUST stay first (it is the boot fallback). */

export interface ThemeOption { id: string; label: string; }

export const THEMES: ThemeOption[] = [
	{ id: 'default', label: 'Default' },
	{ id: 'olympus', label: 'Olympus' },
	{ id: 'hades', label: 'Hades' },
	{ id: 'iris', label: 'Iris' },
];

/** Persisted config value → a known theme id ('default' for anything unknown,
 *  including the retired 'olis'). */
export function normalizeTheme(raw: unknown): string {
	return THEMES.some((t) => t.id === raw) ? (raw as string) : 'default';
}

/** xterm ITheme-shaped color set (kept structural so this module stays dependency-free). */
export interface TerminalPalette { [key: string]: string; }

/** The classic dark well — the pre-themes hardcoded xterm background. */
const CLASSIC_WELL: TerminalPalette = { background: '#0e0f17' };

/** Olympus: true paper terminals — white wells, black text, and the 16 ANSI colors
 *  re-picked for a light background (the TUI's white/brightWhite text must go DARK
 *  or it vanishes on paper). */
const OLYMPUS_TERMINAL: TerminalPalette = {
	background: '#ffffff',
	foreground: '#0b0b0b',
	cursor: '#0b0b0b',
	cursorAccent: '#ffffff',
	selectionBackground: '#ffde2e',
	black: '#0b0b0b',
	red: '#d21e12',
	green: '#0a8a3f',
	yellow: '#a87b00',
	blue: '#2b5cff',
	magenta: '#b8258f',
	cyan: '#0e7490',
	white: '#3a3a3a',
	brightBlack: '#5a5a5a',
	brightRed: '#ff3a2f',
	brightGreen: '#0caa4d',
	brightYellow: '#b8930a',
	brightBlue: '#2b5cff',
	brightMagenta: '#d63bb0',
	brightCyan: '#0891b2',
	brightWhite: '#0b0b0b',
};

/** Iris: light lavender wells with deep-violet (non-white) text and a neon cursor —
 *  the 16 ANSI colors re-picked violet-tinted and light-safe (2026-07-27 request). */
const IRIS_TERMINAL: TerminalPalette = {
	background: '#f7f2ff',
	foreground: '#3b1d66',
	cursor: '#ff4fd8',
	cursorAccent: '#f7f2ff',
	selectionBackground: '#e3d0ff',
	black: '#2a1245',
	red: '#c81e5f',
	green: '#0e8a63',
	yellow: '#a3690a',
	blue: '#5333d6',
	magenta: '#b31fa8',
	cyan: '#0d7d9e',
	white: '#5c4485',
	brightBlack: '#7a5fa8',
	brightRed: '#e83a7c',
	brightGreen: '#12a578',
	brightYellow: '#c07d0e',
	brightBlue: '#6d47ff',
	brightMagenta: '#d63bc4',
	brightCyan: '#1195bd',
	brightWhite: '#2a1245',
};

/** Per-theme xterm colors; null = keep the classic dark well (default, hades). */
export function terminalPaletteFor(id: string): TerminalPalette | null {
	if (id === 'olympus') return OLYMPUS_TERMINAL;
	if (id === 'iris') return IRIS_TERMINAL;
	return null;
}

// Module-level active theme: terminals are created from many places (tiles, Kane,
// restores), so they read the palette here instead of threading it through every dep.
let activeTheme = 'default';

export function setActiveTheme(id: string): void {
	activeTheme = normalizeTheme(id);
}

/** The palette new terminals should be constructed with right now. */
export function activeTerminalPalette(): TerminalPalette {
	return terminalPaletteFor(activeTheme) ?? CLASSIC_WELL;
}

/** xterm font-weight/contrast options per theme. Light wells (olympus/iris) render thin
 *  glyphs faintly, so they get a heavier face + a minimum contrast floor — the contrast
 *  floor also keeps text readable where the TUI paints its own dark-theme colors. */
export interface TerminalFont { fontWeight: 'normal' | 'bold' | number; fontWeightBold: 'normal' | 'bold' | number; minimumContrastRatio: number; }

const LIGHT_FONT: TerminalFont = { fontWeight: 600, fontWeightBold: 900, minimumContrastRatio: 3 };
const DARK_FONT: TerminalFont = { fontWeight: 'normal', fontWeightBold: 'bold', minimumContrastRatio: 1 };

export function activeTerminalFont(): TerminalFont {
	return activeTheme === 'olympus' || activeTheme === 'iris' ? LIGHT_FONT : DARK_FONT;
}
