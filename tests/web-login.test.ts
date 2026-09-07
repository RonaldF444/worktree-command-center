import { describe, it, expect } from 'vitest';
import { describeAuthFailure, guessDeviceLabel } from '../src/web/login';

describe('describeAuthFailure', () => {
	it('maps known server errors to friendly copy and everything else to a generic line', () => {
		expect(describeAuthFailure('invalid password')).toBe('Wrong password.');
		expect(describeAuthFailure('too many attempts -- try again later')).toBe('Too many attempts. Wait 15 minutes and try again.');
		expect(describeAuthFailure('no password set')).toBe('No password is set yet. Set one in the desktop app (📱 panel).');
		expect(describeAuthFailure('device revoked')).toBe('This device was signed out from the desktop.');
		expect(describeAuthFailure('not connected')).toBe('Not connected to the desktop. Retrying…');
		expect(describeAuthFailure('C:\\secret\\path')).toBe('Login failed.');
		expect(describeAuthFailure(undefined)).toBe('Login failed.');
	});
});
describe('guessDeviceLabel', () => {
	it('names the OS + browser roughly', () => {
		expect(guessDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('Windows · Chrome');
		expect(guessDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15')).toBe('Mac · Safari');
		expect(guessDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
		expect(guessDeviceLabel('')).toBe('Browser');
	});
});
