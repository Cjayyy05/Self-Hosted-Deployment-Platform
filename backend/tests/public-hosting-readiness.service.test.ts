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
