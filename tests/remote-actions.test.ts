import { describe, it, expect } from 'vitest';
import { parseRemoteAction, MAX_INPUT } from '../electron/remote-actions';

describe('parseRemoteAction', () => {
	it('accepts a remote toggle', () => {
		expect(parseRemoteAction({ type: 'remote', id: 3 })).toEqual({ type: 'remote', id: 3 });
	});
	it('accepts a spawn, trimming fields and nulling a blank base', () => {
		expect(parseRemoteAction({ type: 'spawn', repo: ' sargent ', base: '   ', task: ' do it ' }))
			.toEqual({ type: 'spawn', repo: 'sargent', base: null, task: 'do it' });
	});
	it('accepts input and trims it', () => {
		expect(parseRemoteAction({ type: 'input', id: 0, text: '  ship it  ' }))
			.toEqual({ type: 'input', id: 0, text: 'ship it' });
	});
	it('collapses CR/LF so a dictated newline cannot submit early or split the message', () => {
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'one\r\ntwo\nthree' }))
			.toEqual({ type: 'input', id: 1, text: 'one two three' });
	});
	it('rejects malformed, unknown and oversized actions', () => {
		expect(parseRemoteAction(null)).toBeNull();
		expect(parseRemoteAction('hi')).toBeNull();
		expect(parseRemoteAction({ type: 'nope', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: '   ' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: -1, text: 'hi' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1.5, text: 'hi' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'x'.repeat(MAX_INPUT + 1) })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'spawn', repo: '', task: 'x' })).toBeNull();
		expect(parseRemoteAction({ type: 'remote', id: 'x' })).toBeNull();
	});
});
