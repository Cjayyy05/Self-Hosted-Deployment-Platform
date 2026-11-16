import { database } from '../config/database.js';
import { env, managesProjectRoute } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { containerService } from './container.service.js';
import { buildNetworkService } from './build-network.service.js';
import { deploymentRoutingService, requireRoutingLease, RoutingPendingError } from './deployment-routing.service.js';
import { assertApprovalSource, assertPublicOperator, publicApplicationPolicy } from './public-application-policy.js';
import { projectOperationLockService, type ProjectOperationLease } from './project-operation-lock.service.js';

const getOwnedSource = async (userId: string, projectId: string) => {
  if (env.hosting.publicHosting === undefined) throw new AppError(409, 'Public hosting mode is disabled');
  assertPublicOperator(userId);
  const project = await database.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, userId: true, repositoryUrl: true, branch: true },
  });
  if (project === null) throw new AppError(404, 'Project not found');
  return project;
};

export const getProjectApproval = async (userId: string, projectId: string) => {
  const approval = await publicApplicationPolicy.read(await getOwnedSource(userId, projectId));
  return summarizeApproval(approval);
};

const summarizeApproval = (approval: Awaited<ReturnType<typeof publicApplicationPolicy.read>>) => {
  if (approval === null) return { status: 'UNAPPROVED' as const };
  const status = approval.revokedAt === null ? 'APPROVED' :
    approval.withdrawnAt === null ? 'WITHDRAWAL_PENDING' : 'REVOKED';
  return { ...approval, status };
};

export const approveProjectRevision = async (
  userId: string,
  projectId: string,
  source: { repositoryUrl: string; branch: string; commitHash: string },
) => {
  const project = await getOwnedSource(userId, projectId);
  assertApprovalSource(project, source);
  return projectOperationLockService.runExclusive(projectId, async (held) => {
    const lease = requireRoutingLease(held);
    return database.$transaction(async (tx) => {
      await lease.assertValid(tx);
      const previous = await publicApplicationPolicy.read(project, tx);
      if (previous !== null && previous.revokedAt !== null && previous.withdrawnAt === null) {
        throw new AppError(409, 'Complete the pending withdrawal before approving another revision');
      }
      const approvedAt = new Date();
      await tx.projectPublicApproval.upsert({
        where: { projectId },
        create: { projectId, repositoryUrl: source.repositoryUrl, branch: source.branch, approvedById: userId, approvedAt },
        update: previous?.revokedAt ? { approvedById: userId, approvedAt, revokedAt: null, withdrawnAt: null } : {},
      });
      if (previous?.source === 'LEGACY') {
        await tx.projectPublicRevision.createMany({
          data: previous.commits.map((commitHash) => ({ projectId, commitHash })),
          skipDuplicates: true,
        });
      }
      await tx.projectPublicRevision.upsert({
        where: { projectId_commitHash: { projectId, commitHash: source.commitHash } },
        create: { projectId, commitHash: source.commitHash, approvedAt },
        update: { revokedAt: null, approvedAt },
      });
      return summarizeApproval(await publicApplicationPolicy.read(project, tx));
    });
  });
};

export const revokeProjectApproval = async (userId: string, projectId: string) => {
  const project = await getOwnedSource(userId, projectId);
  return projectOperationLockService.runExclusive(projectId, async (held) => {
    const lease = requireRoutingLease(held);
    await database.$transaction(async (tx) => {
      await lease.assertValid(tx);
      const approval = await publicApplicationPolicy.read(project, tx);
      if (approval !== null && approval.revokedAt !== null) return;
      const revokedAt = new Date();
      // A legacy revocation must leave a durable record to suppress the environment fallback.
      await tx.projectPublicApproval.upsert({
        where: { projectId },
        create: { projectId, repositoryUrl: project.repositoryUrl, branch: project.branch, approvedById: userId, revokedAt },
        update: { revokedAt },
      });
      await tx.projectPublicRevision.updateMany({ where: { projectId, revokedAt: null }, data: { revokedAt } });
    });
    await retryWithdrawal(projectId, lease);
    return database.$transaction(async (tx) => {
      await lease.assertValid(tx);
      return summarizeApproval(await publicApplicationPolicy.read(project, tx));
    });
  });
};

const retryWithdrawal = async (projectId: string, lease: ProjectOperationLease): Promise<void> => {
  try {
    const pending = await database.projectPublicApproval.findFirst({
      where: { projectId, revokedAt: { not: null }, withdrawnAt: null }, select: { revokedAt: true },
    });
    if (pending?.revokedAt == null) return;
    const routing = managesProjectRoute(env.hosting, projectId) ? deploymentRoutingService : undefined;
    if (managesProjectRoute(env.hosting, projectId) && routing === undefined) throw new RoutingPendingError();
    const [route, build] = await Promise.allSettled([
      routing?.withdrawApproval(projectId, lease),
      buildNetworkService.closeProject(projectId),
    ]);
    if (route.status === 'rejected') throw new RoutingPendingError();
    const deployments = await database.deployment.findMany({
      // A failed create/start or its failed cleanup can leave a labeled container
      // even when Docker never returned an ID to the deployment service.
      where: { projectId },
      select: { id: true, containerId: true },
    });
    for (const deployment of deployments) {
      await containerService.removeDeploymentContainers(deployment.id, deployment.containerId, async () => {
        await routing?.assertWithdrawn(projectId, lease);
        await lease.assertValid();
      });
    }
    if (build.status === 'rejected') throw new AppError(503, 'Docker build withdrawal is pending');
    await database.$transaction(async (tx) => {
      await lease.assertValid(tx);
      await tx.project.update({
        where: { id: projectId },
        data: { activeDeploymentId: null, routingOperation: null, routingDeploymentId: null },
      });
      await tx.deployment.updateMany({
        where: { projectId, status: { notIn: ['STOPPED', 'FAILED'] } },
        data: { status: 'STOPPED', finishedAt: new Date() },
      });
      await tx.deployment.updateMany({ where: { projectId }, data: { containerId: null, hostPort: null } });
      await tx.projectPublicApproval.update({
        where: { projectId, revokedAt: pending.revokedAt, withdrawnAt: null },
        data: { withdrawnAt: new Date() },
      });
    });
  } catch {
    // Keep the authorization revoked and let a retry finish fail-closed cleanup.
    console.warn('Public withdrawal is pending for project', projectId);
  }
};

export const reconcilePendingPublicWithdrawals = async (): Promise<void> => {
  if (env.hosting.publicHosting === undefined) return;
  const pending = await database.projectPublicApproval.findMany({
    where: { revokedAt: { not: null }, withdrawnAt: null }, select: { projectId: true },
  });
  for (const { projectId } of pending) {
    try {
      await projectOperationLockService.runExclusive(projectId, (lease) => retryWithdrawal(projectId, requireRoutingLease(lease)));
    } catch (error) {
      if (!(error instanceof AppError && error.statusCode === 409)) throw error;
    }
  }
};
