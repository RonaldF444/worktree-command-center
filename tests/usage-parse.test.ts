import { describe, it, expect } from 'vitest';
import { parseUsage } from '../src/terminals/usage-parse';

// Spaced form, close to how /usage renders.
const SPACED = [
  'Current session  ██████▍ 28% used   Resets 3:50am (America/New_York)',
  'Current week (all models)  ███ 6% used   Resets Jun 15, 12am (America/New_York)',
  'Current week (Sonnet only) ▌ 1% used  Resets Jun 14, 11:59pm (America/New_York)',
  'Current week (Fable)  ██▌ 12% used   Resets Jun 15, 12am (America/New_York)',
  'Usage credits  ██████████▎ 92% used   $13.88 / $15.00 spent · Resets Jul 1 (America/New_York)',
].join('\n');

// Verbatim from a real stripped TUI capture: cell-positioned redraws can drop characters
// mid-word in the Fable region ("Rests", "Amerca") — parsing must tolerate it.
const REAL_FABLE =
  'Current session███████████████████████████████████████▌79%usedResets 1:40pm (America/New_York)' +
  'Current week (all models) ███████████████████████████ 54% usedResets Jul 20, 12am (America/New_York)\n' +
  'Current week (Fable)███████████████████████████████████▌               71% used                  Rests Jul 20, 12am (Amerca/New_York)';

// Collapsed form, like a stripped TUI buffer where spacing escapes were removed.
const COLLAPSED =
  'Currentsession██▍28%usedResets3:50am(America/New_York)Currentweek(allmodels)███6%usedResetsJun15,12am(America/New_York)Currentweek(Sonetnly)▌1%usedResetsJun14';

// Verbatim tail of a real v2.1.227 capture (2026-08-11): the Fable row's label arrives
// sliced by a cell-positioned redraw — no "Current week (" prefix, no "% used" suffix —
// and a promo line sits between the week row and the Fable fragment.
const TRUNCATED_FABLE =
  'Currentsession██████████              20%usedResets 12:40pm (America/New_York)\n' +
  'Currentweek(allmodels)██████████████████████████████60%usedResets Aug17,12am(America/New_York)+50% weekly limits promo through Aug19·clau.de/cc-50-promoFable)██████▌73\n' +
  "What'scontributingtoyourlimitsusage?";

describe('parseUsage', () => {
  it('extracts session + weekly + credits from the spaced form', () => {
    const r = parseUsage(SPACED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am (America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun 15, 12am (America/New_York)');
    expect(r.creditsPct).toBe(92);
    expect(r.creditsSpent).toBe('$13.88 / $15.00');
    expect(r.creditsReset).toBe('Jul 1 (America/New_York)');
  });
  it('is tolerant of collapsed spacing', () => {
    const r = parseUsage(COLLAPSED);
    expect(r.sessionPct).toBe(28);
    expect(r.sessionReset).toBe('3:50am(America/New_York)');
    expect(r.weekPct).toBe(6);
    expect(r.weekReset).toBe('Jun15,12am(America/New_York)');
  });
  it('does not confuse the Sonnet-only week with the all-models week', () => {
    expect(parseUsage(SPACED).weekPct).toBe(6); // not 1
  });
  it('extracts the Fable week without confusing the other sections', () => {
    const r = parseUsage(SPACED);
    expect(r.fablePct).toBe(12);
    expect(r.fableReset).toBe('Jun 15, 12am (America/New_York)');
    expect(r.weekPct).toBe(6);   // not 12
    expect(r.sessionPct).toBe(28);
  });
  it('parses a real capture where the Fable region stripped dirty ("Rests"/"Amerca")', () => {
    const r = parseUsage(REAL_FABLE);
    expect(r.sessionPct).toBe(79);
    expect(r.weekPct).toBe(54);
    expect(r.fablePct).toBe(71);
    expect(r.fableReset).toBe('Jul 20, 12am (Amerca/New_York)');
  });
  it('parses the v2.1.227 sliced-label Fable row ("Fable)██▌73" with no "% used")', () => {
    const r = parseUsage(TRUNCATED_FABLE);
    expect(r.sessionPct).toBe(20);
    expect(r.weekPct).toBe(60);
    expect(r.fablePct).toBe(73); // NOT 50 from the promo line before the Fable fragment
  });
  it('a promo percentage before a missing Fable row does not fake a Fable readout', () => {
    const noFable =
      'Currentsession██▍28%usedResets3:50am(America/New_York)' +
      'Currentweek(allmodels)███6%usedResetsJun15,12am(America/New_York)+50% weekly limits promo through Aug19';
    expect(parseUsage(noFable).fablePct).toBeNull();
  });
  it('returns nulls for junk, never throws', () => {
    const empty = { sessionPct: null, sessionReset: null, weekPct: null, weekReset: null, fablePct: null, fableReset: null, creditsPct: null, creditsSpent: null, creditsReset: null };
    expect(parseUsage('nothing useful here')).toEqual(empty);
    expect(parseUsage('')).toEqual(empty);
  });
});
