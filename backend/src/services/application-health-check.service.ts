import { request } from 'node:http';
import { request as requestHttps } from 'node:https';

import { AppError } from '../utils/app-error.js';
import { parseHealthCheckPath } from '../utils/health-check-path.js';

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export type ApplicationHealthCheckInput = {
  hostPort: number;
  path: string;
  hostname?: string;
  https?: true;
};

export type LocalHealthRequest = (input: {
  hostPort: number;
  path: string;
  timeoutMs: number;
  hostname?: string;
  https?: true;
}) => Promise<number>;

type ApplicationHealthCheckDependencies = {
  requestHealth?: LocalHealthRequest;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
};

const requestLocalHealth: LocalHealthRequest = ({
  hostPort,
  path,
  timeoutMs,
  hostname,
  https,
}) =>
  new Promise((resolve, reject) => {
    const healthRequest = (https ? requestHttps : request)(
      {
        hostname: '127.0.0.1',
        port: hostPort,
        path,
        method: 'GET',
        ...(https ? { servername: hostname, rejectUnauthorized: true } : {}),
        headers: {
          Accept: '*/*',
          'User-Agent': 'DeployFlow-HealthCheck/1.0',
          ...(hostname === undefined ? {} : { Host: hostname }),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    const timeout = setTimeout(() => {
      healthRequest.destroy(new Error('Health-check request timed out'));
    }, timeoutMs);
    healthRequest.once('close', () => { clearTimeout(timeout); });
    healthRequest.on('error', reject);
    healthRequest.end();
  });

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseHostPort = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new AppError(400, 'Health-check host port is invalid');
  }
  return value;
};

export class ApplicationHealthCheckService {
  readonly #requestHealth: LocalHealthRequest;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #requestTimeoutMs: number;
  readonly #retryDelayMs: number;

  public constructor(dependencies: ApplicationHealthCheckDependencies = {}) {
    this.#requestHealth = dependencies.requestHealth ?? requestLocalHealth;
    this.#sleep = dependencies.sleep ?? sleep;
    this.#maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#requestTimeoutMs =
      dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#retryDelayMs =
      dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  public async waitUntilHealthy(
    input: ApplicationHealthCheckInput,
  ): Promise<void> {
    const hostPort = parseHostPort(input.hostPort);
    const path = parseHealthCheckPath(input.path);
    if (input.https && (input.hostname === undefined || hostPort !== 443)) {
      throw new AppError(400, 'An HTTPS health check requires a project hostname and port 443');
    }
    if (
      input.hostname !== undefined &&
      (input.hostname.length > 253 ||
        !/^app-[a-f0-9]{32}(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(input.hostname))
    ) {
      throw new AppError(400, 'Application health-check hostname is invalid');
    }

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const statusCode = await this.#requestHealth({
          hostPort,
          path,
          timeoutMs: this.#requestTimeoutMs,
          ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
          ...(input.https ? { https: true } : {}),
        });
        if (statusCode >= 200 && statusCode < 400) return;
      } catch {
        // Connection failures and request timeouts are retried within the bound.
      }

      if (attempt < this.#maxAttempts) {
        await this.#sleep(this.#retryDelayMs);
      }
    }

    throw new AppError(
      422,
      `Application did not become healthy at ${path}`,
    );
  }
}

export const applicationHealthCheckService =
  new ApplicationHealthCheckService();
