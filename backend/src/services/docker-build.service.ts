import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import dockerIgnore from '@balena/dockerignore';
import { type Ignore } from '@balena/dockerignore';
import Dockerode from 'dockerode';
import tar from 'tar-fs';

import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { dockerDeadline } from './docker-deadline.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const DOCKERFILE_NAME = 'Dockerfile';
const MAX_IMAGE_IDENTIFIER_LENGTH = 512;

export type DockerBuildInput = {
  repositoryDirectory: string;
  projectId: string;
  deploymentId: string;
  buildNetworkId?: string;
  confirmTerminal?: () => Promise<void>;
  markSubmitted?: () => void;
};

export type DockerBuildOutput = {
  stream?: string;
  status?: string;
  progress?: string;
  error?: string;
};

export type DockerBuildOutputCallback = (output: DockerBuildOutput) => void;

export type DockerBuildResult = {
  imageId: string;
  imageTag: string;
};

type DockerImage = {
  inspect: () => Promise<{ Id: string }>;
  remove: (options: { force: boolean; abortSignal?: AbortSignal }) => Promise<unknown>;
};

const isDockerNotFoundError = (error: unknown): boolean =>
  isRecord(error) && error.statusCode === 404;

type DockerBuildOptions = {
  dockerfile: string;
  t: string;
  rm: boolean;
  forcerm: boolean;
  version?: '1';
  memory?: number;
  memswap?: number;
  cpuperiod?: number;
  cpuquota?: number;
  networkmode?: string;
  abortSignal?: AbortSignal;
  cgroupparent?: string;
};

type DockerBuildStream = NodeJS.ReadableStream & {
  destroy: () => void;
  readableEnded?: boolean;
};

type DockerClient = {
  buildImage: (
    context: NodeJS.ReadableStream,
    options: DockerBuildOptions,
  ) => Promise<DockerBuildStream>;
  getImage: (name: string) => DockerImage;
  modem: {
    followProgress: (
      stream: NodeJS.ReadableStream,
      onFinished: (error: Error | null, result: unknown[]) => void,
      onProgress?: (output: unknown) => void,
    ) => void;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof value[key] === 'string' ? value[key] : undefined;

const normalizeBuildOutput = (value: unknown): DockerBuildOutput => {
  if (!isRecord(value)) {
    return {};
  }

  const errorDetail = isRecord(value.errorDetail)
    ? getString(value.errorDetail, 'message')
    : undefined;

  const output: DockerBuildOutput = {};
  const stream = getString(value, 'stream');
  const status = getString(value, 'status');
  const progress = getString(value, 'progress');
  const error = getString(value, 'error') ?? errorDetail;

  if (stream !== undefined) output.stream = stream;
  if (status !== undefined) output.status = status;
  if (progress !== undefined) output.progress = progress;
  if (error !== undefined) output.error = error;

  return output;
};

const parseIdentifier = (value: string, label: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }

  return value.toLowerCase();
};

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

const normalizeContextPath = (root: string, path: string): string =>
  relative(root, path).split(sep).join('/');

const createBuildContext = async (
  repositoryDirectory: string,
): Promise<DockerBuildStream> => {
  let dockerIgnoreContents = '';

  try {
    dockerIgnoreContents = await readFile(
      `${repositoryDirectory}/.dockerignore`,
      'utf8',
    );
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw new AppError(500, 'Unable to read Docker build context rules');
    }
  }

  let matcher: Ignore;

  try {
    const createDockerIgnore = dockerIgnore as unknown as () => Ignore;
    matcher = createDockerIgnore().add(dockerIgnoreContents);
  } catch {
    throw new AppError(422, 'Repository contains an invalid .dockerignore');
  }

  return tar.pack(repositoryDirectory, {
    dereference: false,
    strict: true,
    ignore: (path) => {
      const contextPath = normalizeContextPath(repositoryDirectory, path);

      if (
        contextPath === '' ||
        contextPath === DOCKERFILE_NAME ||
        contextPath === '.dockerignore'
      ) {
        return false;
      }

      return (
        contextPath === '.git' ||
        contextPath.startsWith('.git/') ||
        matcher.ignores(contextPath)
      );
    },
  }) as unknown as DockerBuildStream;
};

const validateRepositoryDirectory = async (
  repositoryDirectory: string,
): Promise<string> => {
  if (repositoryDirectory.trim().length === 0) {
    throw new AppError(400, 'Repository directory is required');
  }

  let directoryDetails;

  try {
    directoryDetails = await lstat(repositoryDirectory);
  } catch {
    throw new AppError(400, 'Repository directory does not exist');
  }

  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) {
    throw new AppError(400, 'Repository directory must be a real directory');
  }

  const resolvedDirectory = await realpath(repositoryDirectory);

  try {
    const dockerfileDetails = await lstat(
      `${resolvedDirectory}/${DOCKERFILE_NAME}`,
    );

    if (!dockerfileDetails.isFile() || dockerfileDetails.isSymbolicLink()) {
      throw new AppError(422, 'Dockerfile not found at repository root');
    }
  } catch (error: unknown) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isMissingFileError(error)) {
      throw new AppError(422, 'Dockerfile not found at repository root');
    }

    throw new AppError(500, 'Unable to inspect repository Dockerfile');
  }

  return resolvedDirectory;
};

export class DockerBuildService {
  readonly #docker: DockerClient;
  #building = false;

  public constructor(
    docker: DockerClient = new Dockerode() as unknown as DockerClient,
    private readonly linuxHosting = env.hosting.publicHosting !== undefined,
  ) {
    this.#docker = docker;
  }

  public async buildImage(
    input: DockerBuildInput,
    onOutput?: DockerBuildOutputCallback,
  ): Promise<DockerBuildResult> {
    if (!this.linuxHosting) return this.#buildImage(input, onOutput);
    if (!/^[a-f0-9]{64}$/.test(input.buildNetworkId ?? '')) {
      throw new AppError(503, 'Public builds require a recorded Docker network');
    }
    if (this.#building) throw new AppError(409, 'Another image build is already running');
    this.#building = true;
    try {
      return await dockerDeadline(({ abortSignal }) => this.#buildImage(input, onOutput, abortSignal), 10 * 60_000);
    } finally {
      this.#building = false;
    }
  }

  async #buildImage(
    input: DockerBuildInput,
    onOutput?: DockerBuildOutputCallback,
    signal?: AbortSignal,
  ): Promise<DockerBuildResult> {
    const projectId = parseIdentifier(input.projectId, 'Project ID');
    const deploymentId = parseIdentifier(input.deploymentId, 'Deployment ID');
    const repositoryDirectory = await validateRepositoryDirectory(
      input.repositoryDirectory,
    );
    const imageTag = `deployflow/project-${projectId}/deployment-${deploymentId}`;
    const context = await createBuildContext(repositoryDirectory);
    let buildStream: DockerBuildStream | undefined;
    const abortBuild = () => buildStream?.destroy();

    try {
      signal?.throwIfAborted();
      input.markSubmitted?.();
      const activeBuildStream = await this.#docker.buildImage(context, {
        dockerfile: DOCKERFILE_NAME,
        t: imageTag,
        rm: true,
        forcerm: true,
        // The classic API applies these limits to RUN containers. The
        // deployflow-build systemd slice also bounds aggregate build tasks.
        ...(this.linuxHosting && signal !== undefined && input.buildNetworkId !== undefined ? {
          version: '1',
          memory: 1536 * 1024 * 1024,
          memswap: 1536 * 1024 * 1024,
          cpuperiod: 100_000,
          cpuquota: 100_000,
          networkmode: input.buildNetworkId,
          abortSignal: signal,
          cgroupparent: 'deployflow-build.slice',
        } as const : {}),
      });
      buildStream = activeBuildStream;
      signal?.addEventListener('abort', abortBuild, { once: true });
      signal?.throwIfAborted();

      let buildFailure = false;

      const failed = await new Promise<boolean>((resolve, reject) => {
        this.#docker.modem.followProgress(
          activeBuildStream,
          (error, result) => {
            if (error !== null) {
              reject(new AppError(422, 'Docker image build failed'));
              return;
            }
            resolve(buildFailure || result.some((output) => normalizeBuildOutput(output).error !== undefined));
          },
          (rawOutput) => {
            const output = normalizeBuildOutput(rawOutput);
            buildFailure ||= output.error !== undefined;

            try {
              onOutput?.(output);
            } catch {
              reject(new AppError(500, 'Docker build output handler failed'));
            }
          },
        );
      });

      if (input.confirmTerminal !== undefined) {
        if (activeBuildStream.readableEnded !== true || signal?.aborted) throw new AppError(503, 'Docker build outcome is unknown');
        await input.confirmTerminal();
      }
      if (failed) throw new AppError(422, 'Docker image build failed');
      const image = await dockerDeadline(() => this.#docker.getImage(imageTag).inspect());

      if (!IMAGE_ID_PATTERN.test(image.Id)) {
        throw new AppError(500, 'Docker returned an invalid image ID');
      }

      return { imageId: image.Id.toLowerCase(), imageTag };
    } catch (error: unknown) {
      await this.#removePartialImage(imageTag);

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(422, 'Docker image build failed');
    } finally {
      signal?.removeEventListener('abort', abortBuild);
      context.destroy();
      buildStream?.destroy();
    }
  }

  public async removeImage(imageIdentifier: string): Promise<void> {
    const normalizedIdentifier = imageIdentifier.trim();

    if (
      normalizedIdentifier.length === 0 ||
      normalizedIdentifier.length > MAX_IMAGE_IDENTIFIER_LENGTH ||
      /\s/.test(normalizedIdentifier)
    ) {
      throw new AppError(400, 'Image identifier is invalid');
    }

    try {
      await dockerDeadline((options) => this.#docker.getImage(normalizedIdentifier).remove({ ...options, force: true }));
    } catch {
      throw new AppError(422, 'Unable to remove Docker image');
    }
  }

  public async imageExists(imageIdentifier: string): Promise<boolean> {
    const normalizedIdentifier = imageIdentifier.trim();

    if (
      normalizedIdentifier.length === 0 ||
      normalizedIdentifier.length > MAX_IMAGE_IDENTIFIER_LENGTH ||
      /\s/.test(normalizedIdentifier)
    ) {
      throw new AppError(400, 'Image identifier is invalid');
    }

    try {
      const inspected = await dockerDeadline(() => this.#docker.getImage(normalizedIdentifier).inspect());
      return !/^sha256:[a-f0-9]{64}$/.test(normalizedIdentifier) || inspected.Id === normalizedIdentifier;
    } catch (error: unknown) {
      if (isDockerNotFoundError(error)) return false;
      throw new AppError(503, 'Unable to inspect Docker image');
    }
  }

  async #removePartialImage(imageTag: string): Promise<void> {
    try {
      await dockerDeadline((options) => this.#docker.getImage(imageTag).remove({ ...options, force: true }));
    } catch {
      // A failed build may not have created an image to remove.
    }
  }
}

export const dockerBuildService = new DockerBuildService();
