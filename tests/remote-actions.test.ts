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
		expect(parseRemoteAction({ type: 'input', id: 0, text: '  ship it  ', name: 'alpha' }))
			.toEqual({ type: 'input', id: 0, text: 'ship it', name: 'alpha' });
	});
	it('collapses CR/LF so a dictated newline cannot submit early or split the message', () => {
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'one\r\ntwo\nthree', name: 'alpha' }))
			.toEqual({ type: 'input', id: 1, text: 'one two three', name: 'alpha' });
	});
	it('accepts input with a name and trims the name too', () => {
		expect(parseRemoteAction({ type: 'input', id: 2, text: 'hi', name: '  alpha  ' }))
			.toEqual({ type: 'input', id: 2, text: 'hi', name: 'alpha' });
	});
	it('rejects input missing a name — tile ids are workspace-scoped, so no name means no safe target', () => {
		expect(parseRemoteAction({ type: 'input', id: 2, text: 'hi' })).toBeNull();
	});
	it('rejects input with an empty name', () => {
		expect(parseRemoteAction({ type: 'input', id: 2, text: 'hi', name: '' })).toBeNull();
	});
	it('rejects input with a whitespace-only name', () => {
		expect(parseRemoteAction({ type: 'input', id: 2, text: 'hi', name: '   ' })).toBeNull();
	});
	it('rejects input whose name is not a string', () => {
		expect(parseRemoteAction({ type: 'input', id: 2, text: 'hi', name: 42 })).toBeNull();
	});
	it('rejects malformed, unknown and oversized actions', () => {
		expect(parseRemoteAction(null)).toBeNull();
		expect(parseRemoteAction('hi')).toBeNull();
		expect(parseRemoteAction({ type: 'nope', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: '   ', name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: -1, text: 'hi', name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1.5, text: 'hi', name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'x'.repeat(MAX_INPUT + 1), name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'spawn', repo: '', task: 'x' })).toBeNull();
		expect(parseRemoteAction({ type: 'remote', id: 'x' })).toBeNull();
	});
});
