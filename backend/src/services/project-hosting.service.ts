import { env, type HostingConfig } from '../config/env.js';
import type { DeploymentStatus, RoutingOperation } from '../generated/prisma/client.js';
import { localProjectUrl, projectHostnameLabel, projectRouteProbe, publicProbePath } from '../utils/project-hostname.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import type { ApplicationRoutingService } from './application-routing.service.js';
import { applicationRoutingService } from './deployment-routing.service.js';

type HostingStatus = 'DISABLED' | 'AVAILABLE' | 'VERIFYING_HTTPS' | 'DEPLOYING' | 'UNAVAILABLE' | 'RECOVERING';

type HostingProject = {
  hostnameLabel: string;
  healthCheckPath: string;
  activeDeployment: { status: DeploymentStatus; hostPort: number | null } | null;
  routingOperation: RoutingOperation | null;
  deployments: { status: DeploymentStatus }[];
};

const inProgress: ReadonlySet<DeploymentStatus> = new Set([
  'QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTHCHECKING',
]);
const MAX_CACHED_PROBES = 128;

export class ProjectHostingService {
  readonly #probes = new WeakMap<ReadonlyMap<string, number>, Map<string, Promise<boolean>>>();

  constructor(
    private readonly routes: Pick<ApplicationRoutingService, 'readDashboardPorts'> | undefined,
    private readonly hosting: HostingConfig,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 1, requestTimeoutMs: 1_000 }),
  ) {}

  public async summarize(project: HostingProject): Promise<{
    localApplicationUrl: string | null;
    publicApplicationUrl?: string;
    publicProbePath?: string;
    hostingStatus: HostingStatus;
  }> {
    if (this.routes === undefined) return { localApplicationUrl: null, hostingStatus: 'DISABLED' };
    const publicApp = this.hosting.publicApp;
    if (publicApp !== undefined && project.hostnameLabel !== projectHostnameLabel(publicApp.projectId)) {
      return { localApplicationUrl: null, hostingStatus: 'DISABLED' };
    }
    const url = new URL(localProjectUrl(project.hostnameLabel, this.hosting));
    const hostingStatus = await this.#status(this.routes, project, url);
    if (publicApp !== undefined) {
      const port = project.activeDeployment?.hostPort;
      return {
        localApplicationUrl: null,
        publicApplicationUrl: url.origin,
        hostingStatus: hostingStatus === 'AVAILABLE' ? 'VERIFYING_HTTPS' : hostingStatus,
        ...(hostingStatus === 'AVAILABLE' && port != null
          ? { publicProbePath: publicProbePath(url.hostname, port, project.healthCheckPath) } : {}),
      };
    }
    return { localApplicationUrl: url.origin, hostingStatus };
  }

  async #status(
    routes: Pick<ApplicationRoutingService, 'readDashboardPorts'>,
    project: HostingProject,
    url: URL,
  ): Promise<HostingStatus> {
    const latestStatus = project.deployments[0]?.status;
    const deploying = latestStatus !== undefined && inProgress.has(latestStatus);
    const active = project.activeDeployment;

    if (active === null && project.routingOperation === null) {
      return deploying ? 'DEPLOYING' : 'UNAVAILABLE';
    }

    try {
      const ports = await routes.readDashboardPorts();
      const port = ports.get(url.hostname);
      if (active?.status === 'RUNNING' && port !== undefined && active.hostPort === port &&
        await this.#probe(ports, url, project.healthCheckPath) &&
        (await routes.readDashboardPorts()).get(url.hostname) === port) {
        return 'AVAILABLE';
      }
      if (active === null && deploying && port === undefined && project.routingOperation === 'PROMOTE') {
        return 'DEPLOYING';
      }
    } catch {
      // Unreachable or changing Caddy state cannot confirm an application route.
    }
    return 'RECOVERING';
  }

  #probe(ports: ReadonlyMap<string, number>, url: URL, path: string): Promise<boolean> {
    let probes = this.#probes.get(ports);
    if (probes === undefined) {
      probes = new Map();
      this.#probes.set(ports, probes);
    }
    const key = url.hostname + path;
    const cached = probes.get(key);
    if (cached !== undefined) return cached;
    const result = this.health.waitUntilHealthy(projectRouteProbe(url, path)).then(() => true, () => false);
    if (probes.size < MAX_CACHED_PROBES) probes.set(key, result);
    return result;
  }
}

export const projectHostingService = applicationRoutingService === undefined
  ? undefined
  : new ProjectHostingService(applicationRoutingService, env.hosting);
