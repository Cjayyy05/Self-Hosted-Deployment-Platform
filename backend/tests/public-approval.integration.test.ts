import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../src/generated/prisma/client.js';
import type { DockerClient, RoutingContainer } from '../src/services/container.service.js';
import { AppError } from '../src/utils/app-error.js';

const fixture = vi.hoisted(() => ({
  db: null as PrismaClient | null,
  operator: '11111111-1111-4111-8111-111111111111',
  otherUser: '22222222-2222-4222-8222-222222222222',
  project: '284547fd-804e-42f8-a56f-5a7e9a147e7f',
  deployment: '33333333-3333-4333-8333-333333333333',
  repository: 'https://github.com/example/hello',
  legacyCommit: 'fd9c3bfc38fe39bdb0fe115805f694ae435d0ca1',
  imageId: 'sha256:' + 'f'.repeat(64),
  running: new Map<string, number>([['a'.repeat(64), 51001]]),
  nextPort: 51010,
  route: null as number | null,
  routeAddress: '127.0.0.1',
  otherRoutes: new Map<string, { address: string; port: number }>(),
  adminUnavailable: false,
}));

vi.mock('../src/config/database.js', () => ({ database: fixture.db }));
vi.mock('../src/config/env.js', async (importOriginal) => {
  const module = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...module,
    env: {
      ...module.env, registrationEnabled: false, githubWebhookSecretKey: undefined,
      hosting: {
        origin: 'https://apps.example.net', hostnameSuffix: 'apps.example.net', adminSocketPath: '/tmp/caddy-fixture.sock',
        publicHosting: { operatorId: fixture.operator, legacyProjectId: fixture.project },
        publicApp: {
          projectId: fixture.project, repositoryUrl: fixture.repository, branch: 'main', commits: new Set([fixture.legacyCommit]),
        },
      },
    },
  };
});

vi.mock('../src/services/application-routing.service.js', async (importOriginal) => {
  const module = await importOriginal<typeof import('../src/services/application-routing.service.js')>();
  const write = async (id: string, target?: RoutingContainer, options?: { beforeWrite?: () => Promise<void> }) => {
    if (fixture.adminUnavailable) throw new module.ApplicationRoutingError('unavailable', 'Fixture admin unavailable');
    await options?.beforeWrite?.();
    const port = target === undefined ? undefined : fixture.running.get(target.containerId);
    const address = target?.hostAddress ?? '127.0.0.1';
    if (id === fixture.project) {
      fixture.route = port ?? null;
      fixture.routeAddress = address;
    } else if (port === undefined) fixture.otherRoutes.delete(id);
    else fixture.otherRoutes.set(id, { address, port });
  };
  const read = (id: string) => id === fixture.project
    ? fixture.route === null ? null : { address: fixture.routeAddress, port: fixture.route }
    : fixture.otherRoutes.get(id) ?? null;
  const host = (id: string) => 'app-' + id.replaceAll('-', '') + '.apps.example.net';
  const unavailable = () => new module.ApplicationRoutingError('unavailable', 'Fixture admin unavailable');
  return {
    ...module,
    createApplicationRoutingService: () => ({
      upsert: write, repair: write,
      remove: (id: string, options?: { beforeWrite?: () => Promise<void> }) => write(id, undefined, options),
      readPort: (id: string) => fixture.adminUnavailable ? Promise.reject(unavailable()) : Promise.resolve(read(id)?.port ?? null),
      readTarget: (id: string) => fixture.adminUnavailable ? Promise.reject(unavailable()) : Promise.resolve(read(id)),
      readDashboardTargets: () => fixture.adminUnavailable ? Promise.reject(unavailable()) : Promise.resolve(new Map([
        ...(fixture.route === null ? [] : [[host(fixture.project), { address: fixture.routeAddress, port: fixture.route }] as const]),
        ...Array.from(fixture.otherRoutes, ([id, target]) => [host(id), target] as const),
      ])),
    }),
  };
});

const dbUrl = process.env.DEPLOYFLOW_PHASE1_TEST_DB;
const migrationName = '20261115000000_project_public_approvals';
const schema = 'phase1_' + randomUUID().replaceAll('-', '');
const nextCommit = 'b'.repeat(40);
const extraCommit = 'c'.repeat(40);
const approvalUrl = (id: string) => '/api/projects/' + id + '/public-approval';
const deployUrl = (id: string) => '/api/projects/' + id + '/deploy';
const actionUrl = (id: string, action: string) => '/api/deployments/' + id + '/' + action;
const approvalInput = (commitHash: string) => ({ repositoryUrl: fixture.repository, branch: 'main', commitHash });
const gate = () => {
  let open: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open: () => { open?.(); }, wait };
};

describe.skipIf(dbUrl === undefined)('Phase 1 public approvals with disposable PostgreSQL', () => {
  let sql: Client | undefined;
  let db: PrismaClient;
  let apiServer: Server;
  let closeSocket: (() => Promise<void>) | undefined;
  let api: ReturnType<typeof request>;
  let auth: string;
  let otherAuth: string;
  let routes: NonNullable<typeof import('../src/services/deployment-routing.service.js').deploymentRoutingService>;
  let git: typeof import('../src/services/git-repository.service.js').gitRepositoryService;
  let builds: typeof import('../src/services/docker-build.service.js').dockerBuildService;
  let containers: typeof import('../src/services/container.service.js').containerService;
  let probes: typeof import('../src/services/application-health-check.service.js').ApplicationHealthCheckService;
  let restoredBaseline: { project: unknown; deployment: unknown }[];
  let originalBaseline: { project: unknown; deployment: unknown }[];

  const baseline = async (client: Client) => {
    const result = await client.query<{ project: unknown; deployment: unknown }>(
      'SELECT to_jsonb(p) AS project, to_jsonb(d) AS deployment FROM "Project" p JOIN "Deployment" d ON d.id = p."activeDeploymentId"',
    );
    return result.rows;
  };

  beforeAll(async () => {
    const url = new URL(dbUrl ?? '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/deployflow_phase1' || url.port === '5432' ||
      url.port === '' || !['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Use a dedicated loopback PostgreSQL database named deployflow_phase1 on a non-default port');
    }
    sql = new Client({ connectionString: url.href });
    await sql.connect();
    await sql.query('CREATE SCHEMA "' + schema + '"');
    await sql.query('SET search_path TO "' + schema + '"');
    const migrations = resolve('prisma', 'migrations');
    const entries = (await readdir(migrations, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory() && entry.name < migrationName).map((entry) => entry.name).sort();
    for (const entry of entries) await sql.query(await readFile(resolve(migrations, entry, 'migration.sql'), 'utf8'));
    await sql.query(
      'INSERT INTO "User" (id, email, "passwordHash", "updatedAt") VALUES ($1, $2, $3, NOW()), ($4, $5, $3, NOW())',
      [fixture.operator, 'operator@example.net', 'unused', fixture.otherUser, 'other@example.net'],
    );
    await sql.query(
      'INSERT INTO "Project" (id, "userId", "hostnameLabel", name, "repositoryUrl", branch, "containerPort", "updatedAt") ' +
      'VALUES ($1, $2, $3, $4, $5, $6, 8080, NOW())',
      [fixture.project, fixture.operator, 'app-' + fixture.project.replaceAll('-', ''), 'Hello fixture', fixture.repository, 'main'],
    );
    await sql.query(
      'INSERT INTO "Deployment" (id, "projectId", "commitHash", status, "containerId", "imageId", "hostPort", "updatedAt") ' +
      "VALUES ($1, $2, $3, 'RUNNING', $4, $5, 51001, NOW())",
      [fixture.deployment, fixture.project, fixture.legacyCommit, 'a'.repeat(64), fixture.imageId],
    );
    await sql.query('UPDATE "Project" SET "activeDeploymentId" = $1 WHERE id = $2', [fixture.deployment, fixture.project]);
    originalBaseline = await baseline(sql);
    await sql.query(await readFile(resolve(migrations, migrationName, 'migration.sql'), 'utf8'));
    await sql.query(await readFile(resolve(migrations, '20261116000000_public_hosting_safety', 'migration.sql'), 'utf8'));
    await sql.query(await readFile(resolve(migrations, '20261116010000_public_route_fencing', 'migration.sql'), 'utf8'));
    await sql.query(await readFile(resolve(migrations, '20261116020000_public_workload_safety', 'migration.sql'), 'utf8'));
    await sql.query(await readFile(resolve(migrations, '20261116030000_public_cutover_boot', 'migration.sql'), 'utf8'));
    restoredBaseline = await baseline(sql);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }, { schema }) });
    fixture.db = db;
    const { createApp } = await import('../src/app.js');
    const { attachDeploymentSocket } = await import('../src/realtime/deployment-socket.js');
    const { createAccessToken } = await import('../src/services/token.service.js');
    const { deploymentRoutingService } = await import('../src/services/deployment-routing.service.js');
    ({ gitRepositoryService: git } = await import('../src/services/git-repository.service.js'));
    ({ dockerBuildService: builds } = await import('../src/services/docker-build.service.js'));
    ({ containerService: containers } = await import('../src/services/container.service.js'));
    ({ ApplicationHealthCheckService: probes } = await import('../src/services/application-health-check.service.js'));
    if (!deploymentRoutingService) throw new Error('Missing fixture route coordinator');
    routes = deploymentRoutingService;
    apiServer = createServer(createApp());
    const socketServer = attachDeploymentSocket(apiServer);
    closeSocket = async () => { await socketServer.close(); };
    apiServer.listen(0, '127.0.0.1');
    await once(apiServer, 'listening');
    api = request(apiServer);
    auth = 'Bearer ' + await createAccessToken(fixture.operator);
    otherAuth = 'Bearer ' + await createAccessToken(fixture.otherUser);
  }, 20_000);

  beforeEach(async () => {
    const { PublicHostingReadinessService } = await import('../src/services/public-hosting-readiness.service.js');
    vi.spyOn(PublicHostingReadinessService.prototype, 'verifyDns').mockResolvedValue();
    vi.spyOn(PublicHostingReadinessService.prototype, 'verifyHttps').mockResolvedValue();
  });

  afterAll(async () => {
    await closeSocket?.();
    await fixture.db?.$disconnect();
    if (sql !== undefined) {
      await sql.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await sql.end();
    }
  });

  const mockWorkload = async () => {
    const { buildNetworkService } = await import('../src/services/build-network.service.js');
    vi.spyOn(buildNetworkService, 'run').mockImplementation((_projectId, _deploymentId, _lease, build) =>
      build('e'.repeat(64), () => Promise.resolve(), () => undefined));
    const branchTip = vi.spyOn(git, 'prepareRepository').mockRejectedValue(new Error('Branch tip has moved'));
    const checkout = vi.spyOn(git, 'prepareRepositoryAtCommit').mockImplementation(({ commitHash, ...source }) => Promise.resolve({
      repositoryPath: 'fixture', commitHash,
      metadata: { ...source, provider: 'github', owner: 'example', name: 'hello' },
    }));
    vi.spyOn(git, 'cleanup').mockResolvedValue();
    const build = vi.spyOn(builds, 'buildImage').mockResolvedValue({ imageId: fixture.imageId, imageTag: 'fixture' });
    vi.spyOn(builds, 'removeImage').mockResolvedValue();
    const cached = vi.spyOn(builds, 'imageExists').mockResolvedValue(true);
    const { applicationDetector } = await import('../src/services/application-detector.service.js');
    vi.spyOn(applicationDetector, 'prepareBuild').mockResolvedValue({
      applicationType: 'DOCKERFILE', framework: 'dockerfile', generatedDockerfile: false,
    });
    const start = vi.spyOn(containers, 'startContainer').mockImplementation(async (_input, beforeStart) => {
      const containerId = randomUUID().replaceAll('-', '').repeat(2);
      await beforeStart?.(containerId);
      const hostPort = ++fixture.nextPort;
      fixture.running.set(containerId, hostPort);
      return { containerId, hostPort, running: true, status: 'running' };
    });
    vi.spyOn(containers, 'stopContainer').mockImplementation((containerId) => {
      fixture.running.delete(containerId);
      return Promise.resolve({ containerId, running: false, status: 'exited' });
    });
    vi.spyOn(containers, 'removeContainer').mockResolvedValue();
    vi.spyOn(containers, 'inspectStatus').mockImplementation((containerId) => Promise.resolve({
      containerId, running: fixture.running.has(containerId), status: 'running',
    }));
    vi.spyOn(containers, 'inspectOwnedDeploymentContainer').mockImplementation((containerId) =>
      containers.inspectStatus(containerId));
    vi.spyOn(containers, 'inspectLoopbackRoutingPort').mockImplementation(({ containerId }) => {
      const port = fixture.running.get(containerId);
      if (port === undefined) return Promise.reject(new AppError(404, 'Fixture container is stopped'));
      return Promise.resolve(port);
    });
    const health = vi.spyOn(probes.prototype, 'waitUntilHealthy').mockResolvedValue();
    const remove = vi.spyOn(containers, 'removeDeploymentContainers').mockImplementation(async (_deploymentId, id, beforeRemove) => {
      await beforeRemove();
      if (id !== null) fixture.running.delete(id);
    });
    return { branchTip, checkout, build, cached, start, health, remove };
  };

  it('preserves pre-migration project and deployment records and recovers the exact legacy approval', async () => {
    expect(restoredBaseline).toMatchObject(originalBaseline);
    expect(await db.deployment.findUnique({ where: { id: fixture.deployment } })).toMatchObject({
      publicAddressIndex: null, buildNetworkId: null, buildHostBootId: null, buildEndedAt: null, guardedBuild: false,
    });
    expect(await db.projectPublicApproval.count()).toBe(0);
    await expect(api.get(approvalUrl(fixture.project)).set('Authorization', auth)).resolves.toMatchObject({
      status: 200, body: { approval: { status: 'APPROVED', source: 'LEGACY', commits: [fixture.legacyCommit] } },
    });
    await mockWorkload();
    await routes.reconcile();
    expect(fixture.route).toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id: fixture.project } })).activeDeploymentId).toBe(fixture.deployment);
  });

  it('rejects unowned, unimported, and changed routing configurations without touching the live route', async () => {
    const { env } = await import('../src/config/env.js');
    const { assertPublicHostingStartup } = await import('../src/services/public-hosting-safety.service.js');
    const durable = { ...env.hosting };
    delete durable.publicApp;
    const route = () => Promise.resolve(new Map());
    const inventory = () => Promise.resolve([]);
    const correct = { operatorId: fixture.operator, legacyProjectId: fixture.project };
    await expect(assertPublicHostingStartup({ ...env.hosting, publicHosting: { operatorId: fixture.otherUser,
      legacyProjectId: fixture.project } }, db, route)).rejects.toThrow('belong to the configured operator');
    await expect(assertPublicHostingStartup(durable, db, route)).rejects.toThrow('active public SHA');
    await expect(assertPublicHostingStartup(env.hosting, db,
      () => Promise.resolve(new Map([['fixture.apps.example.net', { address: '127.0.0.1', port: 51002 }]]))))
      .rejects.toThrow('deny-only');
    const oldBuild = await db.deployment.create({ data: { projectId: fixture.project, status: 'BUILDING' } });
    vi.stubEnv('APP_PUBLIC_PRE_CUTOVER_BOOT_ID', undefined);
    try {
      await expect(assertPublicHostingStartup(env.hosting, db, route, inventory)).rejects.toThrow('Record APP_PUBLIC');
      vi.stubEnv('APP_PUBLIC_PRE_CUTOVER_BOOT_ID', fixture.otherUser);
      await expect(assertPublicHostingStartup(env.hosting, db, route, inventory, undefined, () => Promise.resolve(fixture.otherUser)))
        .rejects.toThrow('requires a host reboot');
      expect(await db.publicRoutingBinding.count()).toBe(0);
      expect(await db.deployment.findUniqueOrThrow({ where: { id: oldBuild.id } })).toMatchObject({ status: 'BUILDING' });
      await assertPublicHostingStartup(env.hosting, db, route, inventory, undefined, () => Promise.resolve(fixture.operator));
      expect(await db.publicRoutingBinding.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ cutoverBootId: fixture.operator });
      expect(await db.deployment.findUniqueOrThrow({ where: { id: oldBuild.id } })).toMatchObject({ status: 'FAILED' });
      await db.deployment.delete({ where: { id: oldBuild.id } });
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(assertPublicHostingStartup({ ...durable, publicHosting: { operatorId: fixture.operator } }, db, route))
      .rejects.toThrow('active public SHA');
    await expect(assertPublicHostingStartup({ ...durable, publicHosting: { ...correct, legacyProjectId: fixture.otherUser } }, db, route))
      .rejects.toThrow('recorded binding');
    await expect(assertPublicHostingStartup({ origin: 'http://localhost:8080', hostnameSuffix: 'localhost',
      adminSocketPath: undefined }, db, route)).rejects.toThrow('must stay enabled');
    expect(fixture.route).toBeNull();
  });

  it('rejects a competing project operation in a separate Node process', async () => {
    const { ProjectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    const lock = new ProjectOperationLockService({ database: db });
    const exec = promisify(execFile);
    const contender = `
      import { PrismaPg } from '@prisma/adapter-pg';
      import { PrismaClient } from './dist/generated/prisma/client.js';
      import { ProjectOperationLockService } from './dist/services/project-operation-lock.service.js';
      const connectionString = process.env.DEPLOYFLOW_PHASE1_TEST_DB;
      const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: process.env.PHASE1_TEST_SCHEMA }) });
      try {
        const lock = new ProjectOperationLockService({ database: db });
        await lock.runExclusive(process.env.PHASE1_TEST_PROJECT, () => Promise.resolve());
        console.log('acquired');
      } catch (error) {
        console.log(error.statusCode === 409 ? 'conflict' : 'failed');
      } finally {
        await db.$disconnect();
      }
    `;
    const runContender = async () => (await exec(process.execPath, ['--input-type=module', '-e', contender], {
      env: { ...process.env, PHASE1_TEST_SCHEMA: schema, PHASE1_TEST_PROJECT: fixture.project },
      timeout: 5000,
    })).stdout.trim();
    await lock.runExclusive(fixture.project, async () => {
      expect(await runContender()).toBe('conflict');
    });
    expect(await runContender()).toBe('acquired');
  }, 12_000);

  it('excludes an opposite backend mode while a separate process holds admission', async () => {
    const { acquireBackendMode } = await import('../src/services/backend-mode.service.js');
    const held = await acquireBackendMode(dbUrl ?? '', false);
    const exec = promisify(execFile);
    const worker = `
      import { acquireBackendMode } from './dist/services/backend-mode.service.js';
      try {
        const held = await acquireBackendMode(process.env.DEPLOYFLOW_PHASE1_TEST_DB, true);
        await held.end();
        console.log('acquired');
      } catch (error) {
        console.log(error.message.includes('incompatible') ? 'conflict' : 'failed');
      }
    `;
    const attempt = async () => (await exec(process.execPath, ['--input-type=module', '-e', worker], { timeout: 5000 })).stdout.trim();
    try {
      const secondPrivate = await acquireBackendMode(dbUrl ?? '', false);
      await secondPrivate.end();
      expect(await attempt()).toBe('conflict');
    } finally {
      await held.end();
    }
    expect(await attempt()).toBe('acquired');
  }, 12_000);

  it('restricts REST, Socket.IO and approval mutations to the operator and their projects', async () => {
    const addr = apiServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('Missing fixture listener');
    const socket = io('http://127.0.0.1:' + String(addr.port), {
      transports: ['websocket'], auth: { token: otherAuth.slice(7) }, autoConnect: false, reconnection: false,
    });
    try {
      const denied = new Promise<Error>((done) => socket.once('connect_error', done).connect());
      expect(await denied).toMatchObject({ message: 'Public hosting management requires the configured operator' });
    } finally {
      socket.close();
    }
    expect((await api.get('/api/projects').set('Authorization', otherAuth)).status).toBe(403);
    expect((await api.put(approvalUrl(fixture.project)).set('Authorization', otherAuth).send(approvalInput(nextCommit))).status)
      .toBe(403);
    expect((await api.delete(approvalUrl(fixture.project)).set('Authorization', otherAuth)).status).toBe(403);
    const otherProject = await db.project.create({
      data: { id: fixture.otherUser, userId: fixture.otherUser, name: 'Other account',
        hostnameLabel: 'app-' + fixture.otherUser.replaceAll('-', ''),
        repositoryUrl: fixture.repository, branch: 'main', containerPort: 8080,
      },
    });
    expect((await api.put(approvalUrl(otherProject.id)).set('Authorization', auth).send(approvalInput(nextCommit))).status)
      .toBe(404);
    expect((await api.post('/api/webhooks/github/' + fixture.project).send({})).status).toBe(404);
  });

  it('validates approval inputs and routes a pinned SHA independently of the legacy project', async () => {
    const { checkout, branchTip, start, build } = await mockWorkload();
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'New project', repositoryUrl: fixture.repository, containerPort: 8080 });
    expect(created.status).toBe(201);
    const { project: { id } } = created.body as { project: { id: string } };
    expect((await api.get(approvalUrl(id)).set('Authorization', auth)).body).toEqual({ approval: { status: 'UNAPPROVED' } });
    expect((await api.post(deployUrl(id)).set('Authorization', auth).send({ commitHash: nextCommit })).status).toBe(403);
    for (const invalid of [{ branch: 'bad..branch' }, { commitHash: 'b'.repeat(39) }, { repositoryUrl: 'https://example.net/a/b' }]) {
      expect((await api.put(approvalUrl(id)).set('Authorization', auth).send({ ...approvalInput(nextCommit), ...invalid })).status)
        .toBe(400);
    }
    expect((await api.put(approvalUrl(id)).set('Authorization', auth)
      .send({ ...approvalInput(nextCommit), branch: 'other' })).status).toBe(403);
    expect((await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit))).status).toBe(200);
    expect((await api.post(deployUrl(id)).set('Authorization', auth)).status).toBe(400);
    expect((await api.post(deployUrl(id)).set('Authorization', auth).send({ commitHash: extraCommit })).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    const deployment = await api.post(deployUrl(id)).set('Authorization', auth).send({ commitHash: nextCommit });
    expect(deployment.status).toBe(201);
    expect(deployment.body).toMatchObject({ deployment: { commitHash: nextCommit } });
    expect(checkout).toHaveBeenCalledExactlyOnceWith(approvalInput(nextCommit));
    expect(branchTip).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledOnce();
    expect(fixture.route).toBeNull();
    expect((await db.project.findUniqueOrThrow({ where: { id } })).activeDeploymentId).not.toBeNull();
  });

  it('does not commit a route when authorization fails inside the promotion transaction', async () => {
    await mockWorkload();
    const { PublicApplicationPolicy } = await import('../src/services/public-application-policy.js');
    const policy = new PublicApplicationPolicy();
    const assertApproved = policy.assertApproved.bind(policy);
    const approval = vi.spyOn(PublicApplicationPolicy.prototype, 'assertApproved')
      .mockImplementation((project, commit, transaction) => {
        if (transaction !== undefined) return Promise.reject(new AppError(503, 'Approval verification failed at commit'));
        return assertApproved(project, commit);
      });
    try {
      await api.post(deployUrl(fixture.project)).set('Authorization', auth).send({ commitHash: fixture.legacyCommit }).expect(502);
      expect(fixture.route).toBeNull();
      expect(await db.project.findUniqueOrThrow({ where: { id: fixture.project } }))
        .toMatchObject({ activeDeploymentId: fixture.deployment, routingOperation: null });
      expect(await db.deployment.count({ where: { projectId: fixture.project, status: 'FAILED' } })).toBe(1);
    } finally {
      approval.mockRestore();
    }
  });

  it('withdraws a mismatched target while leaving an unrelated project available', async () => {
    const { start } = await mockWorkload();
    const { env } = await import('../src/config/env.js');
    const { assertPublicHostingStartup } = await import('../src/services/public-hosting-safety.service.js');
    const other = await db.project.findFirstOrThrow({ where: { name: 'New project', userId: fixture.operator } });
    fixture.route = 51001;
    fixture.routeAddress = '127.64.0.9';
    await assertPublicHostingStartup(env.hosting, db,
      () => Promise.resolve(new Map([['app-' + fixture.project.replaceAll('-', '') + '.apps.example.net',
        { address: fixture.routeAddress, port: 51001 }]])),
      () => Promise.resolve([]));
    expect(await db.publicRoutingBinding.findUnique({ where: { id: 1 } }))
      .toMatchObject({ routeRecoveryRequired: true });
    await api.post(deployUrl(fixture.project)).set('Authorization', auth).send({ commitHash: fixture.legacyCommit }).expect(503);
    expect(start).not.toHaveBeenCalled();
    await api.post(deployUrl(other.id)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(201);
    await routes.reconcile();
    expect(await db.publicRoutingBinding.findUnique({ where: { id: 1 } }))
      .toMatchObject({ routeRecoveryRequired: false });
    expect(fixture.route).toBeNull();
  });

  it('keeps a failed startup pending until Docker confirms both tracked and unrecorded containers absent', async () => {
    await mockWorkload();
    const { ContainerService } = await import('../src/services/container.service.js');
    const { reconcilePendingPublicWithdrawals } = await import('../src/services/project-approval.service.js');
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'Orphan fixture', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id } } = created.body as { project: { id: string } };
    await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(200);
    const previous = await db.deployment.create({ data: { projectId: id, status: 'FAILED', commitHash: nextCommit } });
    const orphan = 'c'.repeat(64);
    const tracked = 'd'.repeat(64);
    const running = new Map([[orphan, previous.id]]);
    let available = true;
    const handle = (ref: string) => {
      const exact = [...running.entries()].find(([key, owner]) => ref === key || ref === 'deployflow-deployment-' + owner);
      const cid = exact?.[0] ?? ref;
      return {
        id: cid,
        inspect: () => {
          if (!available) return Promise.reject(new Error('Docker unavailable'));
          const owner = running.get(cid);
          return owner === undefined ? Promise.reject(Object.assign(new Error('Container not found'), { statusCode: 404 }))
            : Promise.resolve({ Id: cid, Config: { Labels: { 'deployflow.deployment-id': owner } } });
        },
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        restart: () => Promise.resolve(),
        logs: () => Promise.resolve(''),
        stats: () => Promise.resolve({}),
        remove: () => {
          if (!available) return Promise.reject(new Error('Docker unavailable'));
          running.delete(cid);
          return Promise.resolve();
        },
      };
    };
    const docker: DockerClient = {
      getContainer: handle,
      listContainers: ({ filters }) => {
        if (!available) return Promise.reject(new Error('Docker unavailable'));
        return Promise.resolve([...running].flatMap(([cid, owner]) =>
          filters?.label.includes('deployflow.deployment-id=' + owner) ? [{ Id: cid }] : []));
      },
      createContainer: (options) => {
        const owner = options.Labels['deployflow.deployment-id'];
        if (owner === undefined) throw new Error('Missing fixture owner');
        return Promise.resolve({
          ...handle(tracked),
          start: () => {
            running.set(tracked, owner);
            available = false;
            return Promise.resolve();
          },
        });
      },
    };
    const runtime = new ContainerService(docker);
    vi.spyOn(containers, 'startContainer').mockImplementation((...args) => runtime.startContainer(...args));
    vi.spyOn(containers, 'removeDeploymentContainers').mockImplementation((...args) => runtime.removeDeploymentContainers(...args));
    await api.post(deployUrl(id)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(422);
    expect(await db.deployment.findFirst({ where: { projectId: id, containerId: tracked } }))
      .toMatchObject({ status: 'FAILED', containerId: tracked });
    await api.delete(approvalUrl(id)).set('Authorization', auth).expect(202);
    expect(running.size).toBe(2);
    available = true;
    await reconcilePendingPublicWithdrawals();
    expect(running.size).toBe(0);
    const response = await api.get(approvalUrl(id)).set('Authorization', auth).expect(200);
    expect(response.body).toMatchObject({ approval: { status: 'REVOKED' } });
  });

  it('retains the project and failed deployment history until public-mode deletion verifies label-only cleanup', async () => {
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'Delete orphan fixture', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id } } = created.body as { project: { id: string } };
    const failed = await db.deployment.create({ data: { projectId: id, status: 'FAILED', commitHash: nextCommit } });
    const remove = vi.spyOn(containers, 'removeDeploymentContainers').mockRejectedValueOnce(new Error('Docker unavailable'))
      .mockImplementationOnce((_deploymentId, _containerId, beforeRemove) => beforeRemove());
    await api.delete('/api/projects/' + id).set('Authorization', auth).expect(502);
    expect(remove).toHaveBeenCalledWith(failed.id, null, expect.any(Function));
    expect(await db.deployment.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'FAILED', containerId: null });
    await api.delete('/api/projects/' + id).set('Authorization', auth).expect(204);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await db.project.findUnique({ where: { id } })).toBeNull();
  });

  it('refuses another routed workload when a live Caddy route has lost its Docker owner', async () => {
    await mockWorkload();
    const legacyContainer = 'a'.repeat(64);
    fixture.route = 51001;
    fixture.running.delete(legacyContainer);
    try {
      await api.post(deployUrl(fixture.project)).set('Authorization', auth).send({ commitHash: fixture.legacyCommit }).expect(503);
      expect(fixture.route).toBe(51001);
      expect([...fixture.running.values()]).not.toContain(51001);
    } finally {
      fixture.running.set(legacyContainer, 51001);
      fixture.route = null;
    }
  });

  it('serializes revocation against a pending deployment and blocks only the withdrawn project', async () => {
    const { build, checkout, cached, start, health, remove } = await mockWorkload();
    const { reconcilePendingPublicWithdrawals } = await import('../src/services/project-approval.service.js');
    const { env } = await import('../src/config/env.js');
    const { assertPublicHostingStartup } = await import('../src/services/public-hosting-safety.service.js');
    const durable = { ...env.hosting };
    delete durable.publicApp;
    const added = await api.put(approvalUrl(fixture.project)).set('Authorization', auth).send(approvalInput(nextCommit));
    expect(added.body).toMatchObject({ approval: { source: 'DATABASE', commits: [nextCommit, fixture.legacyCommit] } });
    await assertPublicHostingStartup(durable, db, () => Promise.resolve(new Map()), () => Promise.resolve([]));
    expect(fixture.route).toBeNull();
    await api.put(approvalUrl(fixture.project)).set('Authorization', auth).send(approvalInput(extraCommit)).expect(200);
    const cachedRollback = await api.post(actionUrl(fixture.deployment, 'rollback')).set('Authorization', auth).expect(201);
    expect(cached).toHaveBeenCalledWith(fixture.imageId);
    expect(checkout).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    const { deployment: { id: rolledBackId } } = cachedRollback.body as { deployment: { id: string } };
    expect(await db.deployment.findUniqueOrThrow({ where: { id: fixture.deployment } }))
      .toMatchObject({ status: 'STOPPED', containerId: null, hostPort: null });
    expect(await db.project.findUniqueOrThrow({ where: { id: fixture.project } })).toMatchObject({ routingOperation: null });
    expect(fixture.running.has('a'.repeat(64))).toBe(false);
    remove.mockClear();
    const pending = gate();
    const entered = gate();
    health.mockImplementationOnce(() => { entered.open(); return pending.wait; });
    const replacing = api.post(actionUrl(rolledBackId, 'redeploy')).set('Authorization', auth)
      .send({ commitHash: nextCommit }).then((response) => response);
    let replacement;
    try {
      await entered.wait;
      await api.delete(approvalUrl(fixture.project)).set('Authorization', auth).expect(409);
      await api.put(approvalUrl(fixture.project)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(409);
    } finally {
      pending.open();
      replacement = await replacing;
    }
    expect(replacement.status).toBe(201);
    const { deployment: { id: activeId } } = replacement.body as { deployment: { id: string } };
    const routedPort = fixture.route;
    expect(routedPort).not.toBeNull();
    const other = await db.project.findFirstOrThrow({ where: { name: 'New project', userId: fixture.operator } });

    fixture.adminUnavailable = true;
    try {
      await api.delete(approvalUrl(fixture.project)).set('Authorization', auth).expect(202);
      expect((await api.get(approvalUrl(fixture.project)).set('Authorization', auth)).body)
        .toMatchObject({ approval: { status: 'WITHDRAWAL_PENDING', withdrawnAt: null } });
      await api.put(approvalUrl(fixture.project)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(409);
      await api.post(actionUrl(activeId, 'stop')).set('Authorization', auth).expect(503);
      await api.delete('/api/projects/' + fixture.project).set('Authorization', auth).expect(503);
      await api.post(deployUrl(other.id)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(503);
      const { ApplicationRoutingError } = await import('../src/services/application-routing.service.js');
      await assertPublicHostingStartup(durable, db, () =>
        Promise.reject(new ApplicationRoutingError('unavailable', 'Fixture admin unavailable')), () => Promise.resolve([]));
      await reconcilePendingPublicWithdrawals();
      expect(fixture.route).toBe(routedPort);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      fixture.adminUnavailable = false;
    }
    await reconcilePendingPublicWithdrawals();
    const removed = remove.mock.calls.length;
    expect(removed).toBeGreaterThan(0);
    await api.delete(approvalUrl(fixture.project)).set('Authorization', auth).expect(200);
    expect(remove).toHaveBeenCalledTimes(removed);
    expect(fixture.route).toBeNull();
    const { approval: completed } = (await api.get(approvalUrl(fixture.project)).set('Authorization', auth)).body as
      { approval: { status: string; withdrawnAt: string | null } };
    expect(completed.status).toBe('REVOKED');
    expect(typeof completed.withdrawnAt).toBe('string');
    expect(await db.project.findUniqueOrThrow({ where: { id: fixture.project } }))
      .toMatchObject({ activeDeploymentId: null, routingOperation: null, routingDeploymentId: null });
    expect(await db.deployment.findUniqueOrThrow({ where: { id: fixture.deployment } }))
      .toMatchObject({ commitHash: fixture.legacyCommit, imageId: fixture.imageId, containerId: null });
    await routes.reconcile();
    expect(fixture.route).toBeNull();
    const starts = start.mock.calls.length;
    await api.post(deployUrl(fixture.project)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(403);
    for (const operation of ['restart', 'rollback', 'redeploy']) {
      await api.post(actionUrl(activeId, operation)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(403);
    }
    expect(start).toHaveBeenCalledTimes(starts);
    // A newly allocated workload may now reuse the port, with no stale proxy.
    if (routedPort === null) throw new Error('Missing fixture port');
    fixture.nextPort = routedPort - 1;
    const reused = await api.post(deployUrl(other.id)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(201);
    expect(reused.body).toMatchObject({ deployment: { hostPort: routedPort } });
    expect(fixture.route).toBeNull();
    const releases = await mkdtemp(join(tmpdir(), 'deployflow-rollback-'));
    try {
      const unit = await readFile('../infra/ubuntu/deployflow-backend.service', 'utf8');
      expect(unit).toContain('/usr/local/libexec/deployflow-backend-release.mjs run /opt/deployflow/current/backend');
      const backend = join(releases, 'backend');
      await mkdir(join(backend, 'dist', 'services'), { recursive: true });
      await mkdir(join(backend, 'dist', 'utils'));
      await writeFile(join(backend, 'dist', 'utils', 'linux-boot.js'), 'export {};');
      await mkdir(join(backend, 'node_modules'));
      const trust = join(releases, 'trusted-digests');
      const run = (action: string, policy?: string) =>
        spawnSync(process.execPath, ['scripts/release.mjs', action, backend, ...(policy === undefined ? [] : [policy])], { encoding: 'utf8' });
      const entrypoint = join(backend, 'dist', 'server.js');
      await writeFile(entrypoint, 'console.log("legacy entrypoint ran");');
      expect(run('run').status).toBe(1);
      for (const name of ['application-routing', 'backend-mode', 'project-approval', 'public-hosting-safety', 'public-ingress', 'build-network']) {
        await writeFile(join(backend, 'dist', 'services', name + '.service.js'), 'export {};');
      }
      await writeFile(join(backend, 'package.json'), '{"type":"module"}');
      await writeFile(join(backend, 'package-lock.json'), '{}');
      await writeFile(entrypoint, 'console.log("sealed entrypoint ran");');
      expect(run('seal').status).toBe(0);
      await writeFile(trust, run('digest').stdout);
      expect(run('run', trust).stdout.trim()).toBe('sealed entrypoint ran');
      await writeFile(entrypoint, 'console.log("legacy entrypoint ran");');
      const mixed = run('run');
      expect(mixed.status).toBe(1);
      expect(mixed.stdout).toBe('');
      expect(mixed.stderr).toContain('manifest does not match');
      expect(run('seal').status).toBe(0);
      expect(run('run', trust).stderr).toContain('digest has not been approved');
    } finally {
      await rm(releases, { recursive: true, force: true });
    }
    fixture.route = routedPort;
    await routes.reconcile();
    expect(fixture.route).toBeNull();
    await api.put(approvalUrl(fixture.project)).set('Authorization', auth).send(approvalInput(extraCommit)).expect(200);
    await routes.reconcile();
    expect(fixture.route).toBeNull();
    expect((await api.get(approvalUrl(fixture.project)).set('Authorization', auth)).body)
      .toMatchObject({ approval: { commits: [extraCommit] } });
  });

  it('fails closed when approval storage cannot be read', async () => {
    const { checkout } = await mockWorkload();
    const stored = vi.spyOn(db.projectPublicApproval, 'findUnique').mockRejectedValue(new Error('Database unavailable'));
    try {
      await api.post(deployUrl(fixture.project)).set('Authorization', auth).send({ commitHash: fixture.legacyCommit }).expect(503);
      expect(checkout).not.toHaveBeenCalled();
      expect(fixture.route).toBeNull();
    } finally {
      stored.mockRestore();
    }
  });

  it('keeps withdrawal pending after a build lease expires until engine completion is confirmed', async () => {
    await mockWorkload();
    const { BuildNetworkService, buildNetworkService } = await import('../src/services/build-network.service.js');
    const { ProjectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'Expired build', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id } } = created.body as { project: { id: string } };
    await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(200);
    const deployment = await db.deployment.create({ data: { projectId: id, status: 'BUILDING', commitHash: nextCommit } });
    const buildId = 'd'.repeat(64);
    let networkExists = true;
    const service = new BuildNetworkService({
      createNetwork: () => Promise.resolve({ id: buildId }),
      getNetwork: () => ({
        inspect: () => networkExists ? Promise.resolve({ Id: buildId, Name: 'deployflow-build-' + deployment.id,
          Labels: { 'deployflow.build-deployment-id': deployment.id }, Containers: {} })
          : Promise.reject(Object.assign(new Error('Not found'), { statusCode: 404 })),
        remove: () => { networkExists = false; return Promise.resolve(); },
      }),
      getContainer: () => { throw new Error('This fixture holds the build submission'); },
    }, db, () => Promise.resolve(fixture.otherUser));
    vi.spyOn(buildNetworkService, 'closeProject').mockImplementation((projectId) => service.closeProject(projectId));
    vi.spyOn(containers, 'removeDeploymentContainers').mockResolvedValue();
    const submitted = gate();
    const finish = gate();
    const old = new ProjectOperationLockService({ database: db });
    const worker = old.runExclusive(id, async (lease) => {
      if (lease === undefined) throw new Error('Missing worker lease');
      return service.run(id, deployment.id, lease, async (networkId, confirmTerminal, markSubmitted) => {
        expect(networkId).toBe(buildId);
        markSubmitted();
        submitted.open();
        await finish.wait;
        expect(networkExists).toBe(false);
        await confirmTerminal();
      });
    });
    try {
      await submitted.wait;
      await db.project.update({ where: { id }, data: { operationLockExpiresAt: new Date(0) } });
      const pending = await api.delete(approvalUrl(id)).set('Authorization', auth).expect(202);
      expect(pending.body).toMatchObject({ approval: { status: 'WITHDRAWAL_PENDING' } });
      expect(networkExists).toBe(false);
      expect(await db.deployment.findUnique({ where: { id: deployment.id } })).toMatchObject({ buildNetworkId: buildId });
      const unrelated = await db.project.findFirstOrThrow({ where: { name: 'New project' } });
      await api.post(deployUrl(unrelated.id)).set('Authorization', auth).send({ commitHash: nextCommit }).expect(201);
    } finally { finish.open(); await worker; }
    const complete = await api.delete(approvalUrl(id)).set('Authorization', auth).expect(200);
    expect(complete.body).toMatchObject({ approval: { status: 'REVOKED' } });
  });

  it('clears a build rejected before submission and requires a new boot for an ambiguous submission', async () => {
    const { BuildNetworkService } = await import('../src/services/build-network.service.js');
    const { ProjectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    const project = await db.project.findFirstOrThrow({ where: { name: 'New project' } });
    const buildId = 'c'.repeat(64);
    let networkExists = false;
    let currentDeploymentId = '';
    let bootId = fixture.operator;
    const service = new BuildNetworkService({
      createNetwork: () => { networkExists = true; return Promise.resolve({ id: buildId }); },
      getNetwork: () => ({
        inspect: () => networkExists ? Promise.resolve({ Id: buildId, Name: 'deployflow-build-' + currentDeploymentId,
          Labels: { 'deployflow.build-deployment-id': currentDeploymentId }, Containers: {} })
          : Promise.reject(Object.assign(new Error('Not found'), { statusCode: 404 })),
        remove: () => { networkExists = false; return Promise.resolve(); },
      }),
      getContainer: () => { throw new Error('There are no attached containers'); },
    }, db, () => Promise.resolve(bootId));
    const lock = new ProjectOperationLockService({ database: db });
    const submit = async (dispatched: boolean) => {
      const deployment = await db.deployment.create({ data: { projectId: project.id, status: 'BUILDING' } });
      currentDeploymentId = deployment.id;
      return lock.runExclusive(project.id, (lease) => {
        if (lease === undefined) throw new Error('Missing fixture lease');
        return service.run(project.id, deployment.id, lease, (_network, _confirm, markSubmitted) => {
          if (dispatched) markSubmitted();
          return Promise.reject(new Error(dispatched ? 'Transport disconnected' : 'Builder busy'));
        });
      });
    };
    await expect(submit(false)).rejects.toThrow('Builder busy');
    expect(await db.deployment.findUnique({ where: { id: currentDeploymentId } })).toMatchObject({ buildNetworkId: null });
    await expect(submit(true)).rejects.toThrow('execution is still unconfirmed');
    await expect(service.closeProject(project.id)).rejects.toThrow('execution is still unconfirmed');
    bootId = fixture.otherUser;
    await service.closeProject(project.id);
    expect(await db.deployment.findUnique({ where: { id: currentDeploymentId } })).toMatchObject({ buildNetworkId: null });
  });

  it('denies a retired or lease-expired public target even when its port is unchanged', async () => {
    const { authorizePublicIngress } = await import('../src/services/public-ingress.service.js');
    const { workloadAddress, RESERVED_WORKLOAD_PORT } = await import('../src/utils/workload-address.js');
    const { env } = await import('../src/config/env.js');
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'Dedicated address', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id, hostnameLabel } } = created.body as { project: { id: string; hostnameLabel: string } };
    const host = hostnameLabel + '.' + env.hosting.hostnameSuffix;
    const hosting = { ...env.hosting, publicHosting: { operatorId: fixture.operator, legacyProjectId: id } };
    await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(200);
    const row = (index: number) => db.deployment.create({ data: {
      projectId: id, status: 'RUNNING', commitHash: nextCommit, hostPort: RESERVED_WORKLOAD_PORT,
      publicAddressIndex: index, containerId: 'a'.repeat(64),
    } });
    const older = await row(4_000_001);
    await db.deployment.update({ where: { id: older.id }, data: { status: 'HEALTHCHECKING' } });
    const newer = await row(4_000_002);
    const permit = (index: number) => authorizePublicIngress(host, workloadAddress(index) + ':' + String(RESERVED_WORKLOAD_PORT), hosting, db);
    await db.project.update({ where: { id }, data: { activeDeploymentId: newer.id, routingOperation: 'PROMOTE',
      routingDeploymentId: older.id, operationLockToken: fixture.otherUser, operationLockExpiresAt: new Date(0) } });
    await expect(permit(older.publicAddressIndex ?? 0)).resolves.toBe(false);
    await expect(permit(newer.publicAddressIndex ?? 0)).resolves.toBe(true);
    await db.project.update({ where: { id }, data: { operationLockExpiresAt: new Date(Date.now() + 50_000) } });
    await expect(permit(older.publicAddressIndex ?? 0)).resolves.toBe(true);
  });

  it('returns the DELETE result even if reapproval wins immediately after the lease releases', async () => {
    await mockWorkload();
    const { approveProjectRevision } = await import('../src/services/project-approval.service.js');
    const { projectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'DELETE snapshot', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id } } = created.body as { project: { id: string } };
    await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(200);
    const run = projectOperationLockService.runExclusive.bind(projectOperationLockService);
    const boundary = vi.spyOn(projectOperationLockService, 'runExclusive').mockImplementationOnce(async (projectId, action) => {
      const result = await run(projectId, action);
      await approveProjectRevision(fixture.operator, id, approvalInput(extraCommit));
      return result;
    });
    try {
      const revoked = await api.delete(approvalUrl(id)).set('Authorization', auth).expect(200);
      expect(revoked.body).toMatchObject({ approval: { status: 'REVOKED' } });
      const current = await api.get(approvalUrl(id)).set('Authorization', auth).expect(200);
      expect(current.body).toMatchObject({ approval: { status: 'APPROVED', commits: [extraCommit] } });
    } finally {
      boundary.mockRestore();
    }
  });

  it('returns the PUT result even if revocation wins immediately after the lease releases', async () => {
    const { revokeProjectApproval } = await import('../src/services/project-approval.service.js');
    const { projectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    const created = await api.post('/api/projects').set('Authorization', auth)
      .send({ name: 'Approval snapshot', repositoryUrl: fixture.repository, containerPort: 8080 }).expect(201);
    const { project: { id } } = created.body as { project: { id: string } };
    const run = projectOperationLockService.runExclusive.bind(projectOperationLockService);
    vi.spyOn(projectOperationLockService, 'runExclusive').mockImplementationOnce(async (projectId, action) => {
      const result = await run(projectId, action);
      await revokeProjectApproval(fixture.operator, id);
      return result;
    });
    const approved = await api.put(approvalUrl(id)).set('Authorization', auth).send(approvalInput(nextCommit)).expect(200);
    expect(approved.body).toMatchObject({ approval: { status: 'APPROVED', commits: [nextCommit] } });
    const revoked = await api.get(approvalUrl(id)).set('Authorization', auth).expect(200);
    expect(revoked.body).toMatchObject({ approval: { status: 'REVOKED' } });
  });
});
