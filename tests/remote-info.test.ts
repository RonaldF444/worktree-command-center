import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeRemoteInfo, removeRemoteInfo } from '../electron/remote-info';

describe('writeRemoteInfo', () => {
  let dir: string; let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-remote-')); file = path.join(dir, 'nested', 'remote.json'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates the parent directory and writes the exact { url, token } shape', () => {
    writeRemoteInfo(file, { url: 'http://127.0.0.1:7420', token: 'abc123' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ url: 'http://127.0.0.1:7420', token: 'abc123' });
  });

  it('overwrites a previous file rather than appending', () => {
    writeRemoteInfo(file, { url: 'http://127.0.0.1:7420', token: 'first' });
    writeRemoteInfo(file, { url: 'http://127.0.0.1:7421', token: 'second' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ url: 'http://127.0.0.1:7421', token: 'second' });
  });

  it('does not throw when the path cannot be written (e.g. a parent segment is a file)', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const unwritable = path.join(blocker, 'remote.json');
    expect(() => writeRemoteInfo(unwritable, { url: 'http://127.0.0.1:7420', token: 'x' })).not.toThrow();
    expect(fs.existsSync(unwritable)).toBe(false);
  });
});

describe('removeRemoteInfo', () => {
  let dir: string; let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-remote-')); file = path.join(dir, 'remote.json'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('deletes the file', () => {
    writeRemoteInfo(file, { url: 'http://127.0.0.1:7420', token: 'x' });
    removeRemoteInfo(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is a no-op, not a throw, when the file was never written', () => {
    expect(() => removeRemoteInfo(file)).not.toThrow();
  });
});
