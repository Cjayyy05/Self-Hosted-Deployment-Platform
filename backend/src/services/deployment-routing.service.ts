import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import type { Deployment, Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/app-error.js';
import { localProjectUrl, projectHostnameLabel, projectRouteProbe } from '../utils/project-hostname.js';
import { ApplicationHealthCheckService } from './application-health-check.service.js';
import { ApplicationRoutingError, createApplicationRoutingService, type ApplicationRoutingService } from './application-routing.service.js';
import { containerService, type RoutingContainer } from './container.service.js';
import { assertApprovedCommit, assertApprovedSource } from './public-application-policy.js';
import {
  projectOperationLockService,
  type ProjectOperationLease,
  type ProjectOperationLock,
} from './project-operation-lock.service.js';

const routingSelect = {
  id: true,
  repositoryUrl: true,
  branch: true,
  containerPort: true,
  healthCheckPath: true,
  activeDeploymentId: true,
  routingOperation: true,
  routingDeploymentId: true,
} as const;
type RoutingProject = Prisma.ProjectGetPayload<{ select: typeof routingSelect }>;
type RoutingUpdate = Pick<Prisma.ProjectUncheckedUpdateManyInput,
  'activeDeploymentId' | 'routingOperation' | 'routingDeploymentId'>;
type Candidate = Pick<Deployment, 'id' | 'projectId' | 'containerId' | 'hostPort'> & { commitHash?: string | null };
type VerifiedTarget = { deployment: Candidate; binding: RoutingContainer; port: number };
type RoutingDatabase = Pick<typeof database, 'project' | 'deployment' | '$transaction'>;
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
    private readonly routes: Pick<ApplicationRoutingService, 'upsert' | 'remove' | 'repair' | 'readPort'>,
    private readonly db: RoutingDatabase = database,
    private readonly containers: Pick<typeof containerService,
      'inspectStatus' | 'inspectLoopbackRoutingPort' | 'stopContainer' | 'restartContainer'> = containerService,
    private readonly health: Pick<ApplicationHealthCheckService, 'waitUntilHealthy'> =
      new ApplicationHealthCheckService({ maxAttempts: 2, retryDelayMs: 200 }),
    private readonly lock: ProjectOperationLock = projectOperationLockService,
    private readonly hosting: HostingConfig = env.hosting,
  ) {}

  public async assertIdle(projectId: string, lease: ProjectOperationLease): Promise<void> {
    await lease.assertValid();
    await this.#idle(projectId);
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
        await this.health.waitUntilHealthy({ hostPort: target.port, path: pending.healthCheckPath });
      }
      await this.#publish(pending, target, lease, false);
      const previous = pending.activeDeploymentId;
      const retirement = previous === null || previous === candidate.id
        ? clearOperation
        : { routingOperation: 'RETIRE' as const, routingDeploymentId: previous };
      committed = await this.db.$transaction(async (tx) => {
        await this.#updateProject(tx, pending, lease, { activeDeploymentId: candidate.id, ...retirement });
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

  public async stop(projectId: string, deploymentId: string, lease: ProjectOperationLease): Promise<Deployment | null> {
    const project = await this.#idle(projectId);
    if (project.activeDeploymentId !== deploymentId) {
      await this.#assertKnown(project, lease);
      return null;
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
      return project.activeDeploymentId === null;
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
          ...(this.hosting.publicApp === undefined ? {} : { id: this.hosting.publicApp.projectId }),
          OR: [{ routingOperation: { not: null } }, { activeDeploymentId: { not: null } }],
        },
        select: { id: true },
      });
      for (const { id } of projects) {
        try {
          await this.lock.runExclusive(id, async (held) => {
            const lease = requireRoutingLease(held);
            const project = await this.#project(id);
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
    const binding = { deploymentId: deployment.id, containerId: deployment.containerId, containerPort: project.containerPort };
    return { deployment, binding, port: await this.containers.inspectLoopbackRoutingPort(binding) };
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
    try {
      assertApprovedSource(this.hosting.publicApp, project);
      assertApprovedCommit(this.hosting.publicApp, deployment.commitHash);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 403) return null;
      throw error;
    }
    if (!(await this.#inspect(deployment))?.running) return null;
    let target: VerifiedTarget;
    try {
      target = await this.#binding(project, deployment);
    } catch (error) {
      if (isMissing(error) || (this.hosting.publicApp !== undefined && error instanceof AppError && error.statusCode === 422)) {
        return null;
      }
      throw error;
    }
    try {
      await this.health.waitUntilHealthy({ hostPort: target.port, path: project.healthCheckPath });
      return target;
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 422) return null;
      throw error;
    }
  }

  async #publish(project: RoutingProject, target: VerifiedTarget, lease: ProjectOperationLease, fence: boolean) {
    assertApprovedSource(this.hosting.publicApp, project);
    assertApprovedCommit(this.hosting.publicApp, target.deployment.commitHash ?? null);
    await lease.assertValid();
    const options = { expectedPort: target.port, beforeWrite: lease.assertValid,
      ...(this.hosting.publicApp === undefined ? {} : { healthPath: project.healthCheckPath }) };
    if (fence) await this.routes.repair(project.id, target.binding, options);
    else await this.routes.upsert(project.id, target.binding, options);
    const url = new URL(localProjectUrl(projectHostnameLabel(project.id), this.hosting));
    await this.health.waitUntilHealthy(projectRouteProbe(url, project.healthCheckPath));
    if (await this.routes.readPort(project.id) !== target.port) throw new RoutingPendingError();
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
    if (deployment !== null && deployment.hostPort !== port) {
      await this.#finish(project, lease, deployment, { activeDeploymentId: project.activeDeploymentId }, { hostPort: port });
    }
    return target;
  }

  async #assertKnown(project: RoutingProject, lease: ProjectOperationLease): Promise<void> {
    await lease.assertValid();
    const port = await this.routes.readPort(project.id);
    if (port === null) return;
    const deployment = await this.#deployment(project, project.activeDeploymentId);
    if ((await this.#binding(project, deployment)).port !== port) throw new RoutingPendingError();
  }

  async #restoreCommitted(project: RoutingProject, lease: ProjectOperationLease): Promise<VerifiedTarget | null> {
    try {
      return await this.#restore(project, lease);
    } catch (error) {
      if (!(error instanceof ApplicationRoutingError && error.code === 'uncertain')) throw error;
      return this.#restore(project, lease, true);
    }
  }

  async #stopContainer(project: RoutingProject, deployment: Deployment, lease: ProjectOperationLease) {
    if ((await this.#inspect(deployment))?.running && deployment.containerId !== null) {
      const target = await this.#binding(project, deployment);
      if (await this.routes.readPort(project.id) === target.port) throw new RoutingPendingError();
      await lease.assertValid();
      await this.containers.stopContainer(deployment.containerId);
    }
  }

  async #abortPromotion(project: RoutingProject, lease: ProjectOperationLease) {
    const candidate = await this.#deployment(project, project.routingDeploymentId);
    if (candidate.id === project.activeDeploymentId) throw new RoutingPendingError();
    const abort = await this.#beginAbort(project, lease);
    await this.#restore(abort, lease, true);
    await this.#stopContainer(abort, candidate, lease);
    await this.#finish(abort, lease, candidate, clearOperation, {
      status: 'FAILED', finishedAt: new Date(), errorMessage: 'Application routing promotion did not commit',
    });
  }

  async #retire(project: RoutingProject, lease: ProjectOperationLease) {
    const old = await this.#deployment(project, project.routingDeploymentId);
    if (old.id === project.activeDeploymentId || await this.#restoreCommitted(project, lease) === null) {
      throw new RoutingPendingError();
    }
    await this.#stopContainer(project, old, lease);
    await this.#finish(project, lease, old, clearOperation, { status: 'STOPPED', finishedAt: new Date() });
  }

  async #finishStop(project: RoutingProject, lease: ProjectOperationLease): Promise<Deployment> {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    await this.#withdraw(project, lease, true);
    await this.#stopContainer(project, deployment, lease);
    return this.#finish(project, lease, deployment, { ...clearOperation, activeDeploymentId: null }, {
      status: 'STOPPED', finishedAt: new Date(), errorMessage: null,
    });
  }

  async #abortRestart(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    const abort = await this.#beginAbort(project, lease);
    await this.#withdraw(abort, lease, true);
    await this.#stopContainer(abort, deployment, lease);
    await this.#finish(abort, lease, deployment, { ...clearOperation, activeDeploymentId: null }, {
      status: 'FAILED', finishedAt: new Date(), errorMessage: 'Application restart could not restore its route',
    });
  }

  async #beginAbort(project: RoutingProject, lease: ProjectOperationLease): Promise<RoutingProject> {
    // A delayed promotion commit must still match PROMOTE or RESTART. Claim the
    // abort on the same row before changing the route or stopping a container.
    return project.routingOperation === 'ABORT' ? project : this.#change(project, lease, { routingOperation: 'ABORT' });
  }

  async #recoverRestart(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
    const target = await this.#healthy(project, deployment);
    if (target === null) {
      await this.#abortRestart(project, lease);
      return;
    }
    await this.#publish(project, target, lease, true);
    await this.#finish(project, lease, deployment, clearOperation, {
      status: 'RUNNING', hostPort: target.port, finishedAt: null, errorMessage: null,
    });
  }

  async #recoverDelete(project: RoutingProject, lease: ProjectOperationLease) {
    const deployment = await this.#deployment(project, project.routingDeploymentId);
    if (deployment.id !== project.activeDeploymentId) throw new RoutingPendingError();
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
      assertApprovedSource(this.hosting.publicApp, project);
      assertApprovedCommit(this.hosting.publicApp, deployment.commitHash);
      await lease.assertValid();
      await this.containers.restartContainer(deployment.containerId, project.containerPort);
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
