import { describe, it, expect } from 'vitest';
import { isTailscaleIp, pickHosts, accessUrls, httpsUrlFor, hasServeHandlerFor } from '../electron/remote-net';

describe('isTailscaleIp', () => {
  it('detects the 100.64.0.0/10 range', () => {
    expect(isTailscaleIp('100.92.3.4')).toBe(true);
    expect(isTailscaleIp('100.64.0.1')).toBe(true);
    expect(isTailscaleIp('100.127.255.255')).toBe(true);
    expect(isTailscaleIp('100.63.0.1')).toBe(false);
    expect(isTailscaleIp('192.168.1.5')).toBe(false);
  });
});

describe('pickHosts', () => {
  const ifaces = {
    eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    ts0: [{ family: 'IPv4', address: '100.92.3.4', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  } as any;
  it('lists the Tailscale IP first, then hostname, then LAN; skips loopback', () => {
    expect(pickHosts(ifaces, 'mybox')).toEqual(['100.92.3.4', 'mybox', '192.168.1.20']);
  });
  it('falls back to hostname + LAN when no tailscale', () => {
    expect(pickHosts({ eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] } as any, 'h')).toEqual(['h', '10.0.0.5']);
  });
});

describe('accessUrls', () => {
  it('builds token URLs per host', () => {
    expect(accessUrls(['100.92.3.4', 'mybox'], 7420, 'abcd')).toEqual([
      'http://100.92.3.4:7420/?t=abcd',
      'http://mybox:7420/?t=abcd',
    ]);
  });
});

describe('httpsUrlFor', () => {
  it('builds the URL and strips the MagicDNS trailing dot', () => {
    expect(httpsUrlFor('desk.tail1234.ts.net.', 'abc123')).toBe('https://desk.tail1234.ts.net/?t=abc123');
  });
  it('works without a trailing dot', () => {
    expect(httpsUrlFor('desk.tail1234.ts.net', 'abc123')).toBe('https://desk.tail1234.ts.net/?t=abc123');
  });
  it('returns null when there is no name — voice is simply unavailable', () => {
    expect(httpsUrlFor(null, 'abc123')).toBeNull();
    expect(httpsUrlFor(undefined, 'abc123')).toBeNull();
    expect(httpsUrlFor('   ', 'abc123')).toBeNull();
  });
});

describe('hasServeHandlerFor', () => {
  it('finds an active proxy handler for the port', () => {
    const status = {
      Web: {
        'desk.tail1234.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } },
        },
      },
    };
    expect(hasServeHandlerFor(status, 7420)).toBe(true);
  });
  it('returns false when serve is configured for a different port', () => {
    const status = {
      Web: {
        'desk.tail1234.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    };
    expect(hasServeHandlerFor(status, 7420)).toBe(false);
  });
  it('returns false when serve has never been configured', () => {
    expect(hasServeHandlerFor({}, 7420)).toBe(false);
    expect(hasServeHandlerFor(null, 7420)).toBe(false);
    expect(hasServeHandlerFor(undefined, 7420)).toBe(false);
  });
});
