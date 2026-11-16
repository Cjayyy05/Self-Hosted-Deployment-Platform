import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitRepositoryService,
  type GitCommandRunner,
} from '../src/services/git-repository.service.js';
import { ApplicationDetector } from '../src/services/application-detector.service.js';

const repositoryUrl = 'https://github.com/example/example-api';
const commitHash = '0123456789abcdef0123456789abcdef01234567';

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe('GitRepositoryService', () => {
  let runGit: ReturnType<typeof vi.fn<GitCommandRunner>>;

  beforeEach(() => {
    runGit = vi.fn<GitCommandRunner>();
  });

  it('rejects checkout when HEAD differs from the requested SHA and cleans up', async () => {
    const service = new GitRepositoryService({ runGit });
    let checkout: string | undefined;
    runGit.mockImplementation((args) => {
      if (args[0] === 'init') checkout = args.at(-1);
      return Promise.resolve('f'.repeat(40));
    });
    await expect(service.prepareRepositoryAtCommit({ repositoryUrl, branch: 'main', commitHash }))
      .rejects.toMatchObject({ statusCode: 422, message: 'Repository returned an unexpected commit' });
    expect(checkout).toBeDefined();
    expect(await pathExists(checkout ?? '')).toBe(false);
  });

  it('retrieves an independently reviewed exact SHA after the configured branch has moved', async () => {
    const source = await mkdtemp(join(tmpdir(), 'deployflow-reviewed-git-'));
    const exec = promisify(execFile);
    const git = async (...args: string[]) => (await exec('git', ['-c', 'core.autocrlf=false', ...args], {
      windowsHide: true, timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })).stdout;
    let checkoutPath: string | undefined;
    const service = new GitRepositoryService({
      runGit: (args) => args.at(-4) === 'remote'
        ? git(...args.slice(0, -1), source)
        : git(...args),
    });
    try {
      await git('-C', source, 'init', '-b', 'main');
      await git('-C', source, 'config', 'user.email', 'fixture@example.net');
      await git('-C', source, 'config', 'user.name', 'DeployFlow Fixture');
      await git('-C', source, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(source, 'Dockerfile'), 'FROM scratch\n');
      await git('-C', source, 'add', 'Dockerfile');
      await git('-C', source, 'commit', '-m', 'Reviewed revision');
      const reviewed = (await git('-C', source, 'rev-parse', 'HEAD')).trim();
      await writeFile(join(source, 'Dockerfile'), 'FROM scratch\nLABEL revision=new\n');
      await git('-C', source, 'commit', '-am', 'Moved branch tip');
      const tip = (await git('-C', source, 'rev-parse', 'HEAD')).trim();
      expect(tip).not.toBe(reviewed);
      const result = await service.prepareRepositoryAtCommit({ repositoryUrl, branch: 'main', commitHash: reviewed });
      checkoutPath = result.repositoryPath;
      expect(result.commitHash).toBe(reviewed);
      expect(await readFile(join(checkoutPath, 'Dockerfile'), 'utf8')).toBe('FROM scratch\n');
    } finally {
      if (checkoutPath !== undefined) await service.cleanup(checkoutPath);
      await rm(source, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects an invalid URL before creating or cloning', async () => {
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepository({ repositoryUrl: 'not-a-url', branch: 'main' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'A valid public GitHub HTTPS URL is required',
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects a non-GitHub URL', async () => {
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepository({
        repositoryUrl: 'https://gitlab.com/example/example-api',
        branch: 'main',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(runGit).not.toHaveBeenCalled();
  });

  it.each([
    'file:///tmp/example-api',
    'ssh://github.com/example/example-api',
    'git://github.com/example/example-api',
  ])('rejects the unsupported repository protocol in %s', async (url) => {
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepository({ repositoryUrl: url, branch: 'main' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects a missing branch', async () => {
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepository({ repositoryUrl, branch: '' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Repository branch is invalid',
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('returns a structured clone error and removes the temporary directory', async () => {
    let temporaryPath: string | undefined;
    runGit.mockImplementation((args) => {
      temporaryPath = args.at(-1);
      return Promise.reject(new Error('raw Git error that must not escape'));
    });
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepository({ repositoryUrl, branch: 'main' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      message:
        'Repository could not be cloned or the requested branch was not found',
    });
    expect(temporaryPath).toBeDefined();
    expect(await pathExists(temporaryPath ?? '')).toBe(false);
  });

  it('keeps a Dockerfile-free clone available for application detection and cleanup', async () => {
    let temporaryPath: string | undefined;
    runGit.mockImplementation(async (args) => {
      if (args[0] === 'clone') {
        temporaryPath = args.at(-1);
        if (temporaryPath === undefined) throw new Error('Missing destination');
        await writeFile(
          join(temporaryPath, 'package.json'),
          JSON.stringify({ scripts: { start: 'node server.js' } }),
        );
        return '';
      }

      return `${commitHash}\n`;
    });
    const service = new GitRepositoryService({ runGit });

    const prepared = await service.prepareRepository({
      repositoryUrl,
      branch: 'main',
    });
    const detected = await new ApplicationDetector().prepareBuild({
      repositoryDirectory: prepared.repositoryPath,
      containerPort: 8080,
    });

    expect(detected.applicationType).toBe('NODE');
    expect(await pathExists(join(prepared.repositoryPath, 'Dockerfile'))).toBe(
      true,
    );

    await service.cleanup(prepared.repositoryPath);
    expect(await pathExists(prepared.repositoryPath)).toBe(false);
  });

  it('validates a repository and provides explicit cleanup', async () => {
    runGit.mockImplementation(async (args) => {
      if (args[0] === 'clone') {
        const destination = args.at(-1);

        if (destination === undefined) {
          throw new Error('Clone destination was not provided');
        }

        await writeFile(join(destination, 'Dockerfile'), 'FROM scratch\n');
        return '';
      }

      return `${commitHash.toUpperCase()}\n`;
    });
    const service = new GitRepositoryService({ runGit });

    const result = await service.prepareRepository({
      repositoryUrl: `${repositoryUrl}.git`,
      branch: 'feature/deploy',
    });

    expect(result).toEqual({
      repositoryPath: result.repositoryPath,
      commitHash,
      metadata: {
        provider: 'github',
        owner: 'example',
        name: 'example-api',
        repositoryUrl,
        branch: 'feature/deploy',
      },
    });
    expect(await pathExists(join(result.repositoryPath, 'Dockerfile'))).toBe(
      true,
    );
    expect(runGit).toHaveBeenNthCalledWith(1, [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      'feature/deploy',
      '--',
      repositoryUrl,
      result.repositoryPath,
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, [
      '-C',
      result.repositoryPath,
      'rev-parse',
      'HEAD',
    ]);

    await service.cleanup(result.repositoryPath);

    expect(await pathExists(result.repositoryPath)).toBe(false);
  });

  it('retrieves an exact commit with argument-safe Git calls', async () => {
    runGit.mockImplementation(async (args) => {
      if (args[0] === 'init') {
        const destination = args.at(-1);
        if (destination === undefined) throw new Error('Missing destination');
        await writeFile(join(destination, 'Dockerfile'), 'FROM scratch\n');
      }

      if (args.at(-2) === 'rev-parse') return `${commitHash.toUpperCase()}\n`;
      return '';
    });
    const service = new GitRepositoryService({ runGit });

    const result = await service.prepareRepositoryAtCommit({
      repositoryUrl,
      branch: 'main',
      commitHash: commitHash.toUpperCase(),
    });

    expect(runGit).toHaveBeenNthCalledWith(1, [
      'init',
      '--',
      result.repositoryPath,
    ]);
    expect(runGit).toHaveBeenNthCalledWith(2, [
      '-C',
      result.repositoryPath,
      'remote',
      'add',
      'origin',
      repositoryUrl,
    ]);
    expect(runGit).toHaveBeenNthCalledWith(3, [
      '-C',
      result.repositoryPath,
      'fetch',
      '--depth',
      '1',
      'origin',
      commitHash,
    ]);
    expect(runGit).toHaveBeenNthCalledWith(4, [
      '-C',
      result.repositoryPath,
      'checkout',
      '--detach',
      'FETCH_HEAD',
    ]);
    expect(result.commitHash).toBe(commitHash);

    await service.cleanup(result.repositoryPath);
    expect(await pathExists(result.repositoryPath)).toBe(false);
  });

  it('rejects an invalid rollback commit before invoking Git', async () => {
    const service = new GitRepositoryService({ runGit });

    await expect(
      service.prepareRepositoryAtCommit({
        repositoryUrl,
        branch: 'main',
        commitHash: '--upload-pack=malicious',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Repository commit hash is invalid',
    });
    expect(runGit).not.toHaveBeenCalled();
  });
});
