import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { env, parseHostingConfig, type HostingConfig } from '../config/env.js';
import { database } from '../config/database.js';
import { parseHealthCheckPath } from '../utils/health-check-path.js';
import { isWorkloadAddress } from '../utils/workload-address.js';
import { projectHostnameLabel, PUBLIC_PROBE_PREFIX, publicProbePath, type RouteTarget } from '../utils/project-hostname.js';
import {
  CADDY_REQUEST_TIMEOUT_MS,
  createCaddyAdminTransport,
  isRoutesEtag,
  type CaddyAdminTransport,
} from './caddy-admin-transport.js';
import { containerService, type RoutingContainer } from './container.service.js';

const READ_BACK_WINDOW_MS = 3_000;
const READ_BACK_DELAY_MS = 100;
const DASHBOARD_ROUTE_TTL_MS = 3_000;
const PUBLIC_REVISION = /^deployflow-public-[1-9][0-9]*-[a-f0-9]{32}$/;
export const DEFAULT_INGRESS_SOCKET = '/run/deployflow-ingress/auth.sock';

const unknownHostRoute = {
  handle: [{ handler: 'static_response', status_code: 404, body: 'Unknown host' }],
  terminal: true,
};

const proxy = (port: number, address = '127.0.0.1') =>
  ({ handler: 'reverse_proxy', upstreams: [{ dial: address + ':' + String(port) }] });

const localRoute = (hostname: string, port: number) => ({
  match: [{ host: [hostname] }] as const,
  handle: [proxy(port)],
  terminal: true,
});

const probeResponse = (status: number) => ({
  routes: [{
    handle: [{
      handler: 'static_response',
      status_code: status,
      headers: {
        'Access-Control-Allow-Origin': ['http://127.0.0.1:3000'],
        'Cache-Control': ['no-store'],
        'X-Content-Type-Options': ['nosniff'],
      },
    }],
  }],
});

const authorize = (socket: string, hostname: string, address: string, port: number) => ({
  handler: 'reverse_proxy',
  upstreams: [{ dial: 'unix/' + socket }],
  transport: { protocol: 'http', dial_timeout: '250ms', response_header_timeout: '1500ms' },
  rewrite: { method: 'GET', uri: '/authorize?' },
  headers: { request: { set: { 'X-Deployflow-Host': [hostname], 'X-Deployflow-Target': [address + ':' + String(port)] },
    delete: ['Authorization', 'Cookie'] } },
  handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: 'vars' }] }] }],
});

const publicRoute = (hostname: string, port: number, healthPath: string, address = '127.0.0.1', socket?: string) => ({
  match: [{ host: [hostname] }] as const,
  handle: [{
    handler: 'subroute',
    routes: [
      {
        match: [{ path: [publicProbePath(hostname, { address, port }, healthPath)], method: ['GET'] }],
        handle: [...(socket === undefined ? [] : [authorize(socket, hostname, address, port)]), {
          ...proxy(port, address),
          rewrite: { method: 'GET', uri: healthPath + '?' },
          headers: { request: { delete: ['Authorization', 'Cookie'] } },
          handle_response: [{ match: { status_code: [2, 3] }, ...probeResponse(204) }, probeResponse(503)],
        }],
        terminal: true,
      },
      {
        ...unknownHostRoute,
        match: [{ path: [PUBLIC_PROBE_PREFIX + '*'] }],
      },
      { handle: [...(socket === undefined ? [] : [authorize(socket, hostname, address, port)]), proxy(port, address)], terminal: true },
    ],
  }],
  terminal: true,
});

type ApplicationRoute = ReturnType<typeof localRoute> | ReturnType<typeof publicRoute>;
type Fallback = typeof unknownHostRoute & { '@id'?: string };
type Routes = [...ApplicationRoute[], Fallback];
type RouteState = { routes: Routes; etag: string };
type RouteWrite = { beforeWrite?: () => Promise<void>; expectedPort?: number; healthPath?: string };
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
const upstreamTarget = (route: ApplicationRoute) => {
  const handler = route.handle[0];
  const upstream = handler !== undefined && 'routes' in handler ? handler.routes[2]?.handle.at(-1) : handler;
  const dial = upstream !== undefined && 'upstreams' in upstream ? upstream.upstreams[0]?.dial : undefined;
  const [address, port] = dial?.split(':') ?? [];
  if (address === undefined || port === undefined) throw new Error('Managed Caddy route is missing its target');
  return { address, port: Number(port) };
};

const parseRoutes = (body: string, suffix: string, publicHostname?: string, ingressSocket?: string): Routes => {
  const data: unknown = JSON.parse(body);
  const fallback: unknown = Array.isArray(data) ? data.at(-1) : undefined;
  if (!Array.isArray(data) || !isRecord(fallback)) {
    throw new Error('Caddy route list is missing its final unknown-host response');
  }
  const revision = fallback['@id'];
  const expectedFallback: Fallback = typeof revision === 'string' &&
    (/^deployflow-revision-[a-f0-9]{32}$/.test(revision) || PUBLIC_REVISION.test(revision))
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
    const handler = firstRecord(entry.handle);
    const probeHandlers = firstRecord(handler?.routes)?.handle;
    const lastProbeHandler: unknown = Array.isArray(probeHandlers) ? probeHandlers.at(-1) : undefined;
    const subroute = isRecord(lastProbeHandler) ? lastProbeHandler : undefined;
    const dial = firstRecord((publicHostname === undefined ? handler : subroute)?.upstreams)?.dial;
    const match = typeof dial === 'string' && /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}):([1-9]\d{0,4})$/.exec(dial);
    if (
      typeof host !== 'string' ||
      (publicHostname !== undefined && host !== publicHostname) ||
      !host.endsWith('.' + suffix) ||
      !/^app-[a-f0-9]{32}$/.test(host.slice(0, -(suffix.length + 1))) ||
      !match ||
      match[1] === undefined || (match[1] !== '127.0.0.1' && (publicHostname === undefined || !isWorkloadAddress(match[1]))) ||
      Number(match[2]) > 65_535 ||
      seen.has(host)
    ) {
      throw new Error('Caddy returned an invalid or duplicate managed route');
    }
    const rewrite = subroute?.rewrite;
    const route = publicHostname === undefined
      ? localRoute(host, Number(match[2]))
      : publicRoute(host, Number(match[2]), parseHealthCheckPath(
        isRecord(rewrite) && typeof rewrite.uri === 'string' && rewrite.uri.endsWith('?')
          ? rewrite.uri.slice(0, -1) : null,
      ), match[1], ingressSocket);
    if (!isDeepStrictEqual(entry, route)) throw new Error('Caddy route is outside the managed layout');
    seen.add(host);
    routes.push(route);
  }
  return [...routes, expectedFallback];
};

export class ApplicationRoutingService {
  #queue: Promise<void> = Promise.resolve();
  #uncertain = false;
  #dashboardRoutes: { expiresAt: number; targets: Promise<ReadonlyMap<string, RouteTarget>> } | undefined;
  readonly #hostnameSuffix: string;
  readonly #publicHostname: string | undefined;

  constructor(
    private readonly transport: CaddyAdminTransport,
    hostnameSuffix: string,
    private readonly docker: Pick<typeof containerService, 'inspectLoopbackRoutingPort'> = containerService,
    publicProjectId?: string,
    private readonly allocatePublicGeneration?: () => Promise<bigint>,
    private readonly ingressSocket?: string,
  ) {
    this.#hostnameSuffix = parseHostingConfig({ hostnameSuffix }).hostnameSuffix;
    this.#publicHostname = publicProjectId === undefined ? undefined : this.#hostname(publicProjectId);
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
    return (await this.readTarget(projectId))?.port ?? null;
  }

  public async readTarget(projectId: string): Promise<RouteTarget | null> {
    await this.#queue;
    if (this.#uncertain) {
      throw new ApplicationRoutingError('uncertain', 'Caddy routing requires reconciliation');
    }
    const hostname = this.#hostname(projectId);
    const { routes } = await this.#readRoutes();
    const route = (routes.slice(0, -1) as ApplicationRoute[]).find((entry) => routeHostname(entry) === hostname);
    return route === undefined ? null : upstreamTarget(route);
  }

  public async readDashboardTargets(): Promise<ReadonlyMap<string, RouteTarget>> {
    if (this.#uncertain) {
      throw new ApplicationRoutingError('uncertain', 'Caddy routing requires reconciliation');
    }
    if (this.#dashboardRoutes === undefined || this.#dashboardRoutes.expiresAt <= performance.now()) {
      const targets = this.#readRoutes().then(({ routes }) => new Map(
        (routes.slice(0, -1) as ApplicationRoute[]).map((route) => [routeHostname(route), upstreamTarget(route)]),
      ));
      this.#dashboardRoutes = { expiresAt: performance.now() + DASHBOARD_ROUTE_TTL_MS, targets };
    }
    const snapshot = this.#dashboardRoutes;
    const targets = await snapshot.targets;
    if (this.#dashboardRoutes !== snapshot) {
      throw new ApplicationRoutingError('uncertain', 'Caddy routing changed during the status check');
    }
    return targets;
  }

  #hostname(projectId: string): string {
    return projectHostnameLabel(projectId) + '.' + this.#hostnameSuffix;
  }

  async #revision(beforeWrite?: () => Promise<void>): Promise<Fallback> {
    const nonce = randomUUID().replaceAll('-', '');
    if (this.#publicHostname === undefined) {
      await beforeWrite?.();
      return { ...unknownHostRoute, '@id': 'deployflow-revision-' + nonce };
    }
    if (beforeWrite === undefined || this.allocatePublicGeneration === undefined) {
      throw new ApplicationRoutingError('rejected', 'Public routing requires a durable generation and a project lease');
    }
    const generation = await this.allocatePublicGeneration();
    await beforeWrite();
    return { ...unknownHostRoute, '@id': 'deployflow-public-' + String(generation) + '-' + nonce };
  }

  async #publicationBase(current: RouteState, beforeWrite?: () => Promise<void>): Promise<RouteState> {
    const revision = (current.routes.at(-1) as Fallback | undefined)?.['@id'];
    if (revision !== undefined && PUBLIC_REVISION.test(revision)) return current;
    if (revision === undefined && current.routes.length !== 1) {
      throw new ApplicationRoutingError('invalid-config', 'An unversioned public bootstrap must have no upstreams');
    }
    // A write against a resettable bootstrap may only stamp the current
    // configuration. No publish PATCH can use the bootstrap ETag.
    const expected: Routes = [...current.routes.slice(0, -1) as ApplicationRoute[], await this.#revision(beforeWrite)];
    this.#dashboardRoutes = undefined;
    await this.#replaceRoutes(current, expected);
    const stamped = await this.#readRoutes();
    if (!isDeepStrictEqual(stamped.routes, expected)) {
      throw new ApplicationRoutingError('conflict', 'Caddy changed after establishing its public write generation');
    }
    return stamped;
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
      if (this.#publicHostname !== undefined && hostname !== this.#publicHostname) {
        throw new ApplicationRoutingError('rejected', 'Only the approved project can change the public route');
      }
      let current = await this.#readRoutes();
      if (container !== undefined && this.#publicHostname !== undefined) {
        current = await this.#publicationBase(current, options?.beforeWrite);
      }
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
        const route = this.#publicHostname === undefined
          ? localRoute(hostname, port)
          : publicRoute(hostname, port, parseHealthCheckPath(options?.healthPath), container.hostAddress, this.ingressSocket);
        if (index === -1) routes.push(route);
        else routes[index] = route;
      }
      if (!repair && isDeepStrictEqual(current.routes.slice(0, -1), routes)) return;
      const expected: Routes = [...routes, await this.#revision(options?.beforeWrite)];
      this.#dashboardRoutes = undefined;
      try {
        await this.#replaceRoutes(current, expected);
        if (repair) this.#uncertain = false;
      } finally {
        this.#dashboardRoutes = undefined;
      }
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
      return { routes: parseRoutes(response.body, this.#hostnameSuffix, this.#publicHostname, this.ingressSocket), etag: response.etag };
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
): ApplicationRoutingService | undefined => {
  const { adminSocketPath, hostnameSuffix } = hosting;
  const projectId = hosting.publicHosting?.routeProjectId;
  if (adminSocketPath === undefined || (hosting.publicHosting !== undefined && projectId === undefined)) return undefined;
  const allocate = async () => (await database.publicRoutingBinding.update({
    where: { id: 1, projectId: projectId ?? null, adminSocketPath, hostnameSuffix },
    data: { routeGeneration: { increment: 1 } }, select: { routeGeneration: true },
  })).routeGeneration;
  return new ApplicationRoutingService(createCaddyAdminTransport(adminSocketPath), hostnameSuffix,
    containerService, projectId, projectId === undefined ? undefined : allocate,
    projectId === undefined ? undefined : hosting.publicHosting?.ingressSocketPath ?? DEFAULT_INGRESS_SOCKET);
};
