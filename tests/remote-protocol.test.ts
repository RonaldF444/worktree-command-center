import { describe, it, expect } from 'vitest';
import { parseClientFrame, MAX_FRAME_BYTES, DEVICE_REVOKED_ERROR, SLOW_CONSUMER_CLOSE_CODE, DEVICE_REVOKED_CLOSE_CODE, WS_PATH } from '../electron/remote/protocol';

describe('parseClientFrame', () => {
	it('parses an invoke with and without payload', () => {
		expect(parseClientFrame('{"t":"invoke","id":"1","channel":"floor:state"}')).toEqual({ t: 'invoke', id: '1', channel: 'floor:state' });
		expect(parseClientFrame('{"t":"invoke","id":"2","channel":"tile:write","payload":{"id":1,"data":"x"}}'))
			.toEqual({ t: 'invoke', id: '2', channel: 'tile:write', payload: { id: 1, data: 'x' } });
	});
	it('rejects an invoke missing id or channel', () => {
		expect(parseClientFrame('{"t":"invoke","channel":"x"}')).toBeNull();
		expect(parseClientFrame('{"t":"invoke","id":"1"}')).toBeNull();
		expect(parseClientFrame('{"t":"invoke","id":1,"channel":"x"}')).toBeNull();
	});
	it('parses auth with only the string fields present', () => {
		expect(parseClientFrame('{"t":"auth","password":"p","deviceLabel":"L","junk":1}')).toEqual({ t: 'auth', password: 'p', deviceLabel: 'L' });
		expect(parseClientFrame('{"t":"auth","deviceToken":"tok"}')).toEqual({ t: 'auth', deviceToken: 'tok' });
		expect(parseClientFrame('{"t":"auth","password":5}')).toEqual({ t: 'auth' });
	});
	it('parses ping', () => {
		expect(parseClientFrame('{"t":"ping"}')).toEqual({ t: 'ping' });
	});
	it('returns null for garbage, arrays, primitives, unknown t', () => {
		expect(parseClientFrame('not json')).toBeNull();
		expect(parseClientFrame('[]')).toBeNull();
		expect(parseClientFrame('"str"')).toBeNull();
		expect(parseClientFrame('null')).toBeNull();
		expect(parseClientFrame('{"t":"nope"}')).toBeNull();
		expect(parseClientFrame('{}')).toBeNull();
	});
});

describe('constants', () => {
	it('pins the wire constants', () => {
		expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
		expect(DEVICE_REVOKED_ERROR).toBe('device revoked');
		expect(SLOW_CONSUMER_CLOSE_CODE).toBe(4008);
		expect(DEVICE_REVOKED_CLOSE_CODE).toBe(4009);
		expect(WS_PATH).toBe('/ws');
	});
});
