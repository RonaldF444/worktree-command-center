import { describe, it, expect, afterEach } from 'vitest';
import { THEMES, normalizeTheme, terminalPaletteFor, setActiveTheme, activeTerminalPalette, activeTerminalFont } from '../src/terminals/theme-store';

describe('theme-store', () => {
	it('offers the four themes with default first', () => {
		expect(THEMES.map((t) => t.id)).toEqual(['default', 'olympus', 'hades', 'iris']);
		expect(THEMES.every((t) => typeof t.label === 'string' && t.label.length > 0)).toBe(true);
	});
	it('normalizes valid ids to themselves', () => {
		expect(normalizeTheme('olympus')).toBe('olympus');
		expect(normalizeTheme('hades')).toBe('hades');
		expect(normalizeTheme('iris')).toBe('iris');
		expect(normalizeTheme('default')).toBe('default');
	});
	it('normalizes unknown, missing, and retired ids to default', () => {
		expect(normalizeTheme('neon')).toBe('default');
		expect(normalizeTheme('olis')).toBe('default'); // retired 2026-07-24, replaced by iris
		expect(normalizeTheme(undefined)).toBe('default');
		expect(normalizeTheme(42)).toBe('default');
		expect(normalizeTheme('')).toBe('default');
	});
});

describe('terminal palettes', () => {
	afterEach(() => setActiveTheme('default'));

	it('olympus terminals are white with black text', () => {
		const p = terminalPaletteFor('olympus')!;
		expect(p.background).toBe('#ffffff');
		expect(p.foreground).toBe('#0b0b0b');
		expect(p.brightWhite).toBe('#0b0b0b'); // TUI "white" text must stay readable on white
	});
	it('iris terminals are light with non-white text (2026-07-27 request)', () => {
		const p = terminalPaletteFor('iris')!;
		expect(p.background).toBe('#f7f2ff');
		expect(p.foreground).toBe('#3b1d66'); // deep violet, not white
		expect(p.brightWhite).toBe('#2a1245'); // TUI "white" text must darken on a light well
	});
	it('default and hades keep the classic dark well (null palette)', () => {
		expect(terminalPaletteFor('default')).toBeNull();
		expect(terminalPaletteFor('hades')).toBeNull();
	});
	it('activeTerminalPalette follows setActiveTheme and falls back to the classic well', () => {
		expect(activeTerminalPalette()).toEqual({ background: '#0e0f17' });
		setActiveTheme('olympus');
		expect(activeTerminalPalette().background).toBe('#ffffff');
		setActiveTheme('bogus');
		expect(activeTerminalPalette()).toEqual({ background: '#0e0f17' });
	});

	it('light themes get a heavier terminal font; dark themes keep the default weight', () => {
		setActiveTheme('olympus');
		expect(activeTerminalFont()).toEqual({ fontWeight: 600, fontWeightBold: 900, minimumContrastRatio: 3 });
		setActiveTheme('iris');
		expect(activeTerminalFont()).toEqual({ fontWeight: 600, fontWeightBold: 900, minimumContrastRatio: 3 });
		setActiveTheme('default');
		expect(activeTerminalFont()).toEqual({ fontWeight: 'normal', fontWeightBold: 'bold', minimumContrastRatio: 1 });
	});
});
