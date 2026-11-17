import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import {
  DeploymentStatus,
  type DeploymentStatus as DeploymentStatusValue,
} from '../generated/prisma/enums.js';
import { AppError } from '../utils/app-error.js';
import { MAX_WORKLOAD_ADDRESS, workloadAddress } from '../utils/workload-address.js';
import { buildNetworkService } from './build-network.service.js';
import { assertPublicOperator, publicApplicationPolicy, type PublicApplicationPolicy } from './public-application-policy.js';
import { assertNoPendingPublicWithdrawal, assertPublicWorkloadReady } from './public-hosting-safety.service.js';
import { applicationHealthCheckService } from './application-health-check.service.js';
import {
  applicationDetector,
  type DetectedApplicationType,
} from './application-detector.service.js';
import {
  dockerBuildService,
  type DockerBuildOutput,
  type DockerBuildResult,
  type DockerBuildInput,
} from './docker-build.service.js';
import {
  deploymentRoutingService,
  requireRoutingLease,
  RoutingPendingError,
  type DeploymentRoutingService,
} from './deployment-routing.service.js';
import {
  containerService,
  ContainerLifecyclePendingError,
  type ContainerCpuStatistics,
  type ContainerMemoryStatistics,
  type ContainerUptime,
  type StartContainerResult,
  type StartContainerInput,
} from './container.service.js';
import {
  gitRepositoryService,
  type PreparedGitRepository,
} from './git-repository.service.js';
import {
  projectOperationLockService,
  type ProjectOperationLock,
  type ProjectOperationLease,
} from './project-operation-lock.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeploymentProject = {
  id: string;
  userId: string;
  repositoryUrl: string;
  branch: string;
  containerPort: number;
  healthCheckPath: string;
};

export type DeploymentRecord = {
  id: string;
  projectId: string;
  rollbackSourceDeploymentId: string | null;
  applicationType: DetectedApplicationType | null;
  commitHash: string | null;
  status: DeploymentStatusValue;
  containerId: string | null;
  imageId: string | null;
  imageTag: string | null;
  hostPort: number | null;
  publicAddressIndex?: number | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DeploymentMetrics = {
  status: DeploymentStatusValue;
  cpu: ContainerCpuStatistics;
  memory: ContainerMemoryStatistics;
  uptime: ContainerUptime;
};

export type OwnedDeployment = DeploymentRecord & {
  project: DeploymentProject;
};

export type DeploymentEvent =
  | {
      type: 'status';
      deploymentId: string;
      status: DeploymentStatusValue;
    }
  | {
      type: 'log';
      deploymentId: string;
      source: 'deployment' | 'build';
      message: string;
    }
  | {
      type: 'completed';
      deployment: DeploymentRecord;
    }
  | {
      type: 'failed';
      deployment: DeploymentRecord;
      errorMessage: string;
    };

export type DeploymentEventCallback = (event: DeploymentEvent) => void;

export type DeploymentUpdateData = {
  status?: DeploymentStatusValue;
  applicationType?: DetectedApplicationType;
  commitHash?: string;
  containerId?: string;
  imageId?: string;
  imageTag?: string;
  hostPort?: number;
  errorMessage?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
};

export type DeploymentDatabase = {
  $transaction?: typeof database.$transaction;
  project: {
    findUnique: (options: {
      where: { id: string };
      select: {
        id: true;
        userId: true;
        repositoryUrl: true;
        branch: true;
        containerPort: true;
        healthCheckPath: true;
      };
    }) => Promise<DeploymentProject | null>;
    findFirst: (options: {
      where: { id: string; userId: string };
      select: {
        id: true;
        userId: true;
        repositoryUrl: true;
        branch: true;
        containerPort: true;
        healthCheckPath: true;
      };
    }) => Promise<DeploymentProject | null>;
  };
  deployment: {
    create: (options: {
      data: {
        projectId: string;
        status: DeploymentStatusValue;
        rollbackSourceDeploymentId?: string;
      };
    }) => Promise<DeploymentRecord>;
    update: (options: {
      where: { id: string };
      data: DeploymentUpdateData;
    }) => Promise<DeploymentRecord>;
    findMany: (options: {
      where: { projectId: string };
      orderBy: { createdAt: 'desc' };
    }) => Promise<DeploymentRecord[]>;
    findFirst: (options: {
      where: { id: string; project: { userId: string } };
      include: {
        project: {
          select: {
            id: true;
            userId: true;
            repositoryUrl: true;
            branch: true;
            containerPort: true;
            healthCheckPath: true;
          };
        };
      };
    }) => Promise<OwnedDeployment | null>;
  };
};

export type DeploymentGitService = Pick<
  typeof gitRepositoryService,
  'prepareRepository' | 'prepareRepositoryAtCommit' | 'cleanup'
>;

export type DeploymentApplicationDetector = Pick<
  typeof applicationDetector,
  'prepareBuild'
>;

export type DeploymentHealthCheckService = Pick<
  typeof applicationHealthCheckService,
  'waitUntilHealthy'
>;

export type DeploymentBuildService = Pick<
  typeof dockerBuildService,
  'buildImage' | 'imageExists' | 'removeImage'
>;

export type DeploymentContainerService = Pick<
  typeof containerService,
  | 'startContainer'
  | 'stopContainer'
  | 'restartContainer'
  | 'removeContainer'
  | 'getLogs'
  | 'getCpuStatistics'
  | 'getMemoryStatistics'
  | 'getUptime'
>;

export type DeploymentServiceDependencies = {
  database?: DeploymentDatabase;
  gitService?: DeploymentGitService;
  applicationDetector?: DeploymentApplicationDetector;
  healthCheckService?: DeploymentHealthCheckService;
  buildService?: DeploymentBuildService;
  containerService?: DeploymentContainerService;
  operationLock?: ProjectOperationLock;
  routing?: Pick<DeploymentRoutingService, 'assertIdle' | 'assertPublicPortOwned' | 'promote' | 'stop' | 'beginRestart' | 'restartFailed'>;
  hosting?: HostingConfig;
  policy?: Pick<PublicApplicationPolicy, 'selectCommit' | 'assertApproved'>;
  now?: () => Date;
};

const parseIdentifier = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }

  return value.toLowerCase();
};

const formatBuildOutput = (output: DockerBuildOutput): string | null => {
  if (output.stream !== undefined && output.stream.length > 0) {
    return output.stream;
  }

  const status = output.status ?? '';
  const progress = output.progress ?? '';
  const message = `${status} ${progress}`.trim();

  if (message.length > 0) return message;
  if (output.error !== undefined && output.error.length > 0) return output.error;
  return null;
};

const getSafeFailureMessage = (
  error: unknown,
  stage: DeploymentStatusValue,
): string => {
  if (error instanceof AppError) return error.message;

  switch (stage) {
    case DeploymentStatus.CLONING:
      return 'Repository preparation failed';
    case DeploymentStatus.BUILDING:
      return 'Docker image build failed';
    case DeploymentStatus.STARTING:
      return 'Container startup failed';
    case DeploymentStatus.HEALTHCHECKING:
      return 'Application health check failed';
    case DeploymentStatus.RUNNING:
      return 'Deployment cleanup failed';
    default:
      return 'Deployment initialization failed';
  }
};

export class DeploymentService {
  readonly #database: DeploymentDatabase;
  readonly #gitService: DeploymentGitService;
  readonly #applicationDetector: DeploymentApplicationDetector;
  readonly #healthCheckService: DeploymentHealthCheckService;
  readonly #buildService: DeploymentBuildService;
  readonly #containerService: DeploymentContainerService;
  readonly #operationLock: ProjectOperationLock;
  readonly #routing: DeploymentServiceDependencies['routing'];
  readonly #hosting: HostingConfig;
  readonly #policy: Pick<PublicApplicationPolicy, 'selectCommit' | 'assertApproved'>;
  readonly #now: () => Date;

  public constructor(dependencies: DeploymentServiceDependencies = {}) {
    this.#database = dependencies.database ?? database;
    this.#gitService = dependencies.gitService ?? gitRepositoryService;
    this.#applicationDetector =
      dependencies.applicationDetector ?? applicationDetector;
    this.#healthCheckService =
      dependencies.healthCheckService ?? applicationHealthCheckService;
    this.#buildService = dependencies.buildService ?? dockerBuildService;
    this.#containerService =
      dependencies.containerService ?? containerService;
    this.#operationLock =
      dependencies.operationLock ?? projectOperationLockService;
    this.#routing = dependencies.routing ?? deploymentRoutingService;
    this.#hosting = dependencies.hosting ?? env.hosting;
    this.#policy = dependencies.policy ?? publicApplicationPolicy;
    this.#now = dependencies.now ?? (() => new Date());
  }

  #workloadLease(lease: ProjectOperationLease | undefined) {
    return this.#hosting.publicHosting !== undefined || this.#routing !== undefined
      ? requireRoutingLease(lease) : undefined;
  }

  async #assertWorkloadAllowed(project: DeploymentProject, commitHash: string | null) {
    await this.#policy.assertApproved(project, commitHash);
    if (this.#hosting.publicHosting !== undefined) await assertPublicWorkloadReady(project.id);
  }

  async #startWorkload(input: StartContainerInput, project: DeploymentProject, commitHash: string, lease?: ProjectOperationLease) {
    if (this.#hosting.publicHosting === undefined) return this.#containerService.startContainer(input);
    const held = requireRoutingLease(lease);
    if (this.#database.$transaction === undefined) throw new AppError(503, 'Unable to reserve a public workload address');
    const transaction = this.#database.$transaction.bind(this.#database);
    const addressIndex = await transaction(async (tx) => {
      await held.assertValid(tx);
      const binding = await tx.publicRoutingBinding.update({
        where: { id: 1, nextWorkloadAddress: { lt: MAX_WORKLOAD_ADDRESS } },
        data: { nextWorkloadAddress: { increment: 1 } }, select: { nextWorkloadAddress: true },
      });
      const result = await tx.deployment.updateMany({
        where: { id: input.deploymentId, projectId: project.id, status: DeploymentStatus.STARTING, publicAddressIndex: null },
        data: { publicAddressIndex: binding.nextWorkloadAddress },
      });
      if (result.count !== 1) throw new AppError(409, 'Deployment address reservation is no longer current');
      return binding.nextWorkloadAddress;
    });
    return this.#containerService.startContainer({ ...input, hostAddress: workloadAddress(addressIndex) }, async (containerId) => {
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new AppError(502, 'Docker returned an invalid container ID');
      await transaction(async (tx) => {
        await held.assertValid(tx);
        const result = await tx.deployment.updateMany({
          where: { id: input.deploymentId, projectId: project.id, status: DeploymentStatus.STARTING },
          data: { containerId },
        });
        if (result.count !== 1) throw new AppError(409, 'Deployment startup is no longer current');
      });
      await this.#routing?.assertPublicPortOwned(project.id);
      await this.#assertWorkloadAllowed(project, commitHash);
      await held.assertValid();
    });
  }

  #buildWorkload(input: DockerBuildInput, lease: ProjectOperationLease | undefined, onOutput: (output: DockerBuildOutput) => void) {
    if (this.#hosting.publicHosting === undefined) return this.#buildService.buildImage(input, onOutput);
    return buildNetworkService.run(input.projectId, input.deploymentId, requireRoutingLease(lease),
      (buildNetworkId, confirmTerminal, markSubmitted) =>
        this.#buildService.buildImage({ ...input, buildNetworkId, confirmTerminal, markSubmitted }, onOutput));
  }

  public async deployProjectForUser(
    userId: string,
    rawProjectId: unknown,
    onEvent?: DeploymentEventCallback,
    commitHash?: string,
  ): Promise<DeploymentRecord> {
    const projectId = parseIdentifier(rawProjectId, 'Project ID');
    await this.#getOwnedProject(userId, projectId);
    return this.#operationLock.runExclusive(projectId, (lease) =>
      this.#deployProjectUnlocked(projectId, onEvent, lease, commitHash),
    );
  }

  public async listProjectDeployments(
    userId: string,
    rawProjectId: unknown,
  ): Promise<DeploymentRecord[]> {
    const projectId = parseIdentifier(rawProjectId, 'Project ID');
    await this.#getOwnedProject(userId, projectId);

    return this.#database.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async getDeploymentForUser(
    userId: string,
    rawDeploymentId: unknown,
  ): Promise<DeploymentRecord> {
    const deployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    return this.#withoutProject(deployment);
  }

  public async stopDeployment(
    userId: string,
    rawDeploymentId: unknown,
    onEvent?: DeploymentEventCallback,
  ): Promise<DeploymentRecord> {
    const deployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    return this.#operationLock.runExclusive(deployment.projectId, (lease) =>
      this.#stopOwnedDeployment(deployment, onEvent, lease),
    );
  }

  public async restartDeployment(
    userId: string,
    rawDeploymentId: unknown,
    onEvent?: DeploymentEventCallback,
  ): Promise<DeploymentRecord> {
    const deployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    return this.#operationLock.runExclusive(deployment.projectId, (lease) =>
      this.#restartOwnedDeployment(deployment, onEvent, lease),
    );
  }

  async #restartOwnedDeployment(
    deployment: OwnedDeployment,
    onEvent: DeploymentEventCallback | undefined,
    lease: ProjectOperationLease | undefined,
  ): Promise<DeploymentRecord> {
    const routing = this.#routing;
    const hostingLease = this.#workloadLease(lease);
    await this.#assertWorkloadAllowed(deployment.project, deployment.commitHash);
    if (this.#hosting.publicHosting !== undefined && deployment.publicAddressIndex == null) {
      throw new AppError(409, 'Deploy an approved revision to replace this legacy container');
    }
    const containerId = this.#requireContainerId(deployment);
    let containerRestarted = false;
    const shouldRoute = hostingLease !== undefined &&
      await routing?.beginRestart(deployment.projectId, deployment.id, hostingLease);

    try {
      await hostingLease?.assertValid();
      await this.#updateDeployment(deployment.id, {
        status: DeploymentStatus.STARTING,
      });
      this.#emit(onEvent, {
        type: 'status',
        deploymentId: deployment.id,
        status: DeploymentStatus.STARTING,
      });
      if (this.#hosting.publicHosting !== undefined) await routing?.assertPublicPortOwned(deployment.projectId);
      await this.#assertWorkloadAllowed(deployment.project, deployment.commitHash);
      await hostingLease?.assertValid();
      const restartedContainer = await this.#containerService.restartContainer(
        containerId,
        deployment.project.containerPort,
        ...(deployment.publicAddressIndex == null ? [] as const : [workloadAddress(deployment.publicAddressIndex)] as const),
      );
      containerRestarted = true;
      await hostingLease?.assertValid();
      await this.#updateDeployment(deployment.id, {
        hostPort: restartedContainer.hostPort,
      });
      await this.#changeStatus(
        deployment.id,
        DeploymentStatus.HEALTHCHECKING,
        onEvent,
      );
      this.#emitLog(
        onEvent,
        deployment.id,
        'deployment',
        `Checking application health at ${deployment.project.healthCheckPath}`,
      );
      await this.#healthCheckService.waitUntilHealthy({
        hostPort: restartedContainer.hostPort,
        path: deployment.project.healthCheckPath,
        ...(restartedContainer.hostAddress === undefined ? {} : { hostAddress: restartedContainer.hostAddress }),
      });
      await this.#policy.assertApproved(deployment.project, deployment.commitHash);
      await hostingLease?.assertValid();
      const runningDeployment = shouldRoute && routing !== undefined
        ? await routing.promote(
          { ...deployment, hostPort: restartedContainer.hostPort },
          this.#now(),
          requireRoutingLease(hostingLease),
        )
        : await this.#updateDeployment(deployment.id, {
        status: DeploymentStatus.RUNNING,
        hostPort: restartedContainer.hostPort,
        startedAt: this.#now(),
        finishedAt: null,
        errorMessage: null,
      });
      this.#emit(onEvent, {
        type: 'status',
        deploymentId: runningDeployment.id,
        status: DeploymentStatus.RUNNING,
      });
      return runningDeployment;
    } catch (error: unknown) {
      if (error instanceof RoutingPendingError) throw error;
      if (error instanceof ContainerLifecyclePendingError) {
        if (shouldRoute) throw new RoutingPendingError();
        throw error;
      }
      const handled = hostingLease !== undefined &&
        await routing?.restartFailed(deployment.projectId, deployment.id, hostingLease);
      const errorMessage =
        error instanceof AppError ? error.message : 'Unable to restart deployment';

      if (containerRestarted && !handled) {
        try {
          await hostingLease?.assertValid();
          await this.#containerService.stopContainer(containerId);
        } catch {
          // Preserve the health-check or restart failure.
        }
      }

      try {
        const failedDeployment = await this.#updateDeployment(deployment.id, {
          status: DeploymentStatus.FAILED,
          errorMessage,
          finishedAt: this.#now(),
        });
        this.#emit(onEvent, {
          type: 'status',
          deploymentId: failedDeployment.id,
          status: DeploymentStatus.FAILED,
        });
        this.#emit(onEvent, {
          type: 'failed',
          deployment: failedDeployment,
          errorMessage,
        });
      } catch {
        // Preserve the restart failure when its status cannot also be persisted.
      }

      throw error instanceof AppError ? error : new AppError(500, errorMessage);
    }
  }

  public async redeployDeployment(
    userId: string,
    rawDeploymentId: unknown,
    onEvent?: DeploymentEventCallback,
    commitHash?: string,
  ): Promise<DeploymentRecord> {
    const previousDeployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    return this.#operationLock.runExclusive(
      previousDeployment.projectId,
      (lease) =>
        this.#deployProjectReplacingRunningUnlocked(
          previousDeployment.projectId,
          onEvent,
          lease,
          commitHash,
        ),
    );
  }

  public async rollbackDeployment(
    userId: string,
    rawDeploymentId: unknown,
    onEvent?: DeploymentEventCallback,
  ): Promise<DeploymentRecord> {
    const sourceDeployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );

    if (
      (sourceDeployment.status !== DeploymentStatus.RUNNING &&
        sourceDeployment.status !== DeploymentStatus.STOPPED) ||
      sourceDeployment.commitHash === null
    ) {
      throw new AppError(
        409,
        'Only a previously successful deployment can be rolled back',
      );
    }

    return this.#operationLock.runExclusive(sourceDeployment.projectId, (lease) =>
      this.#executeRollback(sourceDeployment, onEvent, lease),
    );
  }

  public async deployProjectReplacingRunning(
    rawProjectId: unknown,
    onEvent?: DeploymentEventCallback,
  ): Promise<DeploymentRecord> {
    if (this.#hosting.publicHosting !== undefined) throw new AppError(403, 'Public deployment requires the configured operator');
    const projectId = parseIdentifier(rawProjectId, 'Project ID');
    return this.#operationLock.runExclusive(projectId, (lease) =>
      this.#deployProjectReplacingRunningUnlocked(projectId, onEvent, lease),
    );
  }

  async #deployProjectReplacingRunningUnlocked(
    projectId: string,
    onEvent: DeploymentEventCallback | undefined,
    lease: ProjectOperationLease | undefined,
    commitHash?: string,
  ): Promise<DeploymentRecord> {
    const newDeployment = await this.#deployProjectUnlocked(projectId, onEvent, lease, commitHash);

    if (this.#routing === undefined) {
      await this.#workloadLease(lease)?.assertValid();
      await this.#stopPreviousRunningDeployments(projectId, newDeployment.id, onEvent);
    }

    return newDeployment;
  }

  async #stopOwnedDeployment(
    deployment: OwnedDeployment,
    onEvent: DeploymentEventCallback | undefined,
    lease: ProjectOperationLease | undefined,
  ): Promise<DeploymentRecord> {
    if (this.#hosting.publicHosting !== undefined) await assertNoPendingPublicWithdrawal(deployment.projectId);
    const containerId = this.#requireContainerId(deployment);
    const routing = this.#routing;
    const hostingLease = this.#workloadLease(lease);

    try {
      if (routing !== undefined) {
        const hosted = await routing.stop(deployment.projectId, deployment.id, requireRoutingLease(lease));
        this.#emit(onEvent, { type: 'status', deploymentId: hosted.id, status: DeploymentStatus.STOPPED });
        return hosted;
      }
      await hostingLease?.assertValid();
      await this.#containerService.stopContainer(containerId);
      await hostingLease?.assertValid();
      const stoppedDeployment = await this.#updateDeployment(deployment.id, {
        status: DeploymentStatus.STOPPED,
        finishedAt: this.#now(),
      });
      this.#emit(onEvent, {
        type: 'status',
        deploymentId: stoppedDeployment.id,
        status: DeploymentStatus.STOPPED,
      });
      return stoppedDeployment;
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'Unable to stop deployment');
    }
  }

  public async getDeploymentLogs(
    userId: string,
    rawDeploymentId: unknown,
  ): Promise<string> {
    const deployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    return this.#containerService.getLogs(this.#requireContainerId(deployment));
  }

  public async getDeploymentMetrics(
    userId: string,
    rawDeploymentId: unknown,
  ): Promise<DeploymentMetrics> {
    const deployment = await this.#getOwnedDeployment(
      userId,
      parseIdentifier(rawDeploymentId, 'Deployment ID'),
    );
    const containerId = this.#requireContainerId(deployment);
    const [cpu, memory, uptime] = await Promise.all([
      this.#containerService.getCpuStatistics(containerId),
      this.#containerService.getMemoryStatistics(containerId),
      this.#containerService.getUptime(containerId),
    ]);

    return { status: deployment.status, cpu, memory, uptime };
  }

  public async deployProject(
    rawProjectId: unknown,
    onEvent?: DeploymentEventCallback,
  ): Promise<DeploymentRecord> {
    if (this.#hosting.publicHosting !== undefined) throw new AppError(403, 'Public deployment requires the configured operator');
    const projectId = parseIdentifier(rawProjectId, 'Project ID');
    if (this.#routing === undefined) return this.#deployProjectUnlocked(projectId, onEvent);
    return this.#operationLock.runExclusive(projectId, (lease) => this.#deployProjectUnlocked(projectId, onEvent, lease));
  }

  async #deployProjectUnlocked(
    projectId: string,
    onEvent: DeploymentEventCallback | undefined,
    lease?: ProjectOperationLease,
    requestedCommit?: string,
  ): Promise<DeploymentRecord> {
    const routing = this.#routing;
    const hostingLease = this.#workloadLease(lease);
    if (routing !== undefined) await routing.assertIdle(projectId, requireRoutingLease(lease));
    let project: DeploymentProject | null;

    try {
      project = await this.#database.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          userId: true,
          repositoryUrl: true,
          branch: true,
          containerPort: true,
          healthCheckPath: true,
        },
      });
    } catch {
      throw new AppError(500, 'Unable to initialize deployment');
    }

    if (project === null) throw new AppError(404, 'Project not found');
    const pinnedCommit = await this.#policy.selectCommit(project, requestedCommit);
    if (this.#hosting.publicHosting !== undefined) await assertPublicWorkloadReady(projectId);

    let deployment: DeploymentRecord;

    try {
      deployment = await this.#database.deployment.create({
        data: { projectId, status: DeploymentStatus.QUEUED },
      });
    } catch {
      throw new AppError(500, 'Unable to initialize deployment');
    }
    this.#emit(onEvent, {
      type: 'status',
      deploymentId: deployment.id,
      status: DeploymentStatus.QUEUED,
    });

    let stage: DeploymentStatusValue = DeploymentStatus.QUEUED;
    let repository: PreparedGitRepository | undefined;
    let image: DockerBuildResult | undefined;
    let startedContainer: StartContainerResult | undefined;

    try {
      stage = DeploymentStatus.CLONING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      this.#emitLog(onEvent, deployment.id, 'deployment', 'Cloning repository');
      const source = { repositoryUrl: project.repositoryUrl, branch: project.branch };
      repository = pinnedCommit === undefined
        ? await this.#gitService.prepareRepository(source)
        : await this.#gitService.prepareRepositoryAtCommit({ ...source, commitHash: pinnedCommit });
      if (pinnedCommit !== undefined && repository.commitHash !== pinnedCommit) {
        throw new AppError(422, 'Repository returned an unexpected commit');
      }
      const detectedApplication = await this.#applicationDetector.prepareBuild({
        repositoryDirectory: repository.repositoryPath,
        containerPort: project.containerPort,
      });
      deployment = await this.#updateDeployment(deployment.id, {
        commitHash: repository.commitHash,
        applicationType: detectedApplication.applicationType,
      });
      this.#emitLog(
        onEvent,
        deployment.id,
        'deployment',
        `Detected ${detectedApplication.applicationType} application`,
      );

      stage = DeploymentStatus.BUILDING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      await this.#assertWorkloadAllowed(project, repository.commitHash);
      await hostingLease?.assertValid();
      image = await this.#buildWorkload(
        {
          repositoryDirectory: repository.repositoryPath,
          projectId,
          deploymentId: deployment.id,
        },
        hostingLease, (output) => {
          const message = formatBuildOutput(output);
          if (message !== null) {
            this.#emitLog(onEvent, deployment.id, 'build', message);
          }
        },
      );
      deployment = await this.#updateDeployment(deployment.id, {
        imageId: image.imageId,
        imageTag: image.imageTag,
      });

      stage = DeploymentStatus.STARTING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      await this.#assertWorkloadAllowed(project, repository.commitHash);
      await hostingLease?.assertValid();
      startedContainer = await this.#startWorkload({
        imageIdentifier: image.imageId,
        containerPort: project.containerPort,
        deploymentId: deployment.id,
      }, project, repository.commitHash, hostingLease);
      await hostingLease?.assertValid();
      deployment = await this.#updateDeployment(deployment.id, {
        containerId: startedContainer.containerId,
        hostPort: startedContainer.hostPort,
      });

      stage = DeploymentStatus.HEALTHCHECKING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      this.#emitLog(
        onEvent,
        deployment.id,
        'deployment',
        `Checking application health at ${project.healthCheckPath}`,
      );
      await this.#healthCheckService.waitUntilHealthy({
        hostPort: startedContainer.hostPort,
        path: project.healthCheckPath,
        ...(startedContainer.hostAddress === undefined ? {} : { hostAddress: startedContainer.hostAddress }),
      });

      if (routing !== undefined) {
        await this.#gitService.cleanup(repository.repositoryPath);
        repository = undefined;
        deployment = await routing.promote(deployment, this.#now(), requireRoutingLease(hostingLease));
      } else {
        await this.#policy.assertApproved(project, deployment.commitHash);
        await hostingLease?.assertValid();
        stage = DeploymentStatus.RUNNING;
        deployment = await this.#updateDeployment(deployment.id, {
          status: stage, startedAt: this.#now(), finishedAt: null, errorMessage: null,
        });
      }
      stage = DeploymentStatus.RUNNING;
      this.#emit(onEvent, {
        type: 'status',
        deploymentId: deployment.id,
        status: stage,
      });

      if (repository !== undefined) {
        await this.#gitService.cleanup(repository.repositoryPath);
        repository = undefined;
      }

      this.#emit(onEvent, { type: 'completed', deployment });
      return deployment;
    } catch (error: unknown) {
      await this.#assertCleanupSafe(error, hostingLease, deployment.id, onEvent);
      const errorMessage = getSafeFailureMessage(error, stage);
      await this.#cleanupResources(repository, image, startedContainer);

      try {
        deployment = await this.#updateDeployment(deployment.id, {
          status: DeploymentStatus.FAILED,
          errorMessage,
          finishedAt: this.#now(),
        });
      } catch {
        throw new AppError(500, 'Deployment failed and status could not be saved');
      }

      this.#emit(onEvent, {
        type: 'status',
        deploymentId: deployment.id,
        status: DeploymentStatus.FAILED,
      });
      this.#emit(onEvent, {
        type: 'failed',
        deployment,
        errorMessage,
      });

      throw error instanceof AppError ? error : new AppError(422, errorMessage);
    }
  }

  async #executeRollback(
    sourceDeployment: OwnedDeployment,
    onEvent: DeploymentEventCallback | undefined,
    lease: ProjectOperationLease | undefined,
  ): Promise<DeploymentRecord> {
    const project = sourceDeployment.project;
    const routing = this.#routing;
    const hostingLease = this.#workloadLease(lease);
    await this.#assertWorkloadAllowed(project, sourceDeployment.commitHash);
    if (routing !== undefined) await routing.assertIdle(sourceDeployment.projectId, requireRoutingLease(lease));
    const commitHash = sourceDeployment.commitHash;

    if (commitHash === null) {
      throw new AppError(409, 'Rollback source does not have a commit hash');
    }

    let deployment: DeploymentRecord;

    try {
      deployment = await this.#database.deployment.create({
        data: {
          projectId: sourceDeployment.projectId,
          status: DeploymentStatus.QUEUED,
          rollbackSourceDeploymentId: sourceDeployment.id,
        },
      });
    } catch {
      throw new AppError(500, 'Unable to initialize rollback deployment');
    }

    this.#emit(onEvent, {
      type: 'status',
      deploymentId: deployment.id,
      status: DeploymentStatus.QUEUED,
    });
    this.#emitLog(
      onEvent,
      deployment.id,
      'deployment',
      `Rolling back from deployment ${sourceDeployment.id}`,
    );

    let stage: DeploymentStatusValue = DeploymentStatus.QUEUED;
    let repository: PreparedGitRepository | undefined;
    let builtImage: DockerBuildResult | undefined;
    let startedContainer: StartContainerResult | undefined;

    try {
      deployment = await this.#updateDeployment(deployment.id, { commitHash });

      const reusableImageIdentifier = this.#hosting.publicHosting === undefined
        ? sourceDeployment.imageId ?? sourceDeployment.imageTag
        : sourceDeployment.imageId !== null && /^sha256:[a-f0-9]{64}$/.test(sourceDeployment.imageId)
          ? sourceDeployment.imageId : null;
      const canReuseImage =
        reusableImageIdentifier !== null &&
        (await this.#buildService.imageExists(reusableImageIdentifier));
      let imageIdentifier: string;

      if (canReuseImage) {
        imageIdentifier = reusableImageIdentifier;
        const reusedImageData: DeploymentUpdateData = {};
        if (sourceDeployment.imageId !== null) {
          reusedImageData.imageId = sourceDeployment.imageId;
        }
        if (sourceDeployment.imageTag !== null) {
          reusedImageData.imageTag = sourceDeployment.imageTag;
        }
        if (sourceDeployment.applicationType !== null) {
          reusedImageData.applicationType = sourceDeployment.applicationType;
        }
        deployment = await this.#updateDeployment(
          deployment.id,
          reusedImageData,
        );
        this.#emitLog(
          onEvent,
          deployment.id,
          'deployment',
          `Reusing image from deployment ${sourceDeployment.id}`,
        );
      } else {
        stage = DeploymentStatus.CLONING;
        deployment = await this.#changeStatus(deployment.id, stage, onEvent);
        this.#emitLog(
          onEvent,
          deployment.id,
          'deployment',
          `Retrieving commit ${commitHash}`,
        );
        repository = await this.#gitService.prepareRepositoryAtCommit({
          repositoryUrl: sourceDeployment.project.repositoryUrl,
          branch: sourceDeployment.project.branch,
          commitHash,
        });
        if (repository.commitHash !== commitHash) throw new AppError(422, 'Repository returned an unexpected commit');
        const detectedApplication = await this.#applicationDetector.prepareBuild({
          repositoryDirectory: repository.repositoryPath,
          containerPort: sourceDeployment.project.containerPort,
        });
        deployment = await this.#updateDeployment(deployment.id, {
          applicationType: detectedApplication.applicationType,
        });

        stage = DeploymentStatus.BUILDING;
        deployment = await this.#changeStatus(deployment.id, stage, onEvent);
        await this.#assertWorkloadAllowed(project, commitHash);
        await hostingLease?.assertValid();
        builtImage = await this.#buildWorkload(
          {
            repositoryDirectory: repository.repositoryPath,
            projectId: sourceDeployment.projectId,
            deploymentId: deployment.id,
          },
          hostingLease, (output) => {
            const message = formatBuildOutput(output);
            if (message !== null) {
              this.#emitLog(onEvent, deployment.id, 'build', message);
            }
          },
        );
        imageIdentifier = builtImage.imageId;
        deployment = await this.#updateDeployment(deployment.id, {
          imageId: builtImage.imageId,
          imageTag: builtImage.imageTag,
        });
      }

      stage = DeploymentStatus.STARTING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      await this.#assertWorkloadAllowed(project, commitHash);
      await hostingLease?.assertValid();
      startedContainer = await this.#startWorkload({
        imageIdentifier,
        containerPort: sourceDeployment.project.containerPort,
        deploymentId: deployment.id,
      }, project, commitHash, hostingLease);
      await hostingLease?.assertValid();
      deployment = await this.#updateDeployment(deployment.id, {
        containerId: startedContainer.containerId,
        hostPort: startedContainer.hostPort,
      });

      stage = DeploymentStatus.HEALTHCHECKING;
      deployment = await this.#changeStatus(deployment.id, stage, onEvent);
      this.#emitLog(
        onEvent,
        deployment.id,
        'deployment',
        `Checking application health at ${sourceDeployment.project.healthCheckPath}`,
      );
      await this.#healthCheckService.waitUntilHealthy({
        hostPort: startedContainer.hostPort,
        path: sourceDeployment.project.healthCheckPath,
        ...(startedContainer.hostAddress === undefined ? {} : { hostAddress: startedContainer.hostAddress }),
      });

      if (routing !== undefined) {
        if (repository !== undefined) {
          await this.#gitService.cleanup(repository.repositoryPath);
          repository = undefined;
        }
        deployment = await routing.promote(deployment, this.#now(), requireRoutingLease(hostingLease));
      } else {
        await this.#policy.assertApproved(project, commitHash);
        await hostingLease?.assertValid();
        stage = DeploymentStatus.RUNNING;
        deployment = await this.#updateDeployment(deployment.id, {
          status: stage, startedAt: this.#now(), finishedAt: null, errorMessage: null,
        });
      }
      stage = DeploymentStatus.RUNNING;
      this.#emit(onEvent, {
        type: 'status',
        deploymentId: deployment.id,
        status: stage,
      });

      if (repository !== undefined) {
        await this.#gitService.cleanup(repository.repositoryPath);
        repository = undefined;
      }

    } catch (error: unknown) {
      await this.#assertCleanupSafe(error, hostingLease, deployment.id, onEvent);
      const errorMessage = getSafeFailureMessage(error, stage);
      await this.#cleanupResources(
        repository,
        builtImage,
        startedContainer,
      );

      try {
        deployment = await this.#updateDeployment(deployment.id, {
          status: DeploymentStatus.FAILED,
          errorMessage,
          finishedAt: this.#now(),
        });
      } catch {
        throw new AppError(500, 'Rollback failed and status could not be saved');
      }

      this.#emit(onEvent, {
        type: 'status',
        deploymentId: deployment.id,
        status: DeploymentStatus.FAILED,
      });
      this.#emit(onEvent, {
        type: 'failed',
        deployment,
        errorMessage,
      });

      throw error instanceof AppError ? error : new AppError(422, errorMessage);
    }

    if (routing === undefined) {
      await hostingLease?.assertValid();
      await this.#stopPreviousRunningDeployments(sourceDeployment.projectId, deployment.id, onEvent);
    }

    this.#emit(onEvent, { type: 'completed', deployment });
    return deployment;
  }

  async #changeStatus(
    deploymentId: string,
    status: DeploymentStatusValue,
    onEvent: DeploymentEventCallback | undefined,
  ): Promise<DeploymentRecord> {
    const deployment = await this.#updateDeployment(deploymentId, { status });
    this.#emit(onEvent, { type: 'status', deploymentId, status });
    return deployment;
  }

  #updateDeployment(
    deploymentId: string,
    data: DeploymentUpdateData,
  ): Promise<DeploymentRecord> {
    return this.#database.deployment.update({
      where: { id: deploymentId },
      data,
    });
  }

  async #getOwnedProject(
    userId: string,
    projectId: string,
  ): Promise<DeploymentProject> {
    assertPublicOperator(userId, this.#hosting);
    const project = await this.#database.project.findFirst({
      where: { id: projectId, userId },
      select: {
        id: true,
        userId: true,
        repositoryUrl: true,
        branch: true,
        containerPort: true,
        healthCheckPath: true,
      },
    });

    if (project === null) throw new AppError(404, 'Project not found');
    return project;
  }

  async #getOwnedDeployment(
    userId: string,
    deploymentId: string,
  ): Promise<OwnedDeployment> {
    assertPublicOperator(userId, this.#hosting);
    const deployment = await this.#database.deployment.findFirst({
      where: { id: deploymentId, project: { userId } },
      include: {
        project: {
          select: {
            id: true,
            userId: true,
            repositoryUrl: true,
            branch: true,
            containerPort: true,
            healthCheckPath: true,
          },
        },
      },
    });

    if (deployment === null) throw new AppError(404, 'Deployment not found');
    return deployment;
  }

  #requireContainerId(deployment: DeploymentRecord): string {
    if (deployment.containerId === null) {
      throw new AppError(409, 'Deployment does not have a container');
    }

    return deployment.containerId;
  }

  #withoutProject(deployment: OwnedDeployment): DeploymentRecord {
    return {
      id: deployment.id,
      projectId: deployment.projectId,
      rollbackSourceDeploymentId: deployment.rollbackSourceDeploymentId,
      applicationType: deployment.applicationType,
      commitHash: deployment.commitHash,
      status: deployment.status,
      containerId: deployment.containerId,
      imageId: deployment.imageId,
      imageTag: deployment.imageTag,
      hostPort: deployment.hostPort,
      errorMessage: deployment.errorMessage,
      startedAt: deployment.startedAt,
      finishedAt: deployment.finishedAt,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
    };
  }

  async #stopPreviousRunningDeployments(
    projectId: string,
    activeDeploymentId: string,
    onEvent: DeploymentEventCallback | undefined,
  ): Promise<void> {
    let deployments: DeploymentRecord[];

    try {
      deployments = await this.#database.deployment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      throw new AppError(
        500,
        'New deployment is running but previous deployments could not be stopped',
      );
    }

    const previousRunningDeployments = deployments.filter(
      (deployment) =>
        deployment.id !== activeDeploymentId &&
        deployment.status === DeploymentStatus.RUNNING,
    );

    for (const deployment of previousRunningDeployments) {
      if (deployment.containerId === null) {
        throw new AppError(
          500,
          'New deployment is running but a previous deployment could not be stopped',
        );
      }

      try {
        await this.#containerService.stopContainer(deployment.containerId);
        const stoppedDeployment = await this.#updateDeployment(deployment.id, {
          status: DeploymentStatus.STOPPED,
          finishedAt: this.#now(),
        });
        this.#emit(onEvent, {
          type: 'status',
          deploymentId: stoppedDeployment.id,
          status: DeploymentStatus.STOPPED,
        });
      } catch {
        throw new AppError(
          500,
          'New deployment is running but a previous deployment could not be stopped',
        );
      }
    }
  }

  async #cleanupResources(
    repository: PreparedGitRepository | undefined,
    image: DockerBuildResult | undefined,
    startedContainer: StartContainerResult | undefined,
  ): Promise<void> {
    if (startedContainer !== undefined) {
      try {
        await this.#containerService.removeContainer(startedContainer.containerId);
      } catch {
        // Preserve the original deployment failure.
      }
    }

    if (image !== undefined) {
      try {
        await this.#buildService.removeImage(image.imageTag);
      } catch {
        // Preserve the original deployment failure.
      }
    }

    if (repository !== undefined) {
      try {
        await this.#gitService.cleanup(repository.repositoryPath);
      } catch {
        // Preserve the original deployment failure.
      }
    }
  }

  async #assertCleanupSafe(
    error: unknown,
    lease: ProjectOperationLease | undefined,
    deploymentId: string,
    onEvent: DeploymentEventCallback | undefined,
  ): Promise<void> {
    try {
      if (error instanceof RoutingPendingError) throw error;
      await lease?.assertValid();
    } catch {
      const pending = new RoutingPendingError();
      this.#emitLog(onEvent, deploymentId, 'deployment', pending.message);
      throw pending;
    }
  }

  #emitLog(
    onEvent: DeploymentEventCallback | undefined,
    deploymentId: string,
    source: 'deployment' | 'build',
    message: string,
  ): void {
    this.#emit(onEvent, {
      type: 'log',
      deploymentId,
      source,
      message,
    });
  }

  #emit(
    onEvent: DeploymentEventCallback | undefined,
    event: DeploymentEvent,
  ): void {
    try {
      onEvent?.(event);
    } catch {
      // Event consumers must not interrupt deployment orchestration.
    }
  }
}

export const deploymentService = new DeploymentService();
