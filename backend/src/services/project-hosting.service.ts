import { env, managesProjectRoute, type HostingConfig } from '../config/env.js';
import type { DeploymentStatus, RoutingOperation } from '../generated/prisma/client.js';
import { localProjectUrl, projectRouteProbe, publicProbePath, type RouteTarget } from '../utils/project-hostname.js';
import { workloadAddress } from '../utils/workload-address.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import type { ApplicationRoutingService } from './application-routing.service.js';
import { applicationRoutingService } from './deployment-routing.service.js';
import { PublicApplicationPolicy, type ApprovalProject } from './public-application-policy.js';

type HostingStatus = 'DISABLED' | 'AVAILABLE' | 'VERIFYING_HTTPS' | 'DEPLOYING' | 'UNAVAILABLE' | 'RECOVERING';

type HostingProject = ApprovalProject & {
  hostnameLabel: string;
  healthCheckPath: string;
  activeDeployment: { status: DeploymentStatus; hostPort: number | null; publicAddressIndex: number | null; commitHash: string | null } | null;
  routingOperation: RoutingOperation | null;
  deployments: { status: DeploymentStatus }[];
};

const inProgress: ReadonlySet<DeploymentStatus> = new Set([
  'QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTHCHECKING',
]);
const MAX_CACHED_PROBES = 128;

export class ProjectHostingService {
  readonly #probes = new WeakMap<ReadonlyMap<string, RouteTarget>, Map<string, Promise<boolean>>>();

  constructor(
    private readonly routes: Pick<ApplicationRoutingService, 'readDashboardTargets'> | undefined,
    private readonly hosting: HostingConfig,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 1, requestTimeoutMs: 1_000 }),
    private readonly policy: Pick<PublicApplicationPolicy, 'assertApproved'> = new PublicApplicationPolicy(hosting),
  ) {}

  public async summarize(project: HostingProject): Promise<{
    localApplicationUrl: string | null;
    publicApplicationUrl?: string;
    publicProbePath?: string;
    hostingStatus: HostingStatus;
  }> {
    if (this.routes === undefined) return { localApplicationUrl: null, hostingStatus: 'DISABLED' };
    if (!managesProjectRoute(this.hosting, project.id)) {
      return { localApplicationUrl: null, hostingStatus: 'DISABLED' };
    }
    if (this.hosting.publicHosting !== undefined && project.activeDeployment !== null) {
      try {
        await this.policy.assertApproved(project, project.activeDeployment.commitHash);
      } catch {
        return { localApplicationUrl: null, hostingStatus: 'UNAVAILABLE' };
      }
    }
    const url = new URL(localProjectUrl(project.hostnameLabel, this.hosting));
    const active = project.activeDeployment;
    const target = active?.hostPort == null || (this.hosting.publicHosting !== undefined && active.publicAddressIndex === null)
      ? null : { address: workloadAddress(active.publicAddressIndex), port: active.hostPort };
    const probePath = target === null || this.hosting.publicHosting === undefined ? project.healthCheckPath
      : publicProbePath(url.hostname, target, project.healthCheckPath);
    const hostingStatus = await this.#status(this.routes, project, url, target, probePath);
    if (this.hosting.publicHosting !== undefined && project.activeDeployment !== null) {
      return {
        localApplicationUrl: null,
        publicApplicationUrl: url.origin,
        hostingStatus: hostingStatus === 'AVAILABLE' ? 'VERIFYING_HTTPS' : hostingStatus,
        ...(hostingStatus === 'AVAILABLE' ? { publicProbePath: probePath } : {}),
      };
    }
    if (this.hosting.publicHosting !== undefined) return { localApplicationUrl: null, hostingStatus };
    return { localApplicationUrl: url.origin, hostingStatus };
  }

  async #status(
    routes: Pick<ApplicationRoutingService, 'readDashboardTargets'>,
    project: HostingProject,
    url: URL,
    target: RouteTarget | null,
    probePath: string,
  ): Promise<HostingStatus> {
    const latestStatus = project.deployments[0]?.status;
    const deploying = latestStatus !== undefined && inProgress.has(latestStatus);
    const active = project.activeDeployment;

    if (active === null && project.routingOperation === null) {
      return deploying ? 'DEPLOYING' : 'UNAVAILABLE';
    }

    try {
      const targets = await routes.readDashboardTargets();
      const route = targets.get(url.hostname);
      if (active?.status === 'RUNNING' && target !== null && route?.port === target.port && route.address === target.address &&
        await this.#probe(targets, url, probePath)) {
        const observed = (await routes.readDashboardTargets()).get(url.hostname);
        if (observed?.port === target.port && observed.address === target.address) return 'AVAILABLE';
      }
      if (active === null && deploying && route === undefined && project.routingOperation === 'PROMOTE') {
        return 'DEPLOYING';
      }
    } catch {
      // Unreachable or changing Caddy state cannot confirm an application route.
    }
    return 'RECOVERING';
  }

  #probe(targets: ReadonlyMap<string, RouteTarget>, url: URL, path: string): Promise<boolean> {
    let probes = this.#probes.get(targets);
    if (probes === undefined) {
      probes = new Map();
      this.#probes.set(targets, probes);
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
