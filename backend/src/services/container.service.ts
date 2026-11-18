import Dockerode from 'dockerode';

import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { isWorkloadAddress, RESERVED_WORKLOAD_PORT } from '../utils/workload-address.js';
import { dockerDeadline } from './docker-deadline.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/i;
const FULL_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/i;
const HOST_PORT_PATTERN = /^\d{1,5}$/;
const MAX_IMAGE_IDENTIFIER_LENGTH = 512;
const DEFAULT_LOG_TAIL = 1_000;
const MAX_LOG_TAIL = 10_000;
const MAX_LOG_RESPONSE_BYTES = 1024 * 1024;
const TRUNCATED_LOG_PREFIX = '[Earlier log output truncated]\n';
const WORKLOAD_RESTART_POLICY = 'unless-stopped';
const SHUTDOWN_GRACE_SECONDS = 30;
const LIFECYCLE_DEADLINE_MS = 45_000;
const LINUX_WORKLOAD_LIMITS = {
  Memory: 512 * 1024 * 1024,
  MemorySwap: 512 * 1024 * 1024,
  NanoCpus: 1_000_000_000,
  PidsLimit: 128,
  SecurityOpt: ['no-new-privileges:true'],
} as const;

export type StartContainerInput = {
  imageIdentifier: string;
  containerPort: number;
  deploymentId: string;
  hostAddress?: string;
};

export type ContainerRuntimeStatus = {
  containerId: string;
  status: string;
  running: boolean;
};

export type StartContainerResult = ContainerRuntimeStatus & {
  hostPort: number;
  hostAddress?: string;
};

export type RoutingContainer = {
  containerId: string;
  deploymentId: string;
  containerPort: number;
  hostAddress?: string;
};

export type ContainerLogsOptions = {
  tail?: number;
  timestamps?: boolean;
};

export type ContainerCpuStatistics = {
  usagePercent: number;
  totalUsage: number;
  systemUsage: number;
  onlineCpus: number;
};

export type ContainerMemoryStatistics = {
  usageBytes: number;
  limitBytes: number;
  usagePercent: number;
};

export type ContainerUptime = {
  startedAt: string | null;
  uptimeSeconds: number;
};

export type ContainerCreateOptions = {
  abortSignal?: AbortSignal;
  name: string;
  Image: string;
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
    LogConfig: {
      Type: 'json-file';
      Config: { 'max-size': string; 'max-file': string };
    };
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    PidsLimit?: number;
    SecurityOpt?: readonly string[];
    RestartPolicy: { Name: typeof WORKLOAD_RESTART_POLICY };
  };
  Labels: Record<string, string>;
};

type ContainerInspectResult = {
  Id?: unknown;
  Config?: { Labels?: Record<string, unknown> | null };
  State?: {
    Status?: unknown;
    Running?: unknown;
    StartedAt?: unknown;
    FinishedAt?: unknown;
  };
  NetworkSettings?: {
    Ports?: Record<string, unknown>;
  };
  HostConfig?: {
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    PidsLimit?: number;
    SecurityOpt?: string[] | null;
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
    Privileged?: boolean;
    Binds?: unknown[] | null;
    Mounts?: unknown[] | null;
    VolumesFrom?: unknown[] | null;
    PortBindings?: Record<string, unknown> | null;
  };
};

export type DockerContainer = {
  id: string;
  start: (options?: { abortSignal: AbortSignal }) => Promise<unknown>;
  stop: (options?: { abortSignal: AbortSignal; t: number }) => Promise<unknown>;
  restart: (options?: { abortSignal: AbortSignal; t: number }) => Promise<unknown>;
  remove: (options: { force: boolean; abortSignal?: AbortSignal }) => Promise<unknown>;
  inspect: (options?: { abortSignal: AbortSignal }) => Promise<ContainerInspectResult>;
  logs: (options: {
    stdout: boolean;
    stderr: boolean;
    follow: false;
    timestamps: boolean;
    tail: number | 'all';
  }) => Promise<Buffer | string>;
  stats: (options: { stream: false }) => Promise<unknown>;
};

export type DockerClient = {
  modem?: { getSocketPath?: () => Promise<string | undefined> | string | undefined };
  createContainer: (options: ContainerCreateOptions) => Promise<DockerContainer>;
  getContainer: (id: string) => DockerContainer;
  listContainers: (options: { all: true; filters?: { label: string[] }; abortSignal?: AbortSignal }) => Promise<{ Id: string }[]>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertLinuxWorkloadLimits = (details: ContainerInspectResult): void => {
  const config = details.HostConfig;
  if (config?.Memory !== LINUX_WORKLOAD_LIMITS.Memory ||
    config.MemorySwap !== LINUX_WORKLOAD_LIMITS.MemorySwap || config.NanoCpus !== LINUX_WORKLOAD_LIMITS.NanoCpus ||
    config.PidsLimit !== LINUX_WORKLOAD_LIMITS.PidsLimit || config.RestartPolicy?.Name !== WORKLOAD_RESTART_POLICY ||
    !config.SecurityOpt?.includes('no-new-privileges:true') || config.Privileged !== false ||
    (config.NetworkMode !== 'bridge' && config.NetworkMode !== 'default') ||
    config.Binds?.length || config.Mounts?.length || config.VolumesFrom?.length) {
    throw new AppError(422, 'Docker did not verify the Linux workload limits; create a new deployment');
  }
};

const getRecord = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const child = value[key];
  return isRecord(child) ? child : undefined;
};

const getFiniteNumber = (
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined => {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
};

const parseContainerId = (containerId: string): string => {
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    throw new AppError(400, 'Container ID is invalid');
  }

  return containerId.toLowerCase();
};

const parseContainerPort = (containerPort: number): number => {
  if (
    !Number.isInteger(containerPort) ||
    containerPort < 1 ||
    containerPort > 65_535
  ) {
    throw new AppError(400, 'Container port must be an integer from 1 to 65535');
  }

  return containerPort;
};

const parseStartInput = (input: StartContainerInput): StartContainerInput => {
  const imageIdentifier = input.imageIdentifier.trim();

  if (
    imageIdentifier.length === 0 ||
    imageIdentifier.length > MAX_IMAGE_IDENTIFIER_LENGTH ||
    /\s/.test(imageIdentifier)
  ) {
    throw new AppError(400, 'Image identifier is invalid');
  }

  if (!UUID_PATTERN.test(input.deploymentId)) {
    throw new AppError(400, 'Deployment ID must be a valid UUID');
  }

  return {
    imageIdentifier,
    containerPort: parseContainerPort(input.containerPort),
    deploymentId: input.deploymentId.toLowerCase(),
  };
};

const parseTail = (tail: number | undefined): number | 'all' => {
  if (tail === undefined) return DEFAULT_LOG_TAIL;

  if (!Number.isInteger(tail) || tail < 0 || tail > MAX_LOG_TAIL) {
    throw new AppError(400, 'Log tail must be an integer from 0 to 10000');
  }

  return tail;
};

const toOperationError = (error: unknown, message: string): AppError => {
  if (error instanceof AppError) return error;

  const statusCode =
    isRecord(error) && error.statusCode === 404 ? 404 : 422;
  return new AppError(statusCode, message);
};

export class ContainerLifecyclePendingError extends AppError {
  constructor() {
    super(503, 'Docker lifecycle operation outcome is unconfirmed; verify container state before retrying');
  }
}

const lifecycleFailure = (error: unknown, message: string): AppError => {
  if (error instanceof AppError) return error;
  if (isRecord(error) && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return toOperationError(error, message);
  }
  return new ContainerLifecyclePendingError();
};

const readRuntimeStatus = (
  inspectResult: ContainerInspectResult,
  fallbackId: string,
): ContainerRuntimeStatus => {
  const containerId =
    typeof inspectResult.Id === 'string' && inspectResult.Id.length > 0
      ? inspectResult.Id
      : fallbackId;
  const status = inspectResult.State?.Status;
  const running = inspectResult.State?.Running;

  if (typeof status !== 'string' || typeof running !== 'boolean') {
    throw new AppError(500, 'Docker returned invalid container status');
  }

  return { containerId, status, running };
};

const assertDeploymentContainerOwnership = (details: ContainerInspectResult, containerId: string, deploymentId: string) => {
  if (details.Id !== containerId || details.Config?.Labels?.['deployflow.deployment-id'] !== deploymentId) {
    throw new AppError(422, 'Docker could not verify deployment container ownership');
  }
};

const readHostPort = (
  inspectResult: ContainerInspectResult,
  containerPort: number,
): number => {
  const binding =
    inspectResult.NetworkSettings?.Ports?.[`${String(containerPort)}/tcp`];

  if (!Array.isArray(binding) || !isRecord(binding[0])) {
    throw new AppError(500, 'Docker did not assign a host port');
  }

  const rawHostPort = binding[0].HostPort;
  const hostPort =
    typeof rawHostPort === 'string' && HOST_PORT_PATTERN.test(rawHostPort)
      ? Number(rawHostPort)
      : NaN;

  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
    throw new AppError(500, 'Docker returned an invalid host port');
  }

  return hostPort;
};

const assertAddress = (bindings: unknown, hostAddress: string) => {
  if (!Array.isArray(bindings) || bindings.length !== 1 || !isRecord(bindings[0]) || bindings[0].HostIp !== hostAddress ||
    (isWorkloadAddress(hostAddress) && bindings[0].HostPort !== String(RESERVED_WORKLOAD_PORT))) {
    throw new AppError(422, 'Docker did not verify the reserved IPv4 loopback binding');
  }
};

const assertPublishedAddress = (details: ContainerInspectResult, port: number, hostAddress: string) => {
  assertAddress(details.NetworkSettings?.Ports?.[String(port) + '/tcp'], hostAddress);
};

const assertRequestedAddress = (details: ContainerInspectResult, port: number, hostAddress: string) => {
  assertAddress(details.HostConfig?.PortBindings?.[String(port) + '/tcp'], hostAddress);
};

const decodeDockerLogs = (logs: Buffer | string): string => {
  if (typeof logs === 'string' || logs.length < 8) {
    return logs.toString();
  }

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < logs.length) {
    if (logs.length - offset < 8) return logs.toString('utf8');

    const streamType = logs.readUInt8(offset);
    const frameLength = logs.readUInt32BE(offset + 4);
    const frameStart = offset + 8;
    const frameEnd = frameStart + frameLength;

    if (
      (streamType !== 0 && streamType !== 1 && streamType !== 2) ||
      logs.readUIntBE(offset + 1, 3) !== 0 ||
      frameEnd > logs.length
    ) {
      return logs.toString('utf8');
    }

    chunks.push(logs.subarray(frameStart, frameEnd));
    offset = frameEnd;
  }

  return Buffer.concat(chunks).toString('utf8');
};

const limitLogResponse = (logs: string): string => {
  const encodedLogs = Buffer.from(logs, 'utf8');
  if (encodedLogs.length <= MAX_LOG_RESPONSE_BYTES) return logs;

  const prefix = Buffer.from(TRUNCATED_LOG_PREFIX, 'utf8');
  const availableBytes = MAX_LOG_RESPONSE_BYTES - prefix.length;
  const suffix = encodedLogs
    .subarray(encodedLogs.length - availableBytes)
    .toString('utf8')
    .replace(/^\uFFFD+/, '');

  return `${TRUNCATED_LOG_PREFIX}${suffix}`;
};

const parseDockerDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || value.startsWith('0001-01-01')) return null;

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
};

export class ContainerService {
  readonly #docker: DockerClient;
  readonly #now: () => number;

  public constructor(
    docker: DockerClient = new Dockerode({ timeout: LIFECYCLE_DEADLINE_MS }) as unknown as DockerClient,
    now: () => number = Date.now,
    private readonly linuxHosting = env.hosting.publicHosting !== undefined,
  ) {
    this.#docker = docker;
    this.#now = now;
  }

  public async startContainer(
    rawInput: StartContainerInput,
    beforeStart?: (containerId: string) => Promise<void>,
  ): Promise<StartContainerResult> {
    const input = parseStartInput(rawInput);
    const hostAddress = rawInput.hostAddress ?? '127.0.0.1';
    if (rawInput.hostAddress !== undefined && !isWorkloadAddress(hostAddress)) {
      throw new AppError(422, 'Invalid reserved Docker bind address');
    }
    const portKey = `${String(input.containerPort)}/tcp`;
    let container: DockerContainer | undefined;

    try {
      const createOptions: ContainerCreateOptions = {
        name: `deployflow-deployment-${input.deploymentId}`,
        Image: input.imageIdentifier,
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          PortBindings: {
            [portKey]: [{ HostIp: hostAddress, HostPort: rawInput.hostAddress === undefined ? '' : String(RESERVED_WORKLOAD_PORT) }],
          },
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': '10m', 'max-file': '3' },
          },
          RestartPolicy: { Name: WORKLOAD_RESTART_POLICY },
          ...(this.linuxHosting ? LINUX_WORKLOAD_LIMITS : {}),
        },
        Labels: { 'deployflow.deployment-id': input.deploymentId },
      };
      container = await dockerDeadline((options) => this.#docker.createContainer({ ...createOptions, ...options }));
      await beforeStart?.(container.id);
      const created = container;
      await dockerDeadline((options) => created.start(options));

      const details = await dockerDeadline((options) => created.inspect(options));
      if (rawInput.hostAddress !== undefined) assertPublishedAddress(details, input.containerPort, hostAddress);
      return {
        ...readRuntimeStatus(details, container.id),
        hostPort: readHostPort(details, input.containerPort),
        ...(rawInput.hostAddress === undefined ? {} : { hostAddress }),
      };
    } catch (error: unknown) {
      if (container !== undefined) await this.#cleanupFailedContainer(container);
      throw toOperationError(error, 'Unable to create and start container');
    }
  }

  public async stopContainer(
    rawContainerId: string,
  ): Promise<ContainerRuntimeStatus> {
    const container = this.#getContainer(rawContainerId);

    try {
      await dockerDeadline((options) => container.stop({ ...options, t: SHUTDOWN_GRACE_SECONDS }), LIFECYCLE_DEADLINE_MS);
      const runtime = readRuntimeStatus(await dockerDeadline((options) => container.inspect(options)), container.id);
      if (runtime.running || runtime.status === 'restarting') throw new ContainerLifecyclePendingError();
      return runtime;
    } catch (error: unknown) {
      throw lifecycleFailure(error, 'Unable to stop container');
    }
  }

  public async restartContainer(
    rawContainerId: string,
    rawContainerPort: number,
    hostAddress?: string,
  ): Promise<StartContainerResult> {
    const container = this.#getContainer(rawContainerId);
    const containerPort = parseContainerPort(rawContainerPort);

    try {
      if (this.linuxHosting) {
        const previous = await dockerDeadline((options) => container.inspect(options));
        assertLinuxWorkloadLimits(previous);
        assertRequestedAddress(previous, containerPort, hostAddress ?? '127.0.0.1');
      }
      await dockerDeadline((options) => container.restart({ ...options, t: SHUTDOWN_GRACE_SECONDS }), LIFECYCLE_DEADLINE_MS);
      const details = await dockerDeadline((options) => container.inspect(options));
      const runtime = readRuntimeStatus(details, container.id);
      if (!runtime.running || runtime.status !== 'running') throw new ContainerLifecyclePendingError();
      if (hostAddress !== undefined) assertPublishedAddress(details, containerPort, hostAddress);
      return {
        ...runtime,
        hostPort: readHostPort(details, containerPort),
        ...(hostAddress === undefined ? {} : { hostAddress }),
      };
    } catch (error: unknown) {
      throw lifecycleFailure(error, 'Unable to restart container');
    }
  }

  public async removeContainer(rawContainerId: string): Promise<void> {
    const container = this.#getContainer(rawContainerId);

    try {
      await dockerDeadline((options) => container.remove({ ...options, force: true }));
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to remove container');
    }
  }

  public async removeDeploymentContainers(
    deploymentId: string,
    containerId: string | null,
    beforeRemove: () => Promise<void>,
  ): Promise<void> {
    if (!UUID_PATTERN.test(deploymentId)) throw new AppError(422, 'Invalid deployment ID for container cleanup');
    const expectedId = containerId === null ? null : parseContainerId(containerId);
    const options = { all: true as const, filters: { label: ['deployflow.deployment-id=' + deploymentId] } };
    const found = await dockerDeadline((deadline) => this.#docker.listContainers({ ...options, ...deadline }));
    const references = new Set(found.map(({ Id }) => Id));
    if (expectedId !== null) references.add(expectedId);
    for (const reference of references) {
      if (!/^[a-f0-9]{64}$/.test(reference)) throw new AppError(422, 'Docker returned an invalid container ID');
      const details = await this.#inspectContainerForCleanup(reference);
      if (details === null) continue;
      assertDeploymentContainerOwnership(details, reference, deploymentId);
      await beforeRemove();
      try {
        await dockerDeadline((deadline) => this.#docker.getContainer(reference).remove({ ...deadline, force: true }));
      } catch (error) {
        const failure = toOperationError(error, 'Unable to remove the deployment container');
        if (failure.statusCode !== 404) throw failure;
      }
      if (await this.#inspectContainerForCleanup(reference) !== null) {
        throw new AppError(503, 'Docker has not confirmed removal of the deployment container');
      }
    }
    if ((await dockerDeadline((deadline) => this.#docker.listContainers({ ...options, ...deadline }))).length !== 0) {
      throw new AppError(503, 'Docker still reports a container owned by the deployment');
    }
  }

  async #inspectContainerForCleanup(reference: string): Promise<ContainerInspectResult | null> {
    try {
      return await dockerDeadline((options) => this.#docker.getContainer(reference).inspect(options));
    } catch (error) {
      const failure = toOperationError(error, 'Unable to verify the deployment container state');
      if (failure.statusCode !== 404) throw failure;
      return null;
    }
  }

  public async inventoryPublicStartup(): Promise<{ containerId: string; deploymentId: string; hostAddress: string }[]> {
    const result: { containerId: string; deploymentId: string; hostAddress: string }[] = [];
    const containers = await dockerDeadline((options) => this.#docker.listContainers({ all: true, ...options }));
    for (const { Id } of containers) {
      if (!/^[a-f0-9]{64}$/.test(Id)) throw new AppError(503, 'Docker returned an invalid inventory ID');
      const details = await dockerDeadline((options) => this.#docker.getContainer(Id).inspect(options));
      if (details.Id !== Id) throw new AppError(503, 'Docker inventory changed during startup');
      const status = details.State?.Status;
      const restart = details.HostConfig?.RestartPolicy?.Name;
      if ((status === 'created' || status === 'exited') && (restart === 'no' || restart === '')) continue;
      assertLinuxWorkloadLimits(details);
      const deploymentId = details.Config?.Labels?.['deployflow.deployment-id'];
      const bindings = Object.values(details.HostConfig?.PortBindings ?? {});
      const binding = bindings[0];
      if (typeof deploymentId !== 'string' || !UUID_PATTERN.test(deploymentId) ||
        bindings.length !== 1 || !Array.isArray(binding) || binding.length !== 1 || !isRecord(binding[0]) ||
        typeof binding[0].HostIp !== 'string') {
        throw new AppError(503, 'Docker inventory contains an unmanaged or incompletely verified workload');
      }
      assertAddress(binding, binding[0].HostIp);
      result.push({ containerId: Id, deploymentId, hostAddress: binding[0].HostIp });
    }
    return result;
  }

  public async inspectStatus(
    rawContainerId: string,
  ): Promise<ContainerRuntimeStatus> {
    const container = this.#getContainer(rawContainerId);

    try {
      return readRuntimeStatus(await dockerDeadline((options) => container.inspect(options)), container.id);
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to inspect container status');
    }
  }

  public async inspectOwnedDeploymentContainer(rawContainerId: string, deploymentId: string): Promise<ContainerRuntimeStatus | null> {
    if (!FULL_CONTAINER_ID_PATTERN.test(rawContainerId)) throw new AppError(400, 'Shutdown requires a full Docker container ID');
    if (!UUID_PATTERN.test(deploymentId)) throw new AppError(400, 'Deployment ID must be a valid UUID');
    const containerId = rawContainerId.toLowerCase();
    const details = await this.#inspectContainerForCleanup(containerId);
    if (details === null) return null;
    assertDeploymentContainerOwnership(details, containerId, deploymentId.toLowerCase());
    return readRuntimeStatus(details, containerId);
  }

  public async inspectLoopbackRoutingPort(input: RoutingContainer): Promise<number> {
    if (!FULL_CONTAINER_ID_PATTERN.test(input.containerId)) {
      throw new AppError(400, 'Routing requires a full Docker container ID');
    }
    if (!UUID_PATTERN.test(input.deploymentId)) {
      throw new AppError(400, 'Deployment ID must be a valid UUID');
    }
    const containerId = input.containerId.toLowerCase();
    const containerPort = parseContainerPort(input.containerPort);

    try {
      const socket = await this.#docker.modem?.getSocketPath?.();
      const local = socket !== undefined && (process.platform === 'win32'
        ? /^\/\/\.\/pipe\/[a-z0-9_.-]+$/i.test(socket.replaceAll('\\', '/'))
        : /^\/[^/]/.test(socket));
      if (!local) throw new AppError(422, 'Routing requires a local Docker socket or named pipe');

      const details = await dockerDeadline((options) => this.#docker.getContainer(containerId).inspect(options));
      if (this.linuxHosting) assertLinuxWorkloadLimits(details);
      if (
        details.Id !== containerId ||
        details.Config?.Labels?.['deployflow.deployment-id'] !== input.deploymentId.toLowerCase() ||
        details.State?.Running !== true ||
        details.State.Status !== 'running'
      ) {
        throw new AppError(422, 'Docker did not verify the running deployment container');
      }
      assertPublishedAddress(details, containerPort, input.hostAddress ?? '127.0.0.1');
      return readHostPort(details, containerPort);
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to verify Docker routing binding');
    }
  }

  public async getLogs(
    rawContainerId: string,
    options: ContainerLogsOptions = {},
  ): Promise<string> {
    const container = this.#getContainer(rawContainerId);
    const tail = parseTail(options.tail);

    try {
      const logs = await dockerDeadline(() => container.logs({
        stdout: true,
        stderr: true,
        follow: false,
        timestamps: options.timestamps ?? false,
        tail,
      }));
      return limitLogResponse(decodeDockerLogs(logs));
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to retrieve container logs');
    }
  }

  public async getCpuStatistics(
    rawContainerId: string,
  ): Promise<ContainerCpuStatistics> {
    const statistics = await this.#getStatistics(rawContainerId);
    const cpu = getRecord(statistics, 'cpu_stats');
    const previousCpu = getRecord(statistics, 'precpu_stats');
    const usage = cpu === undefined ? undefined : getRecord(cpu, 'cpu_usage');
    const previousUsage =
      previousCpu === undefined ? undefined : getRecord(previousCpu, 'cpu_usage');
    const totalUsage = getFiniteNumber(usage, 'total_usage');
    const previousTotalUsage = getFiniteNumber(previousUsage, 'total_usage');
    const systemUsage = getFiniteNumber(cpu, 'system_cpu_usage');
    const previousSystemUsage = getFiniteNumber(
      previousCpu,
      'system_cpu_usage',
    );
    const onlineCpus = getFiniteNumber(cpu, 'online_cpus') ?? 1;

    if (
      totalUsage === undefined ||
      previousTotalUsage === undefined ||
      systemUsage === undefined ||
      previousSystemUsage === undefined ||
      onlineCpus < 1
    ) {
      throw new AppError(500, 'Docker returned invalid CPU statistics');
    }

    const cpuDelta = totalUsage - previousTotalUsage;
    const systemDelta = systemUsage - previousSystemUsage;
    const usagePercent =
      cpuDelta > 0 && systemDelta > 0
        ? (cpuDelta / systemDelta) * onlineCpus * 100
        : 0;

    return { usagePercent, totalUsage, systemUsage, onlineCpus };
  }

  public async getMemoryStatistics(
    rawContainerId: string,
  ): Promise<ContainerMemoryStatistics> {
    const statistics = await this.#getStatistics(rawContainerId);
    const memory = getRecord(statistics, 'memory_stats');
    const usageBytes = getFiniteNumber(memory, 'usage');
    const limitBytes = getFiniteNumber(memory, 'limit');

    if (
      usageBytes === undefined ||
      usageBytes < 0 ||
      limitBytes === undefined ||
      limitBytes <= 0
    ) {
      throw new AppError(500, 'Docker returned invalid memory statistics');
    }

    return {
      usageBytes,
      limitBytes,
      usagePercent: (usageBytes / limitBytes) * 100,
    };
  }

  public async getUptime(rawContainerId: string): Promise<ContainerUptime> {
    const container = this.#getContainer(rawContainerId);

    try {
      const details = await dockerDeadline((options) => container.inspect(options));
      const startedAt = parseDockerDate(details.State?.StartedAt);

      if (startedAt === null) return { startedAt: null, uptimeSeconds: 0 };

      const finishedAt = parseDockerDate(details.State?.FinishedAt);
      const endTime = details.State?.Running === true || finishedAt === null
        ? this.#now()
        : finishedAt.getTime();

      return {
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.max(
          0,
          Math.floor((endTime - startedAt.getTime()) / 1000),
        ),
      };
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to retrieve container uptime');
    }
  }

  #getContainer(rawContainerId: string): DockerContainer {
    return this.#docker.getContainer(parseContainerId(rawContainerId));
  }

  async #getStatistics(rawContainerId: string): Promise<Record<string, unknown>> {
    const container = this.#getContainer(rawContainerId);

    try {
      const statistics = await dockerDeadline(() => container.stats({ stream: false }));

      if (!isRecord(statistics)) {
        throw new AppError(500, 'Docker returned invalid container statistics');
      }

      return statistics;
    } catch (error: unknown) {
      throw toOperationError(error, 'Unable to retrieve container statistics');
    }
  }

  async #cleanupFailedContainer(container: DockerContainer): Promise<void> {
    try {
      await dockerDeadline((options) => container.remove({ ...options, force: true }));
    } catch {
      // Preserve the startup failure if Docker cannot remove the partial container.
    }
  }
}

export const containerService = new ContainerService();
