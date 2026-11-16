import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import type { Deployment, Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/app-error.js';
import { workloadAddress } from '../utils/workload-address.js';
import { localProjectUrl, projectHostnameLabel, projectRouteProbe, publicProbePath } from '../utils/project-hostname.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import { ApplicationRoutingError, createApplicationRoutingService, type ApplicationRoutingService } from './application-routing.service.js';
import { containerService, type RoutingContainer } from './container.service.js';
import { PublicApplicationPolicy } from './public-application-policy.js';
import { assertPublicWorkloadReady } from './public-hosting-safety.service.js';
import {
  projectOperationLockService,
  type ProjectOperationLease,
  type ProjectOperationLock,
} from './project-operation-lock.service.js';

const routingSelect = {
  id: true,
  userId: true,
  repositoryUrl: true,
  branch: true,
  containerPort: true,
  healthCheckPath: true,
  activeDeploymentId: true,
  routingOperation: true,
  routingDeploymentId: true,
  publicApproval: { select: { revokedAt: true, withdrawnAt: true } },
} as const;
type RoutingProject = Prisma.ProjectGetPayload<{ select: typeof routingSelect }>;
type RoutingUpdate = Pick<Prisma.ProjectUncheckedUpdateManyInput,
  'activeDeploymentId' | 'routingOperation' | 'routingDeploymentId'>;
type Candidate = Pick<Deployment, 'id' | 'projectId' | 'containerId' | 'hostPort'> &
  { commitHash?: string | null; publicAddressIndex?: number | null };
type VerifiedTarget = { deployment: Candidate; binding: RoutingContainer; port: number };
type RoutingDatabase = Pick<typeof database, 'project' | 'deployment' | 'publicRoutingBinding' | '$transaction'>;
const clearOperation = { routingOperation: null, routingDeploymentId: null };
const isMissing = (error: unknown): boolean => error instanceof AppError && error.statusCode === 404;

export class RoutingPendingError extends AppError {
  constructor() {
    super(503, 'Application routing could not be confirmed. Containers were retained pending reconciliation');
    this.name = 'RoutingPendingError';
  }
}

export const requireRoutingLease = (lease?: ProjectOperationLease): ProjectOperationLease => {
  if (lease === undefined) throw new RoutingPendingError();
  return lease;
};

export class DeploymentRoutingService {
  #reconciling = false;

  constructor(
    private readonly routes: Pick<ApplicationRoutingService, 'upsert' | 'remove' | 'repair' | 'readPort' | 'readTarget'>,
    private readonly db: RoutingDatabase = database,
    private readonly containers: Pick<typeof containerService,
      'inspectStatus' | 'inspectOwnedDeploymentContainer' | 'inspectLoopbackRoutingPort' | 'stopContainer' |
      'restartContainer' | 'removeDeploymentContainers'> = containerService,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 2, retryDelayMs: 200 }),
    private readonly lock: ProjectOperationLock = projectOperationLockService,
    private readonly hosting: HostingConfig = env.hosting,
    private readonly policy = new PublicApplicationPolicy(hosting),
  ) {}

  public async assertIdle(projectId: string, lease: ProjectOperationLease): Promise<void> {
    await lease.assertValid();
    await this.#idle(projectId);
    if (this.hosting.publicHosting !== undefined && (await this.db.publicRoutingBinding.findUnique({
      where: { id: 1 }, select: { routeRecoveryRequired: true },
    }))?.routeRecoveryRequired === true) throw new RoutingPendingError();
  }

  public async assertPublicPortOwned(): Promise<void> {
    const projectId = this.hosting.publicHosting?.routeProjectId;
    if (projectId === undefined) return;
    try {
      const port = await this.routes.readPort(projectId);
      if (port === null) return;
      const project = await this.#project(projectId);
      for (const id of new Set([project.activeDeploymentId, project.routingDeploymentId])) {
        if (id === null) continue;
        const candidate = await this.#deployment(project, id);
        if (candidate.hostPort === port && await this.#approved(project, candidate) &&
          await this.#matchesRoute(projectId, await this.#binding(project, candidate))) return;
      }
    } catch {
      throw new AppError(503, 'Unable to confirm ownership of the public Caddy port');
    }
    throw new AppError(503, 'The public Caddy port is no longer owned by its deployment');
  }

  public async promote(candidate: Candidate, startedAt: Date, lease: ProjectOperationLease): Promise<Deployment> {
    let committed: Deployment | undefined;
    try {
      const project = await this.#project(candidate.projectId);
      const restarting = project.routingOperation === 'RESTART' && project.routingDeploymentId === candidate.id;
      if (!restarting && project.routingOperation !== null) throw new RoutingPendingError();
      const pending = restarting ? project : await this.#change(project, lease, {
        routingOperation: 'PROMOTE',
        routingDeploymentId: candidate.id,
      });
      const target = await this.#binding(pending, candidate);
      if (target.port !== candidate.hostPort) {
        await this.health.waitUntilHealthy({ hostPort: target.port, path: pending.healthCheckPath,
          ...this.#healthAddress(target) });
      }
      await this.#publish(pending, target, lease, false);
      const previous = pending.activeDeploymentId;
      const retirement = previous === null || previous === candidate.id
        ? clearOperation
        : { routingOperation: 'RETIRE' as const, routingDeploymentId: previous };
      committed = await this.db.$transaction(async (tx) => {
        await this.#updateProject(tx, pending, lease, { activeDeploymentId: candidate.id, ...retirement });
        await this.policy.assertApproved(pending, candidate.commitHash ?? null, tx);
        return tx.deployment.update({
          where: { id: candidate.id, projectId: pending.id },
          data: { status: 'RUNNING', hostPort: target.port, startedAt, finishedAt: null, errorMessage: null },
        });
      });
    } catch {
      // A failed transaction response does not say whether PostgreSQL committed it.
      try {
        await lease.assertValid();
        const current = await this.#project(candidate.projectId);
        if (current.activeDeploymentId === candidate.id &&
          (current.routingOperation === null || current.routingOperation === 'RETIRE')) {
          if (await this.#restore(current, lease, true) === null) throw new RoutingPendingError();
          committed = await this.#deployment(current, candidate.id);
        } else {
          if (current.routingDeploymentId === candidate.id && current.routingOperation === 'RESTART') {
            await this.#abortRestart(current, lease);
          } else if (current.routingDeploymentId === candidate.id && current.routingOperation === 'PROMOTE') {
            await this.#abortPromotion(current, lease);
          } else if (current.routingOperation !== null) {
            throw new RoutingPendingError();
          } else {
            await this.routes.readPort(current.id);
          }
        }
      } catch {
        throw new RoutingPendingError();
      }
    }

    if (committed === undefined) throw new AppError(502, 'Application route activation failed');
    try {
      const project = await this.#project(candidate.projectId);
      if (project.routingOperation === 'RETIRE') await this.#retire(project, lease);
    } catch (error) {
      reportRecoveryFailure(candidate.projectId, error);
    }
    return committed;
  }

  public async stop(projectId: string, deploymentId: string, lease: ProjectOperationLease): Promise<Deployment> {
    const project = await this.#idle(projectId);
    if (project.activeDeploymentId !== deploymentId) {
      const deployment = await this.#deployment(project, deploymentId);
      const remaining = await this.#assertKnown(project, lease);
      await this.#stopContainer(project, deployment, lease, remaining);
      return this.#finish(project, lease, deployment, { activeDeploymentId: project.activeDeploymentId }, {
        status: 'STOPPED', finishedAt: new Date(),
      });
    }
    try {
      const pending = await this.#change(project, lease, { routingOperation: 'STOP', routingDeploymentId: deploymentId });
      return await this.#finishStop(pending, lease);
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async beginRestart(projectId: string, deploymentId: string, lease: ProjectOperationLease): Promise<boolean> {
    const project = await this.#idle(projectId);
    if (project.activeDeploymentId !== deploymentId) {
      await this.#assertKnown(project, lease);
      if (project.activeDeploymentId !== null) return false;
    }
    try {
      const pending = await this.#change(project, lease, { routingOperation: 'RESTART', routingDeploymentId: deploymentId });
      await this.#withdraw(pending, lease, true);
      return true;
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async restartFailed(projectId: string, deploymentId: string, lease: ProjectOperationLease): Promise<boolean> {
    try {
      const project = await this.#project(projectId);
      if (project.routingOperation === 'RESTART' && project.routingDeploymentId === deploymentId) {
        await this.#abortRestart(project, lease);
        return true;
      }
      await this.#assertKnown(project, lease);
      return false;
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async beginDelete(projectId: string, lease: ProjectOperationLease): Promise<{
    deploymentId: string | null; containerId: string | null;
  }> {
    const project = await this.#idle(projectId);
    if (project.activeDeploymentId === null) {
      await this.assertWithdrawn(projectId, lease);
      return { deploymentId: null, containerId: null };
    }
    try {
      const pending = await this.#change(project, lease, {
        routingOperation: 'DELETE',
        routingDeploymentId: project.activeDeploymentId,
      });
      await this.#withdraw(pending, lease, true);
      const deployment = await this.#deployment(pending, project.activeDeploymentId);
      return { deploymentId: deployment.id, containerId: deployment.containerId };
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async assertWithdrawn(projectId: string, lease: ProjectOperationLease): Promise<void> {
    await lease.assertValid();
    if (await this.routes.readPort(projectId) !== null) throw new RoutingPendingError();
  }

  public async withdrawApproval(projectId: string, lease: ProjectOperationLease): Promise<void> {
    try {
      await this.#withdraw(await this.#project(projectId), lease, true);
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async deleteFailed(projectId: string, lease: ProjectOperationLease): Promise<boolean> {
    try {
      // The guarded lease update waits for a concurrent database delete of this row.
      try {
        await lease.assertValid();
      } catch (error) {
        if (await this.db.project.findUnique({ where: { id: projectId }, select: { id: true } }) === null) return false;
        throw error;
      }
      const project = await this.db.project.findUnique({ where: { id: projectId }, select: routingSelect });
      if (project === null) return false;
      if (project.routingOperation === 'DELETE') await this.#recoverDelete(project, lease);
      return true;
    } catch {
      throw new RoutingPendingError();
    }
  }

  public async reconcile(): Promise<void> {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      const projects = await this.db.project.findMany({
        where: {
          ...(this.hosting.publicHosting === undefined
            ? { OR: [{ routingOperation: { not: null } }, { activeDeploymentId: { not: null } }] }
            : { id: this.hosting.publicHosting.routeProjectId ?? { in: [] } }),
        },
        select: { id: true },
      });
      for (const { id } of projects) {
        try {
          await this.lock.runExclusive(id, async (held) => {
            const lease = requireRoutingLease(held);
            const project = await this.#project(id);
            if (this.hosting.publicHosting !== undefined) {
              await this.#recoverPublicRoute(project, lease);
              if (project.publicApproval?.revokedAt != null) {
                if (project.publicApproval.withdrawnAt !== null) await this.#withdrawRevokedDrift(project, lease);
                return;
              }
            }
            switch (project.routingOperation) {
              case 'PROMOTE': await this.#abortPromotion(project, lease); break;
              case 'ABORT':
                if (project.activeDeploymentId === project.routingDeploymentId) await this.#abortRestart(project, lease);
                else await this.#abortPromotion(project, lease);
                break;
              case 'STOP': await this.#finishStop(project, lease); break;
              case 'RETIRE': await this.#retire(project, lease); break;
              case 'RESTART': await this.#recoverRestart(project, lease); break;
              case 'DELETE': await this.#recoverDelete(project, lease); break;
              case null: await this.#restoreCommitted(project, lease); break;
            }
          });
        } catch (error) {
          if (!(error instanceof AppError && error.statusCode === 409)) reportRecoveryFailure(id, error);
        }
      }
    } finally {
      this.#reconciling = false;
    }
  }

  async #recoverPublicRoute(project: RoutingProject, lease: ProjectOperationLease): Promise<void> {
    const where = { id: 1, projectId: project.id };
    const binding = await this.db.publicRoutingBinding.findUnique({
      where, select: { routeRecoveryRequired: true },
    });
    if (binding?.routeRecoveryRequired !== true) return;
    await this.#withdraw(project, lease, true);
    await this.db.$transaction(async (tx) => {
      await lease.assertValid(tx);
      await tx.publicRoutingBinding.update({ where, data: { routeRecoveryRequired: false } });
    });
  }

  async #withdrawRevokedDrift(project: RoutingProject, lease: ProjectOperationLease): Promise<void> {
    try {
      await this.#withdraw(project, lease, false);
    } catch (error) {
      if (!(error instanceof ApplicationRoutingError && error.code === 'uncertain')) throw error;
      await this.#withdraw(project, lease, true);
    }
  }

  async #project(id: string): Promise<RoutingProject> {
    const project = await this.db.project.findUnique({ where: { id }, select: routingSelect });
    if (project === null) throw new AppError(404, 'Project not found');
    return project;
  }

  async #idle(id: string): Promise<RoutingProject> {
    const project = await this.#project(id);
    if (project.routingOperation !== null) throw new RoutingPendingError();
    return project;
  }

  async #deployment(project: RoutingProject, id: string | null): Promise<Deployment> {
    if (id === null) throw new RoutingPendingError();
    const deployment = await this.db.deployment.findFirst({ where: { id, projectId: project.id } });
    if (deployment === null) throw new RoutingPendingError();
    return deployment;
  }

  async #updateProject(
    db: Pick<Prisma.TransactionClient, 'project'>,
    project: RoutingProject,
    lease: ProjectOperationLease,
    data: RoutingUpdate,
  ): Promise<void> {
    const result = await db.project.updateMany({
      where: {
        id: project.id, operationLockToken: lease.token, operationLockExpiresAt: { gt: new Date() },
        activeDeploymentId: project.activeDeploymentId,
        routingOperation: project.routingOperation, routingDeploymentId: project.routingDeploymentId,
      },
      data,
    });
    if (result.count !== 1) throw new RoutingPendingError();
  }

  async #change(project: RoutingProject, lease: ProjectOperationLease, data: RoutingUpdate): Promise<RoutingProject> {
    await this.#updateProject(this.db, project, lease, data);
    return this.#project(project.id);
  }

  async #finish(
    project: RoutingProject, lease: ProjectOperationLease, deployment: Deployment,
    projectData: RoutingUpdate, deploymentData: Prisma.DeploymentUncheckedUpdateInput,
  ): Promise<Deployment> {
    return this.db.$transaction(async (tx) => {
      await this.#updateProject(tx, project, lease, projectData);
      return tx.deployment.update({ where: { id: deployment.id, projectId: project.id }, data: deploymentData });
    });
  }

  async #binding(project: RoutingProject, deployment: Candidate): Promise<VerifiedTarget> {
    if (deployment.projectId !== project.id || deployment.containerId === null) throw new RoutingPendingError();
    if (this.hosting.publicHosting !== undefined && deployment.publicAddressIndex == null) {
      throw new AppError(422, 'The legacy deployment needs a new reserved loopback address before publication');
    }
    const binding = { deploymentId: deployment.id, containerId: deployment.containerId, containerPort: project.containerPort,
      ...(deployment.publicAddressIndex == null ? {} : { hostAddress: workloadAddress(deployment.publicAddressIndex) }) };
    return { deployment, binding, port: await this.containers.inspectLoopbackRoutingPort(binding) };
  }

  #healthAddress(target: VerifiedTarget) {
    return target.binding.hostAddress === undefined ? {} : { hostAddress: target.binding.hostAddress };
  }

  async #matchesRoute(projectId: string, target: VerifiedTarget) {
    const observed = await this.routes.readTarget(projectId);
    return observed?.port === target.port && observed.address === (target.binding.hostAddress ?? '127.0.0.1');
  }

  async #inspect(deployment: Candidate) {
    if (deployment.containerId === null) return null;
    try {
      const result = await this.containers.inspectStatus(deployment.containerId);
      if (result.containerId !== deployment.containerId) throw new RoutingPendingError();
      return result;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #healthy(project: RoutingProject, deployment: Deployment): Promise<VerifiedTarget | null> {
    if (!await this.#approved(project, deployment)) return null;
    if (!(await this.#inspect(deployment))?.running) return null;
    let target: VerifiedTarget;
    try {
      target = await this.#binding(project, deployment);
    } catch (error) {
      if (isMissing(error) || (this.hosting.publicHosting !== undefined && error instanceof AppError && error.statusCode === 422)) {
        return null;
      }
      throw error;
    }
    try {
      await this.health.waitUntilHealthy({ hostPort: target.port, path: project.healthCheckPath, ...this.#healthAddress(target) });
      return target;
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 422) return null;
      throw error;
    }
  }

  async #approved(project: RoutingProject, deployment: Deployment): Promise<boolean> {
    try {
      await this.policy.assertApproved(project, deployment.commitHash);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 403) return false;
      throw error;
    }
  }

  async #publish(project: RoutingProject, target: VerifiedTarget, lease: ProjectOperationLease, fence: boolean) {
    const authorizeWrite = async () => {
      await this.policy.assertApproved(project, target.deployment.commitHash ?? null);
      await lease.assertValid();
    };
    await authorizeWrite();
    if (this.hosting.publicHosting !== undefined && target.deployment.hostPort !== target.port) {
      await this.db.$transaction(async (tx) => {
        await lease.assertValid(tx);
        await tx.deployment.update({
          where: { id: target.deployment.id, projectId: project.id }, data: { hostPort: target.port },
        });
      });
    }
    const options = { expectedPort: target.port, beforeWrite: authorizeWrite,
      ...(this.hosting.publicHosting === undefined ? {} : { healthPath: project.healthCheckPath }) };
    if (fence) await this.routes.repair(project.id, target.binding, options);
    else await this.routes.upsert(project.id, target.binding, options);
    const url = new URL(localProjectUrl(projectHostnameLabel(project.id), this.hosting));
    const path = this.hosting.publicHosting === undefined ? project.healthCheckPath : publicProbePath(url.hostname, {
      address: target.binding.hostAddress ?? '127.0.0.1', port: target.port,
    }, project.healthCheckPath);
    await this.health.waitUntilHealthy(projectRouteProbe(url, path));
    if (!await this.#matchesRoute(project.id, target)) throw new RoutingPendingError();
  }

  async #withdraw(project: RoutingProject, lease: ProjectOperationLease, fence: boolean): Promise<void> {
    await lease.assertValid();
    const options = { beforeWrite: lease.assertValid };
    if (fence) await this.routes.repair(project.id, undefined, options);
    else await this.routes.remove(project.id, options);
    await this.assertWithdrawn(project.id, lease);
  }

  async #restore(project: RoutingProject, lease: ProjectOperationLease, fence = false): Promise<VerifiedTarget | null> {
    const deployment = project.activeDeploymentId === null ? null : await this.#deployment(project, project.activeDeploymentId);
    let target = deployment === null ? null : await this.#healthy(project, deployment);
    if (target === null) await this.#withdraw(project, lease, fence);
    else {
      try {
        await this.#publish(project, target, lease, fence);
      } catch (error) {
        if (!(error instanceof AppError && error.statusCode === 422)) throw error;
        await this.#withdraw(project, lease, true);
        target = null;
      }
    }
    const port = target?.port ?? null;
    if (deployment !== null && deployment.hostPort !== port &&
      (this.hosting.publicHosting === undefined || deployment.publicAddressIndex !== null)) {
      await this.#finish(project, lease, deployment, { activeDeploymentId: project.activeDeploymentId }, { hostPort: port });
    }
    return target;
  }

  async #assertKnown(project: RoutingProject, lease: ProjectOperationLease): Promise<VerifiedTarget | null> {
    await lease.assertValid();
    const port = await this.routes.readPort(project.id);
    if (port === null) return null;
    const deployment = await this.#deployment(project, project.activeDeploymentId);
    const target = await this.#binding(project, deployment);
    if (!await this.#matchesRoute(project.id, target)) throw new RoutingPendingError();
    return target;
  }

  async #restoreCommitted(project: RoutingProject, lease: ProjectOperationLease): Promise<VerifiedTarget | null> {
    try {
      return await this.#restore(project, lease);
    } catch (error) {
      if (!(error instanceof ApplicationRoutingError && error.code === 'uncertain')) throw error;
      return this.#restore(project, lease, true);
    }
  }

  async #stopContainer(project: RoutingProject, deployment: Deployment, lease: ProjectOperationLease,
    remaining: VerifiedTarget | null = null) {
    if (deployment.containerId === null) return;
    const runtime = await this.containers.inspectOwnedDeploymentContainer(deployment.containerId, deployment.id);
    if (runtime === null || (!runtime.running && ['created', 'exited', 'dead'].includes(runtime.status))) return;

    // A restarting container can temporarily have no live port binding. Check the route
    // against the verified remaining deployment, or require complete withdrawal.
    if (remaining === null) await this.assertWithdrawn(project.id, lease);
    else if (remaining.binding.containerId === runtime.containerId || !await this.#matchesRoute(project.id, remaining)) {
      throw new RoutingPendingError();
    }
    await lease.assertValid();
    await this.containers.stopContainer(runtime.containerId);
  }

  async #removeUnrouted(project: RoutingProject, deployment: Deployment, lease: ProjectOperationLease) {
    const assertSafe = async () => {
      await lease.assertValid();
      const target = await this.routes.readTarget(project.id);
      if (target?.address === workloadAddress(deployment.publicAddressIndex)) throw new RoutingPendingError();
    };
    await assertSafe();
    await this.containers.removeDeploymentContainers(deployment.id, deployment.containerId, assertSafe);
  }

  async #abortPromotion(project: RoutingProject, lease: ProjectOperationLease) {
    const candidate = await this.#deployment(project, project.routingDeploymentId);
    if (candidate.id === project.activeDeploymentId) throw new RoutingPendingError();
    const abort = await this.#beginAbort(project, lease);
    const remaining = await this.#restore(abort, lease, true);
    const publicMode = this.hosting.publicHosting !== undefined;
    if (publicMode) await this.#removeUnrouted(abort, candidate, lease);
    else await this.#stopContainer(abort, candidate, lease, remaining);
    await this.#finish(abort, lease, candidate, clearOperation, {
      status: 'FAILED', finishedAt: new Date(), errorMessage: 'Application routing promotion did not commit',
      ...(publicMode ? { containerId: null, hostPort: null } : {}),
    });
  }

  async #retire(project: RoutingProject, lease: ProjectOperationLease) {
    const old = await this.#deployment(project, project.routingDeploymentId);
    if (old.id === project.activeDeploymentId) throw new RoutingPendingError();
    const remaining = await this.#restoreCommitted(project, lease);
    const legacy = this.hosting.publicHosting !== undefined && old.publicAddressIndex === null;
    if (legacy) {
      // Publication needs a reserved address. Removal only needs verified Docker ownership
      // and confirmation that Caddy is no longer pointing at a legacy loopback target.
      await this.#removeUnrouted(project, old, lease);
    } else {
      await this.#stopContainer(project, old, lease, remaining);
    }
    await this.#finish(project, lease, old, clearOperation, {
      status: 'STOPPED', finishedAt: new Date(), ...(legacy ? { containerId: null, hostPort: null } : {}),
    });
  }

  async #finishStop(project: RoutingProject, lease: ProjectOperationLease): Promise<Deployment> {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    await this.#withdraw(project, lease, true);
    const legacy = this.hosting.publicHosting !== undefined && deployment.publicAddressIndex === null;
    if (legacy) await this.#removeUnrouted(project, deployment, lease);
    else await this.#stopContainer(project, deployment, lease);
    return this.#finish(project, lease, deployment, { ...clearOperation, activeDeploymentId: null }, {
      status: 'STOPPED', finishedAt: new Date(), errorMessage: null,
      ...(legacy ? { containerId: null, hostPort: null } : {}),
    });
  }

  async #abortRestart(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (project.activeDeploymentId !== null && deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    const abort = await this.#beginAbort(project, lease);
    await this.#withdraw(abort, lease, true);
    const publicMode = this.hosting.publicHosting !== undefined;
    if (publicMode) {
      // Docker can finish a timed-out restart after a read reports the container stopped.
      await this.containers.removeDeploymentContainers(deployment.id, deployment.containerId,
        () => this.assertWithdrawn(project.id, lease));
    } else {
      await this.#stopContainer(abort, deployment, lease);
    }
    await this.#finish(abort, lease, deployment, { ...clearOperation, activeDeploymentId: null }, {
      status: 'FAILED', finishedAt: new Date(), errorMessage: 'Application restart could not restore its route',
      ...(publicMode ? { containerId: null, hostPort: null } : {}),
    });
  }

  async #beginAbort(project: RoutingProject, lease: ProjectOperationLease): Promise<RoutingProject> {
    // A delayed promotion commit must still match PROMOTE or RESTART. Claim the
    // abort on the same row before changing the route or stopping a container.
    return project.routingOperation === 'ABORT' ? project : this.#change(project, lease, { routingOperation: 'ABORT' });
  }

  async #recoverRestart(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (project.activeDeploymentId !== null && deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    const target = await this.#healthy(project, deployment);
    if (target === null) {
      await this.#abortRestart(project, lease);
      return;
    }
    await this.#publish(project, target, lease, true);
    await this.#finish(project, lease, deployment, { ...clearOperation, activeDeploymentId: deployment.id }, {
      status: 'RUNNING', hostPort: target.port, finishedAt: null, errorMessage: null,
    });
  }

  async #recoverDelete(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    if (!await this.#approved(project, deployment) ||
      (this.hosting.publicHosting !== undefined && deployment.publicAddressIndex === null)) {
      await this.#finishStop(project, lease);
      return;
    }
    const runtime = await this.#inspect(deployment);
    if (runtime === null) {
      await this.#withdraw(project, lease, true);
      await this.#finish(project, lease, deployment, { ...clearOperation, activeDeploymentId: null }, {
        status: 'STOPPED', hostPort: null, finishedAt: new Date(),
        errorMessage: 'Project deletion was interrupted after the application container was removed',
      });
      return;
    }
    if (!runtime.running && deployment.containerId !== null) {
      await this.#withdraw(project, lease, true);
      await this.policy.assertApproved(project, deployment.commitHash);
      if (this.hosting.publicHosting !== undefined) await assertPublicWorkloadReady(project.id);
      await this.assertPublicPortOwned();
      await lease.assertValid();
      await this.containers.restartContainer(deployment.containerId, project.containerPort,
        deployment.publicAddressIndex === null ? undefined : workloadAddress(deployment.publicAddressIndex));
    }
    const target = await this.#healthy(project, deployment);
    if (target === null) {
      await this.#withdraw(project, lease, true);
      throw new RoutingPendingError();
    }
    await this.#publish(project, target, lease, true);
    await this.#finish(project, lease, deployment, clearOperation, {
      status: 'RUNNING', hostPort: target.port, finishedAt: null, errorMessage: null,
    });
  }
}

const reportRecoveryFailure = (id: string, error: unknown): void => {
  const reason = error instanceof ApplicationRoutingError ? error.code : error instanceof Error ? error.name : 'Unknown error';
  console.warn('Deployment routing needs reconciliation for project', id, reason);
};

export const applicationRoutingService = createApplicationRoutingService();
export const deploymentRoutingService = applicationRoutingService === undefined
  ? undefined
  : new DeploymentRoutingService(applicationRoutingService);
