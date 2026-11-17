import { describe, expect, it, vi } from 'vitest';

import { PublicHostingReadinessService } from '../src/services/public-hosting-readiness.service.js';
import type { LocalHealthRequest } from '../src/services/application-health-check.service.js';

const dnsTarget = 'demo.example.net';
const suffix = 'apps.' + dnsTarget;
const hostname = 'app-11111111111141118111111111111111.' + suffix;
const hosting = { origin: 'https://' + suffix, hostnameSuffix: suffix, adminSocketPath: undefined,
  publicHosting: { operatorId: 'operator', dnsTarget } };

describe('public hosting readiness', () => {
  it('checks exact DNS against the shared IPv4 and rejects IPv6, split, and stale answers', async () => {
    const ip = '192.0.2.10';
    const dns = {
      resolve4: vi.fn(() => Promise.resolve([ip])),
      resolve6: vi.fn<() => Promise<string[]>>(() => Promise.reject(Object.assign(new Error(), { code: 'ENODATA' }))),
    };
    const readiness = new PublicHostingReadinessService(hosting, dns);
    await expect(readiness.verifyDns(hostname)).resolves.toBeUndefined();
    expect(dns.resolve4.mock.calls).toEqual([[dnsTarget], [hostname]]);
    dns.resolve4.mockResolvedValueOnce([ip]).mockResolvedValueOnce(['192.0.2.11', ip]);
    await expect(readiness.verifyDns(hostname)).rejects.toMatchObject({ code: 'DNS' });
    dns.resolve6.mockImplementationOnce(() => Promise.resolve(['2001:db8::1']));
    await expect(readiness.verifyDns(hostname)).rejects.toMatchObject({ code: 'DNS' });
    dns.resolve6.mockRejectedValueOnce(Object.assign(new Error(), { code: 'ETIMEOUT' }));
    await expect(readiness.verifyDns(hostname)).rejects.toMatchObject({ code: 'DNS' });
  });

  it('rechecks both A records and AAAA after temporary resolver errors', async () => {
    const dns = {
      resolve4: vi.fn<(name: string) => Promise<string[]>>().mockResolvedValue(['192.0.2.10'])
        .mockRejectedValueOnce(Object.assign(new Error(), { code: 'ESERVFAIL' })),
      resolve6: vi.fn<(name: string) => Promise<string[]>>().mockResolvedValue([])
        .mockResolvedValueOnce([]).mockRejectedValueOnce(Object.assign(new Error(), { code: 'ETIMEOUT' })),
    };
    const wait = vi.fn().mockResolvedValue(undefined);
    const progress = vi.fn();
    const readiness = new PublicHostingReadinessService(hosting, dns, undefined, wait);

    await expect(readiness.waitForDns(hostname, progress)).resolves.toBeUndefined();
    expect(dns.resolve4.mock.calls).toEqual([[dnsTarget], [hostname], [dnsTarget], [hostname], [dnsTarget], [hostname]]);
    expect(dns.resolve6.mock.calls).toEqual([[hostname], [hostname], [hostname]]);
    expect(wait.mock.calls).toEqual([[1_000], [2_000]]);
    expect(progress.mock.calls).toEqual([
      ['Public DNS check 1/6 failed (ESERVFAIL). Retrying in 1s.'],
      ['Public DNS check 2/6 failed (ETIMEOUT). Retrying in 2s.'],
      ['Public DNS verified on check 3/6.'],
    ]);
  });

  it('bounds the dashboard DNS check at two attempts and retries only temporary resolver errors', async () => {
    const dns = {
      resolve4: vi.fn<(name: string) => Promise<string[]>>().mockResolvedValue(['192.0.2.10']),
      resolve6: vi.fn<(name: string) => Promise<string[]>>().mockResolvedValue([]),
    };
    const wait = vi.fn().mockResolvedValue(undefined);
    const readiness = new PublicHostingReadinessService(hosting, dns, undefined, wait);
    const failure = Object.assign(new Error(), { code: 'ESERVFAIL' });
    dns.resolve6.mockRejectedValueOnce(failure);
    await expect(readiness.verifyDashboardDns(hostname)).resolves.toBe(true);
    dns.resolve6.mockRejectedValue(failure);
    await expect(readiness.verifyDashboardDns(hostname)).resolves.toBe(false);
    expect(wait.mock.calls).toEqual([[250], [250]]);
    expect(dns.resolve4).toHaveBeenCalledTimes(8);
    expect(dns.resolve6).toHaveBeenCalledTimes(4);
  });

  it.each([
    { reference: ['192.0.2.10'], addresses: ['192.0.2.11'], ipv6Error: 'ESERVFAIL' },
    { referenceError: 'ETIMEOUT', addresses: ['192.0.2.10', '192.0.2.11'] },
    { referenceError: 'ETIMEOUT', addresses: ['192.0.2.10'], ipv6: ['2001:db8::1'] },
    { referenceError: 'ETIMEOUT', addressError: 'ENOTFOUND' },
    { reference: ['192.0.2.10'], addressError: 'ENODATA' },
    { reference: ['192.0.2.10'], addresses: [] },
  ])('never classifies known invalid or missing records as dashboard uncertainty: %j',
    async ({ reference, referenceError, addresses, addressError, ipv6, ipv6Error }) => {
      const answer = (values: string[] | undefined, code: string | undefined) =>
        code === undefined ? Promise.resolve(values ?? []) : Promise.reject(Object.assign(new Error(), { code }));
      const dns = {
        resolve4: vi.fn((name: string) => name === hostname ? answer(addresses, addressError) : answer(reference, referenceError)),
        resolve6: vi.fn(() => answer(ipv6, ipv6Error)),
      };
      const wait = vi.fn().mockResolvedValue(undefined);
      const readiness = new PublicHostingReadinessService(hosting, dns, undefined, wait);
      await expect(readiness.verifyDashboardDns(hostname)).rejects.toMatchObject({ code: 'DNS' });
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it('stops after six attempts when an A answer stays missing', async () => {
    const dns = { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) };
    const wait = vi.fn().mockResolvedValue(undefined);
    const progress = vi.fn();
    const readiness = new PublicHostingReadinessService(hosting, dns, undefined, wait);

    await expect(readiness.waitForDns(hostname, progress)).rejects.toMatchObject({ code: 'DNS', statusCode: 502 });
    expect(dns.resolve6).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000], [10_000]]);
    expect(progress).toHaveBeenLastCalledWith('Public DNS checks exhausted after 6 attempts (missing A answer).');
  });

  it.each([
    [['192.0.2.10', '192.0.2.11'], ['192.0.2.10'], []],
    [['192.0.2.10'], ['192.0.2.10', '192.0.2.11'], []],
    [['192.0.2.10'], ['192.0.2.10'], ['2001:db8::1']],
  ])('rejects invalid DNS answers without retrying', async (reference, addresses, ipv6) => {
    const dns = { resolve4: vi.fn().mockResolvedValueOnce(reference).mockResolvedValueOnce(addresses),
      resolve6: vi.fn().mockResolvedValue(ipv6) };
    const wait = vi.fn().mockResolvedValue(undefined);
    const readiness = new PublicHostingReadinessService(hosting, dns, undefined, wait);

    await expect(readiness.waitForDns(hostname)).rejects.toMatchObject({ code: 'DNS' });
    expect(wait).not.toHaveBeenCalled();
  });

  it('requires the exact health response and reports TLS, routing and application failures separately', async () => {
    const request = vi.fn<LocalHealthRequest>().mockResolvedValueOnce(204).mockResolvedValueOnce(302).mockResolvedValueOnce(503)
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'EPROTO' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'ECONNREFUSED' }));
    const readiness = new PublicHostingReadinessService(hosting, undefined, request);
    const check = () => readiness.verifyHttps(new URL('https://' + hostname), '/ready');
    await expect(check()).resolves.toBeUndefined();
    expect(request.mock.calls[0]?.[0]).toMatchObject({ hostPort: 443, hostname, path: '/ready', https: true });
    for (const code of ['ROUTING', 'APPLICATION', 'CERTIFICATE', 'CERTIFICATE', 'ROUTING']) {
      await expect(check()).rejects.toMatchObject({ code });
    }
  });
});
