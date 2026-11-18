import { env, type HostingConfig } from '../config/env.js';
import type { DeploymentStatus, RoutingOperation } from '../generated/prisma/client.js';
import { localProjectUrl, projectRouteProbe, publicProbePath, type RouteTarget } from '../utils/project-hostname.js';
import { workloadAddress } from '../utils/workload-address.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import type { ApplicationRoutingService } from './application-routing.service.js';
import { applicationRoutingService } from './deployment-routing.service.js';
import { PublicApplicationPolicy, type ApprovalProject } from './public-application-policy.js';
import { PublicHostingReadinessError, PublicHostingReadinessService } from './public-hosting-readiness.service.js';

type PublicProbeStatus = 'AVAILABLE' | 'VERIFYING_DNS' | 'DNS_UNVERIFIED';
type HostingStatus = PublicProbeStatus | 'DISABLED' | 'VERIFYING_HTTPS' | 'DEPLOYING' | 'UNAVAILABLE' | 'RECOVERING';
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
  activeDeployment: { id: string; status: DeploymentStatus; hostPort: number | null; publicAddressIndex: number | null; commitHash: string | null } | null;
  routingOperation: RoutingOperation | null;
  deployments: { status: DeploymentStatus }[];
};

const inProgress: ReadonlySet<DeploymentStatus> = new Set([
  'QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTHCHECKING',
]);
const MAX_CACHED_PROBES = 128;
const LAST_VERIFIED_DNS_MS = 20_000;
const TRANSIENT_DNS_FAILURE_LIMIT = 3;

type PublicProbe = {
  key: string;
  verifiedAt: number;
  transientFailures: number;
  pending?: Promise<PublicProbeStatus>;
};

export class ProjectHostingService {
  readonly #probes = new WeakMap<ReadonlyMap<string, RouteTarget>, Map<string, Promise<void>>>();
  readonly #publicProbes = new Map<string, PublicProbe>();

  constructor(
    private readonly routes: Pick<ApplicationRoutingService, 'readDashboardTargets'> | undefined,
    private readonly hosting: HostingConfig,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 1, requestTimeoutMs: 1_000 }),
    private readonly policy: Pick<PublicApplicationPolicy, 'read'> = new PublicApplicationPolicy(hosting),
    private readonly readiness: Pick<PublicHostingReadinessService, 'verifyDashboardDns' | 'verifyHttps'> = new PublicHostingReadinessService(hosting),
    private readonly now = () => performance.now(),
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
    const approval = await this.#publicApproval(project);
    if (approval.approvalStatus !== 'APPROVED' || approval.hostingError !== undefined) {
      this.#publicProbes.delete(project.id);
      return { ...base, ...approval };
    }
    const approved = { ...base, approvalStatus: 'APPROVED' as const, publicApplicationUrl: url.origin };
    if (project.routingOperation === 'STOP' || project.routingOperation === 'DELETE') {
      this.#publicProbes.delete(project.id);
      return { ...approved, hostingStatus: 'RECOVERING' };
    }
    const active = project.activeDeployment;
    if (active === null) {
      this.#publicProbes.delete(project.id);
      const latest = project.deployments[0]?.status;
      return { ...approved, hostingStatus: latest !== undefined && inProgress.has(latest) ? 'DEPLOYING' : 'UNAVAILABLE' };
    }
    if (active.status !== 'RUNNING' || active.hostPort === null || active.publicAddressIndex === null) {
      this.#publicProbes.delete(project.id);
      return { ...approved, hostingStatus: 'RECOVERING', hostingError: this.#issue('ROUTING') };
    }
    try {
      const target = { address: workloadAddress(active.publicAddressIndex), port: active.hostPort };
      const path = publicProbePath(url.hostname, target, project.healthCheckPath);
      const key = [active.id, active.commitHash, path].join(':');
      const probe = this.#publicProbe(project.id, key);
      const hostingStatus = await this.#verifyPublic(routes, project.id, probe, url, path, target);
      const latestApproval = await this.#publicApproval(project);
      if (latestApproval.approvalStatus !== 'APPROVED' || latestApproval.hostingError !== undefined) {
        if (this.#publicProbes.get(project.id) === probe) this.#publicProbes.delete(project.id);
        return { ...base, ...latestApproval };
      }
      if (this.#publicProbes.get(project.id) !== probe) {
        throw new PublicHostingReadinessError('ROUTING');
      }
      return { ...approved, certificateStatus: 'READY', hostingStatus,
        ...(hostingStatus === 'DNS_UNVERIFIED' ? {} : { publicProbePath: path }) };
    } catch (error) {
      const code = error instanceof PublicHostingReadinessError ? error.code : 'ROUTING';
      return { ...approved, certificateStatus: code === 'APPLICATION' ? 'READY' : 'UNVERIFIED',
        hostingStatus: 'RECOVERING', hostingError: this.#issue(code) };
    }
  }

  async #publicApproval(project: HostingProject): Promise<Pick<HostingSummary, 'hostingError'> &
    { approvalStatus: NonNullable<HostingSummary['approvalStatus']> }> {
    const approval = await this.policy.read(project).catch(() => undefined);
    if (approval === undefined) return { approvalStatus: 'UNKNOWN', hostingError: this.#issue('APPROVAL') };
    if (approval === null) return { approvalStatus: 'UNAPPROVED' };
    if (approval.revokedAt !== null) {
      return { approvalStatus: approval.withdrawnAt === null ? 'WITHDRAWAL_PENDING' : 'REVOKED' };
    }
    const active = project.activeDeployment;
    if (active !== null && (active.commitHash === null || !approval.commits.includes(active.commitHash))) {
      return { approvalStatus: 'APPROVED', hostingError: this.#issue('APPROVAL') };
    }
    return { approvalStatus: 'APPROVED' };
  }

  #publicProbe(projectId: string, key: string): PublicProbe {
    const previous = this.#publicProbes.get(projectId);
    const probe = previous?.key === key ? previous : { key, verifiedAt: -Infinity, transientFailures: 0 };
    this.#publicProbes.delete(projectId);
    this.#publicProbes.set(projectId, probe);
    if (this.#publicProbes.size > MAX_CACHED_PROBES) {
      const oldest = this.#publicProbes.keys().next().value;
      if (oldest !== undefined) this.#publicProbes.delete(oldest);
    }
    return probe;
  }

  #verifyPublic(
    routes: Pick<ApplicationRoutingService, 'readDashboardTargets'>, projectId: string,
    probe: PublicProbe, url: URL, path: string, target: RouteTarget,
  ): Promise<PublicProbeStatus> {
    return probe.pending ??= (async () => {
      if (!this.#matches((await routes.readDashboardTargets()).get(url.hostname), target)) {
        throw new PublicHostingReadinessError('ROUTING');
      }
      const [dnsVerified] = await Promise.all([
        this.readiness.verifyDashboardDns(url.hostname),
        this.readiness.verifyHttps(url, path),
      ]);
      if (!this.#matches((await routes.readDashboardTargets()).get(url.hostname), target)) {
        throw new PublicHostingReadinessError('ROUTING');
      }
      if (dnsVerified) {
        probe.verifiedAt = this.now();
        probe.transientFailures = 0;
        return 'AVAILABLE';
      }
      probe.transientFailures = Math.min(probe.transientFailures + 1, TRANSIENT_DNS_FAILURE_LIMIT);
      return probe.transientFailures < TRANSIENT_DNS_FAILURE_LIMIT && this.now() - probe.verifiedAt < LAST_VERIFIED_DNS_MS
        ? 'VERIFYING_DNS' : 'DNS_UNVERIFIED';
    })().catch((error: unknown) => {
      if (this.#publicProbes.get(projectId) === probe) this.#publicProbes.delete(projectId);
      throw error;
    }).finally(() => { delete probe.pending; });
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
    const result = this.health.waitUntilHealthy(projectRouteProbe(url, path));
    if (probes.size < MAX_CACHED_PROBES) probes.set(key, result);
    return result;
  }
}

export const projectHostingService = applicationRoutingService === undefined
  ? undefined
  : new ProjectHostingService(applicationRoutingService, env.hosting);
