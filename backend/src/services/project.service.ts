import { randomUUID } from 'node:crypto';

import { database } from '../config/database.js';
import { buildNetworkService } from './build-network.service.js';
import { env, managesProjectRoute } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/app-error.js';
import { projectHostnameLabel } from '../utils/project-hostname.js';
import { containerService } from './container.service.js';
import { deploymentRoutingService, requireRoutingLease } from './deployment-routing.service.js';
import { dockerBuildService } from './docker-build.service.js';
import { projectHostingService } from './project-hosting.service.js';
import { projectOperationLockService } from './project-operation-lock.service.js';
import { assertPublicOperator } from './public-application-policy.js';
import { assertNoPendingPublicWithdrawal } from './public-hosting-safety.service.js';

type CreateProjectData = {
  name: string;
  repositoryUrl: string;
  branch: string;
  containerPort: number;
  healthCheckPath: string;
};

const projectSelect = {
  id: true,
  hostnameLabel: true,
  userId: true,
  name: true,
  repositoryUrl: true,
  branch: true,
  containerPort: true,
  healthCheckPath: true,
  createdAt: true,
  updatedAt: true,
} as const;

const deploymentSummary = { id: true, status: true, commitHash: true, createdAt: true } as const;
const projectHostingSelect = {
  ...projectSelect,
  activeDeployment: { select: { ...deploymentSummary, hostPort: true, publicAddressIndex: true } },
  routingOperation: true,
  deployments: {
    select: deploymentSummary,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
  },
} as const satisfies Prisma.ProjectSelect;

const withHosting = async (project: Prisma.ProjectGetPayload<{ select: typeof projectHostingSelect }>) => {
  const { activeDeployment, deployments, routingOperation, ...fields } = project;
  const hosting = await projectHostingService?.summarize({
    ...fields, activeDeployment, deployments, routingOperation,
  }) ?? { localApplicationUrl: null, hostingStatus: 'DISABLED' as const };
  return {
    ...fields,
    ...hosting,
    ...(env.hosting.publicHosting === undefined ? {} : { publicHostingEnabled: true as const }),
    activeDeployment: activeDeployment === null ? null : {
      id: activeDeployment.id,
      status: activeDeployment.status,
      commitHash: activeDeployment.commitHash,
      createdAt: activeDeployment.createdAt,
    },
    latestDeployment: deployments[0] ?? null,
  };
};

export const createProject = async (
  userId: string,
  data: CreateProjectData,
) => {
  assertPublicOperator(userId);
  const id = randomUUID();
  const project = await database.project.create({
    data: { ...data, id, hostnameLabel: projectHostnameLabel(id), userId },
    select: projectSelect,
  });
  return withHosting({ ...project, activeDeployment: null, deployments: [], routingOperation: null });
};

export const listProjects = async (userId: string) => {
  const projects = await database.project.findMany({
    where: { userId },
    select: projectHostingSelect,
    orderBy: { createdAt: 'desc' },
  });
  const result: Awaited<ReturnType<typeof withHosting>>[] = [];
  const batchSize = 8;
  for (let index = 0; index < projects.length; index += batchSize) {
    result.push(...await Promise.all(projects.slice(index, index + batchSize).map(withHosting)));
  }
  return result;
};

export const getProject = async (userId: string, projectId: string) => {
  const project = await database.project.findFirst({
    where: { id: projectId, userId },
    select: projectHostingSelect,
  });

  if (project === null) {
    throw new AppError(404, 'Project not found');
  }

  return withHosting(project);
};

export const updateProjectHealthCheck = async (
  userId: string,
  projectId: string,
  healthCheckPath: string,
) => {
  const result = await database.project.updateMany({
    where: { id: projectId, userId },
    data: { healthCheckPath },
  });

  if (result.count === 0) {
    throw new AppError(404, 'Project not found');
  }

  return getProject(userId, projectId);
};

const deleteProjectDockerResources = async (
  projectId: string,
  activeContainerId: string | null,
  assertSafe: () => Promise<void>,
): Promise<void> => {
  const deployments = await database.deployment.findMany({
    where: { projectId }, select: { id: true, containerId: true, imageTag: true },
  });

  try {
    if (env.hosting.publicHosting === undefined) {
      await deletePrivateProjectContainers(deployments, activeContainerId, assertSafe);
    } else {
      const active = deployments.find(({ containerId }) => containerId !== null && containerId === activeContainerId);
      if (activeContainerId !== null && active === undefined) throw new Error('Missing active deployment for cleanup');
      for (const deployment of deployments) {
        if (deployment !== active) {
          await containerService.removeDeploymentContainers(deployment.id, deployment.containerId, assertSafe);
        }
      }
      if (active !== undefined) {
        await containerService.removeDeploymentContainers(active.id, active.containerId, assertSafe);
      }
    }
    const imageTags = new Set(deployments.flatMap(({ imageTag }) => imageTag === null ? [] : [imageTag]));
    for (const imageTag of imageTags) {
      if (await dockerBuildService.imageExists(imageTag)) {
        await assertSafe();
        await dockerBuildService.removeImage(imageTag);
      }
    }
  } catch {
    throw new AppError(502, 'Project Docker resources could not be cleaned up; the project was not deleted');
  }
};

const deletePrivateProjectContainers = async (
  deployments: readonly { containerId: string | null }[],
  activeContainerId: string | null,
  assertSafe: () => Promise<void>,
): Promise<void> => {
  const containerIds = new Set(
    deployments.flatMap(({ containerId }) => containerId === null ? [] : [containerId]),
  );
  if (activeContainerId !== null) {
    containerIds.delete(activeContainerId);
    containerIds.add(activeContainerId);
  }

  for (const containerId of containerIds) {
    let status;
    try {
      status = await containerService.inspectStatus(containerId);
    } catch (error: unknown) {
      if (error instanceof AppError && error.statusCode === 404) continue;
      throw error;
    }
    if (status.running) {
      await assertSafe();
      await containerService.stopContainer(containerId);
    }
    await assertSafe();
    await containerService.removeContainer(containerId);
  }
};

export const deleteProject = async (
  userId: string,
  projectId: string,
): Promise<void> => {
  const owned = await database.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (owned === null) throw new AppError(404, 'Project not found');

  await projectOperationLockService.runExclusive(projectId, async (lease) => {
    const publicLease = env.hosting.publicHosting === undefined ? undefined : requireRoutingLease(lease);
    if (publicLease !== undefined) await assertNoPendingPublicWithdrawal(projectId);
    const routing = managesProjectRoute(env.hosting, projectId) ? deploymentRoutingService : undefined;
    const hosted = routing === undefined ? undefined : requireRoutingLease(lease);
    const deletion = routing === undefined || hosted === undefined
      ? null
      : await routing.beginDelete(projectId, hosted);
    const assertSafe = async () => {
      if (routing !== undefined && hosted !== undefined) await routing.assertWithdrawn(projectId, hosted);
      else await publicLease?.assertValid();
    };
    try {
      if (publicLease !== undefined) await buildNetworkService.closeProject(projectId);
      await deleteProjectDockerResources(projectId, deletion?.containerId ?? null, assertSafe);
      await assertSafe();
      const held = hosted ?? publicLease;
      const result = await database.project.deleteMany({
        where: {
          id: projectId, userId,
          ...(held === undefined ? {} : {
            operationLockToken: held.token, operationLockExpiresAt: { gt: new Date() },
          }),
          ...(deletion === null ? {} : {
            activeDeploymentId: deletion.deploymentId,
            routingDeploymentId: deletion.deploymentId,
            routingOperation: deletion.deploymentId === null ? null : 'DELETE',
          }),
        },
      });
      if (result.count === 0) throw new AppError(404, 'Project not found');
    } catch (error) {
      if (routing !== undefined && hosted !== undefined && !await routing.deleteFailed(projectId, hosted)) return;
      throw error;
    }
  });
};
