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
const dnsRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000];
const transientDnsCodes = new Set(['ETIMEOUT', 'ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'EAI_AGAIN', 'ENODATA', 'ENOTFOUND']);
const missingRecord = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENODATA';
type PublicDns = Record<'resolve4' | 'resolve6', (hostname: string) => Promise<string[]>>;

class RetryableDnsError extends PublicHostingReadinessError {
  constructor(public readonly reason: string) {
    super('DNS');
  }
}

export class PublicHostingReadinessService {
  constructor(
    private readonly hosting: HostingConfig,
    private readonly dns: PublicDns = resolver,
    private readonly request = requestLocalHealth,
    private readonly waitBeforeDnsRetry: (milliseconds: number) => Promise<void> = sleep,
  ) {}

  public async verifyDns(hostname: string): Promise<void> {
    let answers: [string[], string[], string[]];
    try {
      answers = await Promise.all([
        this.dns.resolve4(this.hosting.publicHosting?.dnsTarget ?? this.hosting.hostnameSuffix),
        this.dns.resolve4(hostname),
        this.dns.resolve6(hostname).catch((error: unknown) => {
          if (!missingRecord(error)) throw error;
          return [];
        }),
      ]);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && transientDnsCodes.has(error.code)) {
        throw new RetryableDnsError(error.code);
      }
      throw new PublicHostingReadinessError('DNS');
    }
    const [reference, addresses, ipv6] = answers;
    if (ipv6.length > 0 || reference.length > 1 ||
      (reference.length === 1 && addresses.some((ip) => ip !== reference[0]))) {
      throw new PublicHostingReadinessError('DNS');
    }
    if (reference.length === 0 || addresses.length === 0) throw new RetryableDnsError('missing A answer');
  }

  public async waitForDns(hostname: string, onProgress?: (message: string) => void): Promise<void> {
    const maxAttempts = dnsRetryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt += 1) {
      const check = `${String(attempt)}/${String(maxAttempts)}`;
      try {
        await this.verifyDns(hostname);
        if (attempt > 1) onProgress?.(`Public DNS verified on check ${check}.`);
        return;
      } catch (error) {
        if (!(error instanceof RetryableDnsError)) throw error;
        const delay = dnsRetryDelaysMs[attempt - 1];
        if (delay === undefined) {
          onProgress?.(`Public DNS checks exhausted after ${String(maxAttempts)} attempts (${error.reason}).`);
          throw error;
        }
        onProgress?.(`Public DNS check ${check} failed (${error.reason}). Retrying in ${String(delay / 1_000)}s.`);
        await this.waitBeforeDnsRetry(delay);
      }
    }
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
