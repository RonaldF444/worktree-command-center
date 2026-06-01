import { describe, it, expect } from 'vitest';
import { planDeliveries, tail, enqueueWaiting, looksLikePrompt } from '../src/terminals/chat-room';

describe('planDeliveries', () => {
  it('delivers a post to the other members and spends one round', () => {
    const r = planDeliveries({ ts: 1, terminal: 'A', message: 'hi' }, ['A', 'B'], 3);
    expect(r.deliveries).toEqual([{ to: 'B', text: '[chat from A] hi' }]);
    expect(r.budget).toBe(2);
  });
  it('delivers to all members except the author', () => {
    const r = planDeliveries({ ts: 1, terminal: 'A', message: 'x' }, ['A', 'B', 'C'], 3);
    expect(r.deliveries.map((d) => d.to).sort()).toEqual(['B', 'C']);
    expect(r.budget).toBe(2);
  });
  it('never delivers the user broadcast (you) and never spends budget on it', () => {
    const r = planDeliveries({ ts: 1, terminal: 'you', message: 'go' }, ['A', 'B'], 3);
    expect(r.deliveries).toEqual([]);
    expect(r.budget).toBe(3);
  });
  it('no-op when budget is exhausted', () => {
    const r = planDeliveries({ ts: 1, terminal: 'A', message: 'x' }, ['A', 'B'], 0);
    expect(r.deliveries).toEqual([]);
    expect(r.budget).toBe(0);
  });
  it('no delivery + no spend when the author is the only member', () => {
    const r = planDeliveries({ ts: 1, terminal: 'A', message: 'x' }, ['A'], 3);
    expect(r.deliveries).toEqual([]);
    expect(r.budget).toBe(3);
  });
});

describe('tail', () => {
  it('returns only new non-blank lines and the running count', () => {
    const a = tail(0, '1\tA\thi\n2\tB\tyo\n');
    expect(a.count).toBe(2);
    expect(a.posts).toHaveLength(2);
    const b = tail(2, '1\tA\thi\n2\tB\tyo\n3\tA\tok\n');
    expect(b.count).toBe(3);
    expect(b.posts).toHaveLength(1);
    expect(b.posts[0]).toEqual({ ts: 3, terminal: 'A', message: 'ok' });
  });
  it('ignores blank lines so the trailing newline never shifts the index', () => {
    expect(tail(0, '\n\n').count).toBe(0);
  });
});

describe('enqueueWaiting', () => {
  it('appends new names and dedups', () => {
    expect(enqueueWaiting([], 'A')).toEqual(['A']);
    expect(enqueueWaiting(['A'], 'A')).toEqual(['A']);
    expect(enqueueWaiting(['A'], 'B')).toEqual(['A', 'B']);
  });
});

describe('looksLikePrompt', () => {
  // A card exists to answer a BLOCKING permission/confirm menu in the agent's terminal
  // (the user must send a keystroke to unblock it). A plain conversational question is
  // just chat — the user replies in the chat box, no card. So ONLY the real permission-
  // menu signature counts; a bare "?" or a numbered list in prose must NOT fire.
  it('detects a real permission / confirm prompt', () => {
    expect(looksLikePrompt('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBe(true);
    expect(looksLikePrompt('Allow this command?\n❯ 1. Yes\n  2. No, tell Claude what to do')).toBe(true);
    expect(looksLikePrompt('Continue? (y/n)')).toBe(true);
    expect(looksLikePrompt('Bash command requires approval to run')).toBe(true);
  });
  it('does NOT fire on conversation that merely contains a question or a list', () => {
    // Conversational messages that must NOT be mistaken for a prompt:
    expect(looksLikePrompt('is the uncommitted work in the predictor PRIMARY yours?')).toBe(false);
    expect(looksLikePrompt('@Improver 1 what are you touching? and roughly how long?')).toBe(false);
    expect(looksLikePrompt('which model should I use?')).toBe(false);
    expect(looksLikePrompt('choose: 1) fast  2) safe')).toBe(false); // prose list, not a Yes/No menu
  });
  it('ignores normal output', () => {
    expect(looksLikePrompt('Running the eval now, this will take a bit.')).toBe(false);
    expect(looksLikePrompt('Done. Results saved to ab_results/run.log')).toBe(false);
  });
});
