import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DockerBuildService,
  type DockerBuildOutput,
} from '../src/services/docker-build.service.js';

const mode = vi.hoisted(() => ({ public: false }));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const module = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...module, env: { ...module.env, get hosting() {
    return mode.public ? { ...module.env.hosting, publicHosting: { operatorId: 'fixture' } } : module.env.hosting;
  } } };
});

const projectId = '11111111-1111-4111-8111-111111111111';
const deploymentId = '22222222-2222-4222-8222-222222222222';
const imageId = `sha256:${'a'.repeat(64)}`;
const imageTag =
  `deployflow/project-${projectId}/deployment-${deploymentId}`;

type ProgressHandler = (output: unknown) => void;
type FinishedHandler = (error: Error | null, result: unknown[]) => void;
type BuildImage = (
  context: NodeJS.ReadableStream,
  options: {
    dockerfile: string;
    t: string;
    rm: boolean;
    forcerm: boolean;
  },
) => Promise<PassThrough>;

describe('DockerBuildService', () => {
  let repositoryDirectory: string;
  let buildStream: PassThrough;
  let removeImage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mode.public = false;
    repositoryDirectory = await mkdtemp(join(tmpdir(), 'deployflow-build-'));
    await writeFile(join(repositoryDirectory, 'Dockerfile'), 'FROM scratch\n');
    buildStream = new PassThrough();
    removeImage = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(repositoryDirectory, { recursive: true, force: true });
  });

  const createDocker = (
    followProgress: (
      stream: NodeJS.ReadableStream,
      onFinished: FinishedHandler,
      onProgress?: ProgressHandler,
    ) => void,
  ) => ({
    buildImage: vi.fn<BuildImage>().mockResolvedValue(buildStream),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: imageId }),
      remove: removeImage,
    }),
    modem: { followProgress },
  });

  it('builds with Dockerode, streams output, and returns the image identity', async () => {
    const output: DockerBuildOutput[] = [];
    const docker = createDocker((_stream, onFinished, onProgress) => {
      onProgress?.({ stream: 'Step 1/1 : FROM scratch\n' });
      onProgress?.({ status: 'Built', progress: '100%' });
      onFinished(null, [{ aux: { ID: imageId } }]);
    });
    const service = new DockerBuildService(docker);

    const result = await service.buildImage(
      { repositoryDirectory, projectId, deploymentId },
      (event) => output.push(event),
    );

    expect(result).toEqual({ imageId, imageTag });
    expect(output).toEqual([
      { stream: 'Step 1/1 : FROM scratch\n' },
      { status: 'Built', progress: '100%' },
    ]);
    expect(typeof docker.buildImage.mock.calls[0]?.[0].pipe).toBe('function');
    expect(docker.buildImage.mock.calls[0]?.[1]).toEqual({
      dockerfile: 'Dockerfile',
      t: imageTag,
      rm: true,
      forcerm: true,
    });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('converts Docker progress failures to an AppError and removes a partial image', async () => {
    const output: DockerBuildOutput[] = [];
    const docker = createDocker((_stream, onFinished, onProgress) => {
      onProgress?.({
        errorDetail: { message: 'executor failed running [/bin/sh]' },
      });
      onFinished(null, []);
    });
    const service = new DockerBuildService(docker);

    await expect(
      service.buildImage(
        { repositoryDirectory, projectId, deploymentId },
        (event) => output.push(event),
      ),
    ).rejects.toMatchObject({
      name: 'AppError',
      statusCode: 422,
      message: 'Docker image build failed',
    });
    expect(output).toEqual([
      { error: 'executor failed running [/bin/sh]' },
    ]);
    expect(docker.getImage).toHaveBeenCalledWith(imageTag);
    expect(removeImage).toHaveBeenCalledWith({ force: true, abortSignal: expect.any(AbortSignal) as unknown });
  });

  it('serializes and limits Linux builds with public mode enabled and zero approvals', async () => {
    mode.public = true;
    let finish: FinishedHandler | undefined;
    const docker = createDocker((_stream, callback) => { finish = callback; });
    const service = new DockerBuildService(docker);
    const buildNetworkId = 'a'.repeat(64);
    const build = service.buildImage({ repositoryDirectory, projectId, deploymentId, buildNetworkId });
    try {
      await expect(service.buildImage({ repositoryDirectory, projectId, deploymentId, buildNetworkId }))
        .rejects.toMatchObject({ statusCode: 409 });
      await vi.waitFor(() => { expect(finish).toBeDefined(); });
      expect(docker.buildImage.mock.calls[0]?.[1]).toMatchObject({
        version: '1', memory: 1536 * 1024 * 1024, memswap: 1536 * 1024 * 1024,
        cpuperiod: 100_000, cpuquota: 100_000, networkmode: buildNetworkId, cgroupparent: 'deployflow-build.slice',
      });
    } finally {
      finish?.(null, [{ aux: { ID: imageId } }]);
      await build;
    }
  });

  it('converts a Docker daemon rejection and tolerates absent partial images', async () => {
    const docker = createDocker(() => undefined);
    docker.buildImage.mockRejectedValue(new Error('connect ENOENT docker.sock'));
    removeImage.mockRejectedValue(new Error('image not found'));
    const service = new DockerBuildService(docker);

    await expect(
      service.buildImage({ repositoryDirectory, projectId, deploymentId }),
    ).rejects.toMatchObject({
      name: 'AppError',
      statusCode: 422,
      message: 'Docker image build failed',
    });
    expect(removeImage).toHaveBeenCalledWith({ force: true, abortSignal: expect.any(AbortSignal) as unknown });
  });

  it('turns output callback failures into a structured error and cleans up', async () => {
    const docker = createDocker((_stream, onFinished, onProgress) => {
      onProgress?.({ stream: 'Step 1/1\n' });
      onFinished(null, []);
    });
    const service = new DockerBuildService(docker);

    await expect(
      service.buildImage(
        { repositoryDirectory, projectId, deploymentId },
        () => {
          throw new Error('consumer disconnected');
        },
      ),
    ).rejects.toMatchObject({
      name: 'AppError',
      statusCode: 500,
      message: 'Docker build output handler failed',
    });
    expect(removeImage).toHaveBeenCalledWith({ force: true, abortSignal: expect.any(AbortSignal) as unknown });
  });

  it('removes a deployment image explicitly for orchestration cleanup', async () => {
    const docker = createDocker(() => undefined);
    const service = new DockerBuildService(docker);

    await expect(service.removeImage(imageTag)).resolves.toBeUndefined();

    expect(docker.getImage).toHaveBeenCalledWith(imageTag);
    expect(removeImage).toHaveBeenCalledWith({ force: true, abortSignal: expect.any(AbortSignal) as unknown });
  });

  it('checks whether a rollback image is still available', async () => {
    const docker = createDocker(() => undefined);
    const service = new DockerBuildService(docker);

    await expect(service.imageExists(imageId)).resolves.toBe(true);
    expect(docker.getImage).toHaveBeenCalledWith(imageId);
  });

  it('reports a missing rollback image without treating it as a Docker failure', async () => {
    const docker = createDocker(() => undefined);
    docker.getImage.mockReturnValueOnce({
      inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      remove: removeImage,
    });
    const service = new DockerBuildService(docker);

    await expect(service.imageExists(imageId)).resolves.toBe(false);
  });

  it('rejects an inspected rollback image whose ID differs from the recorded immutable ID', async () => {
    const docker = createDocker(() => undefined);
    const service = new DockerBuildService(docker);
    await expect(service.imageExists('sha256:' + 'b'.repeat(64))).resolves.toBe(false);
  });
});
