import Dockerode from 'dockerode';

import { database } from '../config/database.js';
import { AppError } from '../utils/app-error.js';
import { readLinuxBootId } from '../utils/linux-boot.js';
import { dockerDeadline } from './docker-deadline.js';
import { projectOperationLockService, type ProjectOperationLease } from './project-operation-lock.service.js';

const ownerLabel = 'deployflow.build-deployment-id';
const validDockerId = (id: string): boolean => /^[a-f0-9]{64}$/.test(id);
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404;
const networkName = (deploymentId: string) => 'deployflow-build-' + deploymentId;
type Options = { abortSignal: AbortSignal };
type BuildDocker = {
  createNetwork: (options: Options & { Name: string; Driver: 'bridge'; Labels: Record<string, string> }) => Promise<{ id: string }>;
  getNetwork: (id: string) => {
    inspect: (options: Options) => Promise<{ Id: string; Name: string; Labels?: Record<string, string>; Containers?: Record<string, unknown> }>;
    remove: (options: Options) => Promise<unknown>;
  };
  getContainer: (id: string) => {
    inspect: (options: Options) => Promise<{ Id: string; HostConfig: { NetworkMode: string; CgroupParent?: string }; NetworkSettings: {
      Networks?: Record<string, { NetworkID: string }>;
    } }>;
    remove: (options: Options & { force: true }) => Promise<unknown>;
  };
};
type BuildDatabase = Pick<typeof database, 'deployment' | '$transaction'>;

export class BuildNetworkService {
  constructor(
    private readonly docker: BuildDocker = new Dockerode({ timeout: 5_000 }) as unknown as BuildDocker,
    private readonly db: BuildDatabase = database,
    private readonly hostBootId = readLinuxBootId,
  ) {}

  async run<T>(projectId: string, deploymentId: string, lease: ProjectOperationLease,
    build: (networkId: string, confirmTerminal: () => Promise<void>, markSubmitted: () => void) => Promise<T>): Promise<T> {
    const boot = await this.hostBootId();
    await this.db.$transaction(async (tx) => {
      await lease.assertValid(tx);
      const result = await tx.deployment.updateMany({
        where: { id: deploymentId, projectId, status: 'BUILDING', buildNetworkId: null },
        data: { guardedBuild: true },
      });
      if (result.count !== 1) throw new AppError(409, 'Build admission is no longer current');
    });
    const { id } = await dockerDeadline((options) => this.docker.createNetwork({
      ...options, Name: networkName(deploymentId), Driver: 'bridge', Labels: { [ownerLabel]: deploymentId },
    }));
    if (!validDockerId(id)) throw new AppError(503, 'Docker could not identify the build network');
    const confirmTerminal = async () => {
      await this.db.deployment.updateMany({
        where: { id: deploymentId, buildNetworkId: id },
        data: { buildEndedAt: new Date() },
      });
    };
    const execution = { submitted: false };
    try {
      await this.db.$transaction(async (tx) => {
        await lease.assertValid(tx);
        const result = await tx.deployment.updateMany({
          where: { id: deploymentId, projectId, status: 'BUILDING', buildNetworkId: null },
          data: { buildNetworkId: id, buildHostBootId: boot, buildEndedAt: null },
        });
        if (result.count !== 1) throw new AppError(409, 'Build admission is no longer current');
      });
      await lease.assertValid();
      return await build(id, confirmTerminal, () => { execution.submitted = true; });
    } finally {
      // This network is an execution permit. Even a late Docker submission
      // must join this exact ID for a classic-builder RUN step.
      if (!execution.submitted) await confirmTerminal();
      await this.close(deploymentId, id);
    }
  }

  async close(deploymentId: string, networkId: string): Promise<void> {
    if (!validDockerId(networkId)) throw new AppError(503, 'Invalid recorded Docker build network');
    const network = this.docker.getNetwork(networkId);
    const read = async () => {
      try { return await dockerDeadline((options) => network.inspect(options)); }
      catch (error) { if (isMissing(error)) return null; throw error; }
    };
    const details = await read();
    if (details !== null) {
      if (details.Id !== networkId || details.Name !== networkName(deploymentId) || details.Labels?.[ownerLabel] !== deploymentId) {
        throw new AppError(503, 'Docker could not verify build network ownership');
      }
      for (const id of Object.keys(details.Containers ?? {})) {
        if (!validDockerId(id)) throw new AppError(503, 'Docker returned an invalid build container ID');
        const container = this.docker.getContainer(id);
        try {
          const inspected = await dockerDeadline((options) => container.inspect(options));
          if (inspected.Id !== id ||
            inspected.HostConfig.CgroupParent !== 'deployflow-build.slice' ||
            (inspected.HostConfig.NetworkMode !== networkId && inspected.HostConfig.NetworkMode !== details.Name) ||
            !Object.values(inspected.NetworkSettings.Networks ?? {}).some(({ NetworkID }) => NetworkID === networkId)) {
            throw new AppError(503, 'Docker could not verify build container ownership');
          }
          await dockerDeadline((options) => container.remove({ ...options, force: true }));
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      // Docker rejects deletion while an endpoint is attached. A concurrent
      // join either prevents deletion or fails against the nonexistent ID.
      try { await dockerDeadline((options) => network.remove(options)); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (await read() !== null) throw new AppError(503, 'Docker has not confirmed the build fence');
    }
    const boot = await this.hostBootId();
    const result = await this.db.deployment.updateMany({
      where: { id: deploymentId, buildNetworkId: networkId,
        OR: [{ buildEndedAt: { not: null } }, { buildHostBootId: { not: boot } }] },
      data: { buildNetworkId: null, buildHostBootId: null },
    });
    if (result.count === 0 && await this.db.deployment.findFirst({
      where: { id: deploymentId, buildNetworkId: networkId }, select: { id: true },
    }) !== null) {
      // Network teardown prevents future attachment. A clean Docker end
      // response or verified host reboot is also required before clearing
      // ambiguity about work that could have run without an endpoint.
      throw new AppError(503, 'Docker build execution is still unconfirmed');
    }
  }

  async closeProject(projectId: string): Promise<void> {
    const permits = await this.db.deployment.findMany({
      where: { projectId, buildNetworkId: { not: null } }, select: { id: true, buildNetworkId: true },
    });
    for (const permit of permits) {
      if (permit.buildNetworkId !== null) await this.close(permit.id, permit.buildNetworkId);
    }
    await this.db.deployment.updateMany({
      where: { projectId, status: 'BUILDING', guardedBuild: true, buildNetworkId: null },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'Interrupted Docker build was reconciled' },
    });
  }

  async reconcile(): Promise<void> {
    const projects = await this.db.deployment.findMany({
      where: { OR: [{ buildNetworkId: { not: null } }, { status: 'BUILDING', guardedBuild: true }] },
      distinct: ['projectId'], select: { projectId: true },
    });
    for (const { projectId } of projects) {
      try { await projectOperationLockService.runExclusive(projectId, () => this.closeProject(projectId)); }
      catch { console.warn('Build network cleanup needs reconciliation for project', projectId); }
    }
  }
}

export const buildNetworkService = new BuildNetworkService();
