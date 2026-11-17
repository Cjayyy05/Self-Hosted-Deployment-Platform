import { Resolver } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { env, type HostingConfig } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { projectRouteProbe } from '../utils/project-hostname.js';
import { requestLocalHealth } from './application-health-check.service.js';

const messages = {
  DNS: 'Public DNS must resolve to the hosting IPv4 address with no AAAA record',
  CERTIFICATE: 'Caddy has not presented a trusted certificate for this hostname',
  ROUTING: 'Caddy could not confirm the HTTPS route for this deployment',
  APPLICATION: 'The application health check failed through Caddy',
  APPROVAL: 'Public hosting approval could not be verified for this deployment',
};

export class PublicHostingReadinessError extends AppError {
  declare readonly code: keyof typeof messages;

  constructor(code: keyof typeof messages) {
    super(502, messages[code], code);
    this.name = 'PublicHostingReadinessError';
  }
}

const resolver = new Resolver({ timeout: 1_500, tries: 1 });
const missingRecord = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENODATA';
type PublicDns = Record<'resolve4' | 'resolve6', (hostname: string) => Promise<string[]>>;

export class PublicHostingReadinessService {
  constructor(
    private readonly hosting: HostingConfig,
    private readonly dns: PublicDns = resolver,
    private readonly request = requestLocalHealth,
  ) {}

  public async verifyDns(hostname: string): Promise<void> {
    try {
      const [reference, addresses, ipv6] = await Promise.all([
        this.dns.resolve4(this.hosting.publicHosting?.dnsTarget ?? this.hosting.hostnameSuffix),
        this.dns.resolve4(hostname),
        this.dns.resolve6(hostname).catch((error: unknown) => {
          if (!missingRecord(error)) throw error;
          return [];
        }),
      ]);
      if (reference.length === 1 && addresses.length > 0 && addresses.every((ip) => ip === reference[0]) && ipv6.length === 0) {
        return;
      }
    } catch {
      // Resolver failures and unexpected answers both prevent public readiness.
    }
    throw new PublicHostingReadinessError('DNS');
  }

  public async verifyHttps(url: URL, path: string, waitForCertificate = false): Promise<void> {
    const deadline = performance.now() + (waitForCertificate ? 60_000 : 1_500);
    for (;;) {
      const timeoutMs = Math.min(1_500, Math.max(1, Math.floor(deadline - performance.now())));
      try {
        const status = await this.request({ ...projectRouteProbe(url, path), timeoutMs });
        if (status === 204) return;
        throw new PublicHostingReadinessError(status === 503 ? 'APPLICATION' : 'ROUTING');
      } catch (error) {
        if (error instanceof PublicHostingReadinessError) throw error;
        const code = error instanceof Error && 'code' in error ? String(error.code) : '';
        const tlsError = code === 'EPROTO' || /^(ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_|UNABLE_TO_|SELF_SIGNED_)/.test(code);
        if (!tlsError) throw new PublicHostingReadinessError('ROUTING');
        const remaining = Math.floor(deadline - performance.now());
        if (!waitForCertificate || remaining < 100) throw new PublicHostingReadinessError('CERTIFICATE');
        await sleep(Math.min(1_000, remaining - 1));
      }
    }
  }
}

export const publicHostingReadinessService = new PublicHostingReadinessService(env.hosting);
