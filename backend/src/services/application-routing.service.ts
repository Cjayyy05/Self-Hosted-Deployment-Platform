import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { env, parseHostingConfig, type HostingConfig } from '../config/env.js';
import { projectHostnameLabel } from '../utils/project-hostname.js';
import {
  CADDY_REQUEST_TIMEOUT_MS,
  createCaddyAdminTransport,
  isRoutesEtag,
  type CaddyAdminTransport,
} from './caddy-admin-transport.js';
import { containerService, type RoutingContainer } from './container.service.js';

const READ_BACK_WINDOW_MS = 3_000;
const READ_BACK_DELAY_MS = 100;

const unknownHostRoute = {
  handle: [{ handler: 'static_response', status_code: 404, body: 'Unknown host' }],
  terminal: true,
};

const applicationRoute = (hostname: string, port: number) => ({
  match: [{ host: [hostname] }] as const,
  handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:' + String(port) }] }],
  terminal: true,
});

type ApplicationRoute = ReturnType<typeof applicationRoute>;
type Fallback = typeof unknownHostRoute & { '@id'?: string };
type Routes = [...ApplicationRoute[], Fallback];
type RouteState = { routes: Routes; etag: string };
type RouteWrite = { beforeWrite?: () => Promise<void>; expectedPort?: number };
type RoutingErrorCode = 'unavailable' | 'invalid-config' | 'conflict' | 'rejected' | 'uncertain';

export class ApplicationRoutingError extends Error {
  constructor(public readonly code: RoutingErrorCode, message: string) {
    super(message);
    this.name = 'ApplicationRoutingError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstRecord = (value: unknown): Record<string, unknown> | undefined =>
  Array.isArray(value) && isRecord(value[0]) ? value[0] : undefined;

const routeHostname = (route: ApplicationRoute): string => route.match[0].host[0];

const parseRoutes = (body: string, suffix: string): Routes => {
  const data: unknown = JSON.parse(body);
  const fallback: unknown = Array.isArray(data) ? data.at(-1) : undefined;
  if (!Array.isArray(data) || !isRecord(fallback)) {
    throw new Error('Caddy route list is missing its final unknown-host response');
  }
  const revision = fallback['@id'];
  const expectedFallback: Fallback = typeof revision === 'string' &&
    /^deployflow-revision-[a-f0-9]{32}$/.test(revision)
    ? { ...unknownHostRoute, '@id': revision }
    : unknownHostRoute;
  if (!isDeepStrictEqual(fallback, expectedFallback)) {
    throw new Error('Caddy route list is missing its final unknown-host response');
  }
  const routes: ApplicationRoute[] = [];
  const seen = new Set<string>();
  for (const entry of data.slice(0, -1) as unknown[]) {
    if (!isRecord(entry)) throw new Error('Caddy returned an invalid managed route');
    const matcher = firstRecord(entry.match);
    const host: unknown = Array.isArray(matcher?.host) ? matcher.host[0] : undefined;
    const dial = firstRecord(firstRecord(entry.handle)?.upstreams)?.dial;
    const match = typeof dial === 'string' && /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(dial);
    if (
      typeof host !== 'string' ||
      !host.endsWith('.' + suffix) ||
      !/^app-[a-f0-9]{32}$/.test(host.slice(0, -(suffix.length + 1))) ||
      !match ||
      Number(match[1]) > 65_535 ||
      seen.has(host)
    ) {
      throw new Error('Caddy returned an invalid or duplicate managed route');
    }
    const route = applicationRoute(host, Number(match[1]));
    if (!isDeepStrictEqual(entry, route)) throw new Error('Caddy route is outside the managed layout');
    seen.add(host);
    routes.push(route);
  }
  return [...routes, expectedFallback];
};

export class ApplicationRoutingService {
  #queue: Promise<void> = Promise.resolve();
  #uncertain = false;
  readonly #hostnameSuffix: string;

  constructor(
    private readonly transport: CaddyAdminTransport,
    hostnameSuffix: string,
    private readonly docker: Pick<typeof containerService, 'inspectLoopbackRoutingPort'> = containerService,
  ) {
    this.#hostnameSuffix = parseHostingConfig({ hostnameSuffix }).hostnameSuffix;
  }

  public upsert(projectId: string, container: RoutingContainer, options?: RouteWrite): Promise<void> {
    return this.#mutate(projectId, container, options);
  }

  public remove(projectId: string, options?: RouteWrite): Promise<void> {
    return this.#mutate(projectId, undefined, options);
  }

  public repair(projectId: string, container: RoutingContainer | undefined, options: RouteWrite): Promise<void> {
    return this.#mutate(projectId, container, options, true);
  }

  public async readPort(projectId: string): Promise<number | null> {
    await this.#queue;
    if (this.#uncertain) {
      throw new ApplicationRoutingError('uncertain', 'Caddy routing requires reconciliation');
    }
    const hostname = this.#hostname(projectId);
    const { routes } = await this.#readRoutes();
    const route = (routes.slice(0, -1) as ApplicationRoute[]).find((entry) => routeHostname(entry) === hostname);
    return route === undefined ? null : Number(route.handle[0]?.upstreams[0]?.dial.slice('127.0.0.1:'.length));
  }

  #hostname(projectId: string): string {
    return projectHostnameLabel(projectId) + '.' + this.#hostnameSuffix;
  }

  #mutate(
    projectId: string,
    container?: RoutingContainer,
    options?: RouteWrite,
    repair = false,
  ): Promise<void> {
    const operation = this.#queue.then(async () => {
      if (this.#uncertain && !repair) {
        throw new ApplicationRoutingError('uncertain', 'Caddy routing writes are paused until the last update is reconciled');
      }
      const hostname = this.#hostname(projectId);
      const current = await this.#readRoutes();
      const routes = current.routes.slice(0, -1) as ApplicationRoute[];
      const index = routes.findIndex((route) => routeHostname(route) === hostname);
      if (container === undefined) {
        if (index !== -1) routes.splice(index, 1);
      } else {
        const port = await this.docker.inspectLoopbackRoutingPort(container);
        if (!Number.isInteger(port) || port < 1 || port > 65_535 ||
          (options?.expectedPort !== undefined && port !== options.expectedPort)) {
          throw new ApplicationRoutingError('rejected', 'Docker routing binding changed after verification');
        }
        const route = applicationRoute(hostname, port);
        if (index === -1) routes.push(route);
        else routes[index] = route;
      }
      if (!repair && isDeepStrictEqual(current.routes.slice(0, -1), routes)) return;
      await options?.beforeWrite?.();
      const expected: Routes = [...routes, {
        ...unknownHostRoute,
        '@id': 'deployflow-revision-' + randomUUID().replaceAll('-', ''),
      }];
      await this.#replaceRoutes(current, expected);
      if (repair) this.#uncertain = false;
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #readRoutes(timeoutMs?: number): Promise<RouteState> {
    let response;
    try {
      response = await this.transport({ method: 'GET' }, timeoutMs);
    } catch {
      throw new ApplicationRoutingError('unavailable', 'Unable to read Caddy routes through the private socket');
    }
    if (response.status !== 200 || !isRoutesEtag(response.etag)) {
      throw new ApplicationRoutingError('invalid-config', 'Caddy did not return the managed route list and its ETag');
    }
    try {
      return { routes: parseRoutes(response.body, this.#hostnameSuffix), etag: response.etag };
    } catch {
      throw new ApplicationRoutingError('invalid-config', 'Caddy route list does not match the DeployFlow bootstrap layout');
    }
  }

  async #replaceRoutes(current: RouteState, expected: Routes): Promise<void> {
    const body = JSON.stringify(expected);
    let status: number | undefined;
    try {
      status = (await this.transport({ method: 'PATCH', body, etag: current.etag })).status;
    } catch {
      // A disconnected client cannot tell whether Caddy committed the write.
    }
    if (status === 412) {
      throw new ApplicationRoutingError('conflict', 'Caddy routes changed before the update could be applied');
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      throw new ApplicationRoutingError('rejected', 'Caddy rejected the managed route update (HTTP ' + String(status) + ')');
    }

    const deadline = performance.now() + READ_BACK_WINDOW_MS;
    while (performance.now() < deadline) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) break;
      try {
        const observed = await this.#readRoutes(Math.min(remaining, CADDY_REQUEST_TIMEOUT_MS));
        if (performance.now() <= deadline && isDeepStrictEqual(observed.routes, expected)) return;
      } catch {
        // Windows may briefly disconnect fresh reads during a reload.
      }
      const pause = Math.min(READ_BACK_DELAY_MS, deadline - performance.now());
      if (pause > 0) await sleep(pause);
    }
    this.#uncertain = true;
    throw new ApplicationRoutingError('uncertain', 'Could not confirm the Caddy route update. Reconcile the live config before resuming writes');
  }
}

export const createApplicationRoutingService = (
  hosting: HostingConfig = env.hosting,
): ApplicationRoutingService | undefined =>
  hosting.adminSocketPath === undefined
    ? undefined
    : new ApplicationRoutingService(createCaddyAdminTransport(hosting.adminSocketPath), hosting.hostnameSuffix);
