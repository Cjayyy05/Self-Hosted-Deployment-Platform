import { env, type HostingConfig } from '../config/env.js';
import type { DeploymentStatus, RoutingOperation } from '../generated/prisma/client.js';
import { localProjectUrl, projectRouteProbe, publicProbePath, type RouteTarget } from '../utils/project-hostname.js';
import { workloadAddress } from '../utils/workload-address.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import type { ApplicationRoutingService } from './application-routing.service.js';
import { applicationRoutingService } from './deployment-routing.service.js';
import { PublicApplicationPolicy, type ApprovalProject } from './public-application-policy.js';
import { PublicHostingReadinessError, PublicHostingReadinessService } from './public-hosting-readiness.service.js';

type HostingStatus = 'DISABLED' | 'AVAILABLE' | 'VERIFYING_HTTPS' | 'DEPLOYING' | 'UNAVAILABLE' | 'RECOVERING';
type HostingSummary = {
  localApplicationUrl: string | null;
  publicHostname?: string;
  publicApplicationUrl?: string;
  publicProbePath?: string;
  hostingStatus: HostingStatus;
  approvalStatus?: 'UNAPPROVED' | 'APPROVED' | 'WITHDRAWAL_PENDING' | 'REVOKED' | 'UNKNOWN';
  certificateStatus?: 'READY' | 'UNVERIFIED';
  hostingError?: { code: string; message: string };
};

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
  readonly #probes = new WeakMap<ReadonlyMap<string, RouteTarget>, Map<string, Promise<void>>>();

  constructor(
    private readonly routes: Pick<ApplicationRoutingService, 'readDashboardTargets'> | undefined,
    private readonly hosting: HostingConfig,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 1, requestTimeoutMs: 1_000 }),
    private readonly policy: Pick<PublicApplicationPolicy, 'read'> = new PublicApplicationPolicy(hosting),
    private readonly readiness: Pick<PublicHostingReadinessService, 'verifyDns' | 'verifyHttps'> = new PublicHostingReadinessService(hosting),
  ) {}

  public async summarize(project: HostingProject): Promise<HostingSummary> {
    if (this.routes === undefined) return { localApplicationUrl: null, hostingStatus: 'DISABLED' };
    const url = new URL(localProjectUrl(project.hostnameLabel, this.hosting));
    if (this.hosting.publicHosting !== undefined) return this.#publicSummary(this.routes, project, url);
    const active = project.activeDeployment;
    const target = active?.hostPort == null ? null : { address: '127.0.0.1', port: active.hostPort };
    const hostingStatus = await this.#status(this.routes, project, url, target, project.healthCheckPath);
    return { localApplicationUrl: url.origin, hostingStatus };
  }

  async #publicSummary(
    routes: Pick<ApplicationRoutingService, 'readDashboardTargets'>, project: HostingProject, url: URL,
  ): Promise<HostingSummary> {
    const base = { localApplicationUrl: null, publicHostname: url.hostname,
      certificateStatus: 'UNVERIFIED' as const, hostingStatus: 'UNAVAILABLE' as const };
    const approval = await this.policy.read(project).catch(() => undefined);
    if (approval === undefined) {
      return { ...base, approvalStatus: 'UNKNOWN', hostingError: this.#issue('APPROVAL') };
    }
    if (approval === null) return { ...base, approvalStatus: 'UNAPPROVED' };
    if (approval.revokedAt !== null) {
      return { ...base, approvalStatus: approval.withdrawnAt === null ? 'WITHDRAWAL_PENDING' : 'REVOKED' };
    }
    const approved = { ...base, approvalStatus: 'APPROVED' as const, publicApplicationUrl: url.origin };
    if (project.routingOperation === 'STOP' || project.routingOperation === 'DELETE') {
      return { ...approved, hostingStatus: 'RECOVERING' };
    }
    const active = project.activeDeployment;
    if (active === null) {
      const latest = project.deployments[0]?.status;
      return { ...approved, hostingStatus: latest !== undefined && inProgress.has(latest) ? 'DEPLOYING' : 'UNAVAILABLE' };
    }
    if (active.commitHash === null || !approval.commits.includes(active.commitHash)) {
      return { ...approved, hostingError: this.#issue('APPROVAL') };
    }
    try {
      if (active.status !== 'RUNNING' || active.hostPort === null || active.publicAddressIndex === null) {
        throw new PublicHostingReadinessError('ROUTING');
      }
      const target = { address: workloadAddress(active.publicAddressIndex), port: active.hostPort };
      const targets = await routes.readDashboardTargets();
      if (!this.#matches(targets.get(url.hostname), target)) throw new PublicHostingReadinessError('ROUTING');
      const path = publicProbePath(url.hostname, target, project.healthCheckPath);
      await this.#probe(targets, url, path);
      if (!this.#matches((await routes.readDashboardTargets()).get(url.hostname), target)) {
        throw new PublicHostingReadinessError('ROUTING');
      }
      return { ...approved, certificateStatus: 'READY', hostingStatus: 'AVAILABLE', publicProbePath: path };
    } catch (error) {
      const code = error instanceof PublicHostingReadinessError ? error.code : 'ROUTING';
      return { ...approved, certificateStatus: code === 'APPLICATION' ? 'READY' : 'UNVERIFIED',
        hostingStatus: 'RECOVERING', hostingError: this.#issue(code) };
    }
  }

  #issue(code: PublicHostingReadinessError['code']) {
    return { code, message: new PublicHostingReadinessError(code).message };
  }

  #matches(observed: RouteTarget | undefined, target: RouteTarget): boolean {
    return observed?.address === target.address && observed.port === target.port;
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
      if (active?.status === 'RUNNING' && target !== null && this.#matches(route, target)) {
        await this.#probe(targets, url, probePath);
        if (this.#matches((await routes.readDashboardTargets()).get(url.hostname), target)) return 'AVAILABLE';
      }
      if (active === null && deploying && route === undefined && project.routingOperation === 'PROMOTE') {
        return 'DEPLOYING';
      }
    } catch {
      // Unreachable or changing Caddy state cannot confirm an application route.
    }
    return 'RECOVERING';
  }

  #probe(targets: ReadonlyMap<string, RouteTarget>, url: URL, path: string): Promise<void> {
    let probes = this.#probes.get(targets);
    if (probes === undefined) {
      probes = new Map();
      this.#probes.set(targets, probes);
    }
    const key = url.hostname + path;
    const cached = probes.get(key);
    if (cached !== undefined) return cached;
    const result = this.hosting.publicHosting === undefined
      ? this.health.waitUntilHealthy(projectRouteProbe(url, path))
      : this.readiness.verifyDns(url.hostname).then(() => this.readiness.verifyHttps(url, path));
    if (probes.size < MAX_CACHED_PROBES) probes.set(key, result);
    return result;
  }
}

export const projectHostingService = applicationRoutingService === undefined
  ? undefined
  : new ProjectHostingService(applicationRoutingService, env.hosting);
