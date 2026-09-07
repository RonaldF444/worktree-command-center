import { describe, it, expect } from 'vitest';
import { parseRemoteAction, MAX_INPUT, KANE_ID } from '../electron/remote-actions';
import { parseTileInvoke, FORWARDED_CHANNELS, MAX_WRITE } from '../electron/remote-actions';

describe('parseRemoteAction — mirror actions (center / workspace)', () => {
	it('accepts centering a real tile', () => {
		expect(parseRemoteAction({ type: 'center', id: 4 })).toEqual({ type: 'center', id: 4 });
		expect(parseRemoteAction({ type: 'center', id: 0 })).toEqual({ type: 'center', id: 0 });
	});
	it('refuses to centre Kane — he is a side console on the desk, not a stage tile', () => {
		expect(parseRemoteAction({ type: 'center', id: KANE_ID })).toBeNull();
	});
	it('rejects malformed centre targets', () => {
		expect(parseRemoteAction({ type: 'center', id: -2 })).toBeNull();
		expect(parseRemoteAction({ type: 'center', id: 1.5 })).toBeNull();
		expect(parseRemoteAction({ type: 'center' })).toBeNull();
		expect(parseRemoteAction({ type: 'center', id: '3' })).toBeNull();
	});
	it('accepts a workspace switch, trimmed', () => {
		expect(parseRemoteAction({ type: 'workspace', id: ' cardtsar ' })).toEqual({ type: 'workspace', id: 'cardtsar' });
	});
	it('rejects an empty, blank or non-string workspace id', () => {
		expect(parseRemoteAction({ type: 'workspace', id: '   ' })).toBeNull();
		expect(parseRemoteAction({ type: 'workspace', id: '' })).toBeNull();
		expect(parseRemoteAction({ type: 'workspace', id: 7 })).toBeNull();
		expect(parseRemoteAction({ type: 'workspace' })).toBeNull();
	});
});

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
	it('accepts input addressed to Kane (KANE_ID) and still validates the name', () => {
		expect(parseRemoteAction({ type: 'input', id: KANE_ID, text: ' ping Kane ', name: 'Kane' }))
			.toEqual({ type: 'input', id: KANE_ID, text: 'ping Kane', name: 'Kane' });
		expect(parseRemoteAction({ type: 'input', id: KANE_ID, text: 'hi' })).toBeNull(); // missing name
		expect(parseRemoteAction({ type: 'input', id: KANE_ID, text: 'hi', name: '   ' })).toBeNull(); // blank name
	});
	it('rejects input targeting an id below Kane\'s — only KANE_ID itself is the negative exception', () => {
		expect(parseRemoteAction({ type: 'input', id: KANE_ID - 1, text: 'hi', name: 'alpha' })).toBeNull();
	});
	it('rejects a remote toggle targeting Kane — he has no Claude-remote-control toggle', () => {
		expect(parseRemoteAction({ type: 'remote', id: KANE_ID })).toBeNull();
	});
	it('rejects malformed, unknown and oversized actions', () => {
		expect(parseRemoteAction(null)).toBeNull();
		expect(parseRemoteAction('hi')).toBeNull();
		expect(parseRemoteAction({ type: 'nope', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: '   ', name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1.5, text: 'hi', name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1, text: 'x'.repeat(MAX_INPUT + 1), name: 'alpha' })).toBeNull();
		expect(parseRemoteAction({ type: 'input', id: 1 })).toBeNull();
		expect(parseRemoteAction({ type: 'spawn', repo: '', task: 'x' })).toBeNull();
		expect(parseRemoteAction({ type: 'remote', id: 'x' })).toBeNull();
	});
});

describe('parseTileInvoke', () => {
	it('accepts the payload-less channels with any payload', () => {
		expect(parseTileInvoke('floor:state', undefined)).toEqual({ channel: 'floor:state' });
		expect(parseTileInvoke('board:get', { junk: 1 })).toEqual({ channel: 'board:get' });
		expect(parseTileInvoke('kane:snapshot', null)).toEqual({ channel: 'kane:snapshot' });
	});
	it('validates id channels: non-negative integers only, never Kane', () => {
		for (const ch of ['tile:snapshot', 'tile:center', 'tile:hide', 'tile:show', 'tile:kill'] as const) {
			expect(parseTileInvoke(ch, { id: 3 })).toEqual({ channel: ch, id: 3 });
			expect(parseTileInvoke(ch, { id: -1 })).toBeNull();
			expect(parseTileInvoke(ch, { id: 1.5 })).toBeNull();
			expect(parseTileInvoke(ch, { id: '3' })).toBeNull();
			expect(parseTileInvoke(ch, {})).toBeNull();
		}
		expect(parseTileInvoke('tile:center', { id: KANE_ID })).toBeNull();
	});
	it('caps tile:write and kane:write data', () => {
		expect(parseTileInvoke('tile:write', { id: 1, data: 'ls\r' })).toEqual({ channel: 'tile:write', id: 1, data: 'ls\r' });
		expect(parseTileInvoke('tile:write', { id: 1, data: '' })).toBeNull();
		expect(parseTileInvoke('tile:write', { id: 1, data: 'x'.repeat(MAX_WRITE + 1) })).toBeNull();
		expect(parseTileInvoke('kane:write', { data: 'hi\r' })).toEqual({ channel: 'kane:write', data: 'hi\r' });
		expect(parseTileInvoke('kane:write', { data: 5 })).toBeNull();
	});
	it('trims and caps rename', () => {
		expect(parseTileInvoke('tile:rename', { id: 2, name: '  api  ' })).toEqual({ channel: 'tile:rename', id: 2, name: 'api' });
		expect(parseTileInvoke('tile:rename', { id: 2, name: '   ' })).toBeNull();
		expect(parseTileInvoke('tile:rename', { id: 2, name: 'x'.repeat(81) })).toBeNull();
	});
	it('spawn requires repo + task; optional fields normalize to null', () => {
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 'do it' })).toEqual({ channel: 'tile:spawn', repo: 'r', base: null, task: 'do it', model: null, effort: null, name: null });
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 'do it', base: 'main', model: 'claude-opus-4-8', effort: 'high', name: 'n' }))
			.toEqual({ channel: 'tile:spawn', repo: 'r', base: 'main', task: 'do it', model: 'claude-opus-4-8', effort: 'high', name: 'n' });
		expect(parseTileInvoke('tile:spawn', { repo: '', task: 't' })).toBeNull();
		expect(parseTileInvoke('tile:spawn', { repo: 'r' })).toBeNull();
		expect(parseTileInvoke('tile:spawn', { repo: 'r', task: 't', effort: 'silly' })).toBeNull();
	});
	it('workspace:switch needs a non-empty string id', () => {
		expect(parseTileInvoke('workspace:switch', { id: ' ws-2 ' })).toEqual({ channel: 'workspace:switch', id: 'ws-2' });
		expect(parseTileInvoke('workspace:switch', { id: '' })).toBeNull();
	});
	it('rejects unknown channels and lists the forwarded set', () => {
		expect(parseTileInvoke('config:set', {})).toBeNull();
		expect([...FORWARDED_CHANNELS].sort()).toEqual(['board:get', 'floor:state', 'kane:snapshot', 'kane:write', 'tile:center', 'tile:hide', 'tile:kill', 'tile:rename', 'tile:show', 'tile:snapshot', 'tile:spawn', 'tile:write', 'workspace:switch']);
	});
});
