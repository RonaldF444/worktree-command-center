import { describe, it, expect } from 'vitest';
import { isTailscaleIp, pickHosts, accessUrls, httpsUrlFor, hasServeHandlerFor } from '../electron/remote-net';
import { tailscaleIps, browserUrls } from '../electron/remote-net';

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
  it('builds token URLs per host under /phone', () => {
    expect(accessUrls(['100.92.3.4', 'mybox'], 7420, 'abcd')).toEqual([
      'http://100.92.3.4:7420/phone?t=abcd', 'http://mybox:7420/phone?t=abcd',
    ]);
  });
});
describe('httpsUrlFor', () => {
  it('points at /phone and strips the trailing dot', () => {
    expect(httpsUrlFor('box.tail.ts.net.', 'tok')).toBe('https://box.tail.ts.net/phone?t=tok');
    expect(httpsUrlFor(null, 'tok')).toBeNull();
  });
});
describe('tailscaleIps / browserUrls', () => {
  it('returns only the CGNAT-range IPv4s', () => {
    expect(tailscaleIps({ eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }], ts0: [{ family: 'IPv4', address: '100.92.3.4', internal: false }] } as any)).toEqual(['100.92.3.4']);
    expect(tailscaleIps({} as any)).toEqual([]);
  });
  it('builds plain browser URLs', () => {
    expect(browserUrls(['127.0.0.1', '100.92.3.4'], 7420)).toEqual(['http://127.0.0.1:7420/', 'http://100.92.3.4:7420/']);
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
