import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';

import { io } from 'socket.io-client';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const exec = promisify(execFile);
const projectId = '11111111-1111-4111-8111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';
const label = 'app-11111111111141118111111111111111';
const suffix = 'apps.example.net';
const host = label + '.' + suffix;
const repositoryUrl = 'https://github.com/example/app';
const otherRepositoryUrl = 'https://github.com/example/another-app';

async function fixtureRepository(directory: string, revisions: string[]) {
  await exec('git', ['init', '-b', 'main', directory]);
  const git = (...args: string[]) => exec('git', ['-C', directory, ...args]);
  const commits = [];
  for (const revision of revisions) {
    await writeFile(join(directory, 'Dockerfile'), [
      'FROM busybox:1.37.0-glibc',
      'RUN mkdir /www',
      ...(revision === 'bad' ? [] : [`RUN printf '${revision}' > /www/index.html`]),
      'CMD ' + JSON.stringify(['sh', '-c', "trap 'sleep 6; exit 0' TERM; httpd -f -p 8080 -h /www & " +
        'while [ ! -f /tmp/deployflow-stop-fixture ]; do sleep 1; done; exit 1']),
      '',
    ].join('\n'));
    await git('add', 'Dockerfile');
    await git('-c', 'user.name=DeployFlow Fixture', '-c', 'user.email=fixture@example.net', 'commit', '-m', revision);
    commits.push((await git('rev-parse', 'HEAD')).stdout.trim());
  }
  return commits;
}

function https(path: string, servername = host, ca?: string, hostHeader = servername) {
  return new Promise<{ status: number; body: string; cors: string | undefined; san: string | undefined }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: 443, servername, ca, path, agent: false,
      headers: { Host: hostHeader, Origin: 'http://127.0.0.1:3000' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (part: string) => { body += part; });
      const san = req.socket instanceof TLSSocket ? req.socket.getPeerCertificate().subjectaltname : undefined;
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body, cors: res.headers['access-control-allow-origin'], san }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3500, () => req.destroy(new Error('HTTPS fixture timeout')));
    req.end();
  });
}

async function expectDenied(hostname: string, ca: string) {
  const status = await https('/', hostname, ca).then((res) => res.status, (error: unknown) => {
    expect(error instanceof Error && 'code' in error && String(error.code)).toMatch(/^(?:EPROTO$|ERR_SSL_)/);
    return 404;
  });
  expect(status).toBe(404);
}

function http(hostname: string) {
  return new Promise<{ status: number | undefined; location: string | undefined }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: 18085, headers: { Host: hostname } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('HTTP fixture timeout')));
    req.end();
  });
}

describe.skipIf(process.platform !== 'linux' || process.env.DEPLOYFLOW_PHASE5B_SMOKE !== '1')('Linux HTTPS hosting', () => {
  it('serves two exact HTTPS hosts through real Docker, Caddy, PostgreSQL and Git', async () => {
    const databaseUrl = new URL(process.env.DEPLOYFLOW_PHASE5B_DB ?? '');
    expect(databaseUrl.hostname).toBe('127.0.0.1');
    expect(databaseUrl.port).toBe('55437');
    expect(databaseUrl.pathname).toBe('/deployflow_phase5b');
    const certificate = process.env.NODE_EXTRA_CA_CERTS ?? '';
    const ca = await readFile(certificate, 'utf8');
    const key = join(certificate, '..', 'server.key');
    const folder = await mkdtemp(join(tmpdir(), 'df5-'));
    const repo = join(folder, 'app-one');
    const otherRepo = join(folder, 'app-two');
    const [commit1, commit2, failingCommit] = await fixtureRepository(repo, ['v1', 'v2', 'bad']);
    const [otherCommit] = await fixtureRepository(otherRepo, ['application-two']);
    if (!commit1 || !commit2 || !failingCommit || !otherCommit) throw new Error('Missing fixture Git revision');
    // Redirect the two HTTPS Git URLs to disposable local repositories. Git still fetches and verifies the exact SHA.
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'url.file://' + repo + '.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', repositoryUrl);
    vi.stubEnv('GIT_CONFIG_KEY_1', 'url.file://' + otherRepo + '.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_1', otherRepositoryUrl);
    const adminSocket = join(folder, 'admin.sock');
    const config = join(folder, 'caddy.json');
    const bootstrap = JSON.parse(await readFile('../infra/caddy/public.json', 'utf8')) as {
      admin: { listen: string };
      apps: { tls: unknown; pki: unknown; http: { http_port?: number; servers: {
        deployflow: { listen: string[] }; redirect: { listen: string[] };
      } } };
    };
    bootstrap.admin.listen = 'unix/' + adminSocket + '|0660';
    bootstrap.apps.pki = { certificate_authorities: { local: {
      install_trust: false, intermediate_lifetime: '24h', root: { certificate, private_key: key, format: 'pem_file' },
    } } };
    bootstrap.apps.tls = { automation: { policies: [{ issuers: [{ module: 'internal' }] }] } };
    bootstrap.apps.http.servers.deployflow.listen = ['127.0.0.1:443'];
    bootstrap.apps.http.http_port = 18085;
    bootstrap.apps.http.servers.redirect.listen = ['127.0.0.1:18085'];
    await writeFile(config, JSON.stringify(bootstrap));
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.CADDY_ADMIN_SOCKET = adminSocket;
    process.env.APP_HOSTING_ORIGIN = 'https://' + suffix;
    process.env.APP_HOSTNAME_SUFFIX = suffix;
    process.env.APP_PUBLIC_PROJECT_ID = projectId;
    process.env.APP_PUBLIC_OPERATOR_ID = operatorId;
    process.env.APP_PUBLIC_INGRESS_SOCKET = join(folder, 'ingress.sock');
    process.env.APP_PUBLIC_REPOSITORY_URL = repositoryUrl;
    process.env.APP_PUBLIC_BRANCH = 'main';
    process.env.APP_PUBLIC_COMMITS = [commit1, commit2, failingCommit].join(',');
    process.env.REGISTRATION_ENABLED = 'false';
    delete process.env.GITHUB_WEBHOOK_SECRET_KEY;

    const { createApp } = await import('../src/app.js');
    const { database } = await import('../src/config/database.js');
    const { attachDeploymentSocket } = await import('../src/realtime/deployment-socket.js');
    const { createAccessToken } = await import('../src/services/token.service.js');
    const { PublicHostingReadinessError, PublicHostingReadinessService } = await import('../src/services/public-hosting-readiness.service.js');
    const { applicationHealthCheckService, ApplicationHealthCheckService } = await import('../src/services/application-health-check.service.js');
    const { createCaddyAdminTransport } = await import('../src/services/caddy-admin-transport.js');
    const { deploymentRoutingService } = await import('../src/services/deployment-routing.service.js');
    const { reconcilePendingPublicWithdrawals } = await import('../src/services/project-approval.service.js');
    const { assertPublicHostingStartup } = await import('../src/services/public-hosting-safety.service.js');
    const { startPublicIngress } = await import('../src/services/public-ingress.service.js');
    const { readLinuxBootId } = await import('../src/utils/linux-boot.js');
    const { containerService, ContainerLifecyclePendingError } = await import('../src/services/container.service.js');
    const { createServer } = await import('node:http');
    const admin = createCaddyAdminTransport(adminSocket);
    const server = createServer(createApp());
    const sockets = attachDeploymentSocket(server);
    const user = await database.user.create({ data: { id: operatorId, email: 'linux-fixture@example.net', passwordHash: 'unused' } });
    const auth = 'Bearer ' + await createAccessToken(user.id);
    let child: ReturnType<typeof spawn> | undefined;
    let ingress: Awaited<ReturnType<typeof startPublicIngress>>;
    let legacyContainerId: string | undefined;
    const legacyDeploymentId = randomUUID();
    let caddyLogs = '';
    const startCaddy = async () => {
      child = spawn('caddy', ['run', '--config', config], {
        env: { ...process.env, XDG_DATA_HOME: folder }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (data: Buffer) => { caddyLogs = (caddyLogs + data.toString()).slice(-8000); });
      await vi.waitFor(async () => { expect((await admin({ method: 'GET' })).status).toBe(200); }, { timeout: 6000 });
    };
    const stopCaddy = async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    };
    let step = 'initial setup';
    const fastHealth = new ApplicationHealthCheckService({ maxAttempts: 4, retryDelayMs: 200 });
    vi.spyOn(applicationHealthCheckService, 'waitUntilHealthy').mockImplementation((input) => fastHealth.waitUntilHealthy(input));
    const dns = vi.spyOn(PublicHostingReadinessService.prototype, 'verifyDns').mockResolvedValue();

    try {
      await database.project.create({
        data: { id: projectId, hostnameLabel: label, name: 'Fixture', repositoryUrl, branch: 'main', containerPort: 8080, userId: user.id },
      });
      await startCaddy();
      const bootId = await readLinuxBootId();
      vi.stubEnv('APP_PUBLIC_PRE_CUTOVER_BOOT_ID', bootId);
      await expect(assertPublicHostingStartup()).rejects.toThrow('requires a host reboot');
      // CI can exercise admission with a fixture boot ID. A disposable reboot rehearsal supplies the real prior ID.
      vi.stubEnv('APP_PUBLIC_PRE_CUTOVER_BOOT_ID', process.env.DEPLOYFLOW_TEST_PREVIOUS_BOOT_ID ?? randomUUID());
      const unrestricted = (await exec('docker', ['run', '-d', '--pull', 'never', 'busybox:1.37.0-glibc', 'sleep', '60'])).stdout.trim();
      try {
        await expect(assertPublicHostingStartup()).rejects.toThrow('Linux workload limits');
      } finally {
        await exec('docker', ['rm', '-f', unrestricted]);
      }
      legacyContainerId = (await exec('docker', ['run', '-d', '--pull', 'never', '--restart', 'unless-stopped',
        '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
        '--security-opt', 'no-new-privileges:true', '--label', 'deployflow.deployment-id=' + legacyDeploymentId,
        '-p', '127.0.0.1::8080', 'busybox:1.37.0-glibc', 'sh', '-c',
        'mkdir /www; echo legacy > /www/index.html; exec httpd -f -p 8080 -h /www'])).stdout.trim();
      const { stdout: legacyAddress } = await exec('docker', ['port', legacyContainerId, '8080/tcp']);
      const legacyPort = Number(legacyAddress.trim().split(':').at(-1));
      expect(legacyPort).toBeGreaterThan(0);
      await database.deployment.create({ data: { id: legacyDeploymentId, projectId, status: 'RUNNING',
        containerId: legacyContainerId, hostPort: legacyPort, commitHash: commit1 } });
      await database.project.update({ where: { id: projectId }, data: { activeDeploymentId: legacyDeploymentId } });
      await assertPublicHostingStartup();
      expect(await database.publicRoutingBinding.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ cutoverBootId: bootId });
      ingress = await startPublicIngress();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('Missing fixture API address');
      const api = supertest(server);
      const action = (id: string, operation: string) => {
        const request = api.post('/api/deployments/' + id + '/' + operation).set('Authorization', auth);
        return operation === 'redeploy' ? request.send({ commitHash: commit2 }) : request;
      };
      const status = () => api.get('/api/projects/' + projectId).set('Authorization', auth);
      const active = async () => {
        const { activeDeploymentId } = await database.project.findUniqueOrThrow({ where: { id: projectId } });
        if (activeDeploymentId === null) throw new Error('Fixture has no active deployment');
        return activeDeploymentId;
      };
      await expectDenied(host, ca);
      const otherProject = await api.post('/api/projects').set('Authorization', auth)
        .send({ name: 'Other', repositoryUrl: otherRepositoryUrl, containerPort: 8080 }).expect(201);
      const { project: { id: otherId, publicHostname: otherHost } } = otherProject.body as {
        project: { id: string; publicHostname: string };
      };
      expect(otherHost).toBe('app-' + otherId.replaceAll('-', '') + '.' + suffix);
      await api.post('/api/projects/' + otherId + '/deploy').set('Authorization', auth).send({ commitHash: otherCommit }).expect(403);
      await expectDenied(otherHost, ca);
      const first = await api.post('/api/projects/' + projectId + '/deploy').set('Authorization', auth).send({ commitHash: commit1 });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const firstId = await active();
      expect(await https('/', host, ca)).toMatchObject({ status: 200, body: 'v1', san: 'DNS:' + host });
      expect(first.body).toMatchObject({ deployment: { status: 'RUNNING', commitHash: commit1 },
        hosting: { publicHostname: host, publicApplicationUrl: 'https://' + host, hostingStatus: 'AVAILABLE', certificateStatus: 'READY' } });
      await expect(exec('docker', ['inspect', legacyContainerId])).rejects.toThrow();
      expect(await database.deployment.findUniqueOrThrow({ where: { id: legacyDeploymentId } }))
        .toMatchObject({ status: 'STOPPED', containerId: null, hostPort: null });
      expect(await database.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ routingOperation: null });
      expect((await https('/', host, ca, 'unknown.example.net')).status).toBe(421);
      await expect(https('/', 'other.apps.example.net', ca)).rejects.toThrow();
      const summary = (await status()).body as { project: { publicProbePath: string } };
      expect(summary.project).toMatchObject({
        publicApplicationUrl: 'https://' + host, hostingStatus: 'AVAILABLE',
      });
      const firstProbe = summary.project.publicProbePath;
      expect(await https(firstProbe, host, ca)).toMatchObject({ status: 204, body: '', cors: 'http://127.0.0.1:3000' });
      expect((await https(firstProbe + 'wrong', host, ca)).status).toBe(404);
      await api.put('/api/projects/' + otherId + '/public-approval').set('Authorization', auth)
        .send({ repositoryUrl: otherRepositoryUrl, branch: 'main', commitHash: otherCommit }).expect(200);
      const other = await api.post('/api/projects/' + otherId + '/deploy').set('Authorization', auth)
        .send({ commitHash: otherCommit });
      expect(other.status, JSON.stringify(other.body)).toBe(201);
      const { deployment: unrelated } = other.body as { deployment: { id: string; containerId: string } };
      const expectOtherServed = async () => {
        expect(await https('/', otherHost, ca)).toMatchObject({ status: 200, body: 'application-two', san: 'DNS:' + otherHost });
      };
      const monitorOther = async <T>(operation: PromiseLike<T>): Promise<T> => {
        const stop = new AbortController();
        const monitor = (async () => {
          while (!stop.signal.aborted) {
            await expectOtherServed();
            await sleep(150);
          }
        })().then(() => undefined, (error: unknown) => ({ error }));
        const result = await Promise.resolve(operation).finally(() => { stop.abort(); });
        const failure = await monitor;
        if (failure !== undefined) throw failure.error;
        return result;
      };
      await expectOtherServed();
      expect((await https('/', host, ca)).body).toBe('v1');
      expect((await https('/api/health', host, ca)).status).toBe(404);
      expect((await https('/api/projects', otherHost, ca)).status).toBe(404);
      expect((await https('/config/', otherHost, ca)).status).toBe(404);

      step = 'stalled authorization';
      if (ingress === undefined) throw new Error('Missing fixture ingress');
      const closeIngress = new Promise<void>((resolve) => { ingress?.close(() => { resolve(); }); });
      ingress.closeAllConnections();
      await closeIngress;
      const stalled = createServer(() => undefined);
      stalled.listen(join(folder, 'ingress.sock'));
      await once(stalled, 'listening');
      try {
        const began = performance.now();
        expect((await https('/', host, ca)).status).toBe(504);
        expect(performance.now() - began).toBeLessThan(3_000);
      } finally {
        const closed = new Promise<void>((resolve) => { stalled.close(() => { resolve(); }); });
        stalled.closeAllConnections();
        await closed;
        ingress = await startPublicIngress();
      }
      expect(await http(host)).toEqual({ status: 308, location: 'https://' + host + '/' });
      expect(await http(otherHost)).toEqual({ status: 308, location: 'https://' + otherHost + '/' });
      expect((await http('unknown.' + suffix)).status).toBe(404);

      step = 'Socket.IO subscription';
      const socket = io('http://127.0.0.1:' + String(address.port), {
        transports: ['websocket'], auth: { token: auth.slice(7) }, autoConnect: false, reconnection: false, timeout: 5000,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve).once('connect_error', reject).connect();
        });
        expect(await socket.timeout(2000).emitWithAck('deployment:subscribe', { deploymentId: firstId }))
          .toMatchObject({ ok: true });
      } finally {
        socket.close();
      }

      step = 'failed candidate';
      await api.post('/api/deployments/' + firstId + '/redeploy').set('Authorization', auth)
        .send({ commitHash: failingCommit }).expect(422);
      expect(await active()).toBe(firstId);
      expect((await https('/', host, ca)).body).toBe('v1');
      await expectOtherServed();
      dns.mockRejectedValueOnce(new PublicHostingReadinessError('DNS'));
      const dnsFailure = await action(firstId, 'redeploy').expect(502);
      expect(dnsFailure.body).toMatchObject({ error: { code: 'DNS' } });
      expect(await active()).toBe(firstId);
      expect((await https('/', host, ca)).body).toBe('v1');
      step = 'redeploy';
      const redeploy = await monitorOther(action(firstId, 'redeploy'));
      expect(redeploy.status, JSON.stringify(redeploy.body)).toBe(201);
      const secondId = await active();
      expect((await https('/', host, ca)).body).toBe('v2');
      await expectOtherServed();
      expect((await https(firstProbe, host, ca)).status).toBe(404);
      const currentProbe = ((await status()).body as { project: { publicProbePath: string } }).project.publicProbePath;
      expect(currentProbe).not.toBe(firstProbe);
      expect((await https(currentProbe, host, ca)).status).toBe(204);
      step = 'rollback';
      expect((await action(firstId, 'rollback')).status).toBe(201);
      const rollbackId = await active();
      expect((await https('/', host, ca)).body).toBe('v1');
      expect((await database.deployment.findUniqueOrThrow({ where: { id: secondId } })).status).toBe('STOPPED');
      step = 'stop, restart and Caddy recovery';
      const stop = containerService.stopContainer.bind(containerService);
      vi.spyOn(containerService, 'stopContainer').mockImplementationOnce(async (...args) => {
        await stop(...args);
        throw new ContainerLifecyclePendingError();
      });
      expect((await monitorOther(action(rollbackId, 'stop'))).status).toBe(503);
      expect(await database.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ routingOperation: 'STOP' });
      await deploymentRoutingService?.reconcile();
      await expectDenied(host, ca);
      await expectOtherServed();
      const restart = containerService.restartContainer.bind(containerService);
      vi.spyOn(containerService, 'restartContainer').mockImplementationOnce(async (...args) => {
        await restart(...args);
        throw new ContainerLifecyclePendingError();
      });
      expect((await action(rollbackId, 'restart')).status).toBe(503);
      expect(await database.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ routingOperation: 'RESTART' });
      await deploymentRoutingService?.reconcile();
      expect((await https('/', host, ca)).body).toBe('v1');
      await expectOtherServed();
      await stopCaddy();
      await startCaddy();
      await deploymentRoutingService?.reconcile();
      await vi.waitFor(async () => { expect((await https('/', host, ca)).body).toBe('v1'); });
      await expectOtherServed();
      const { containerId } = await database.deployment.findUniqueOrThrow({ where: { id: rollbackId } });
      if (containerId === null) throw new Error('Fixture has no active container');
      const { stdout } = await exec('docker', ['inspect', '--format', '{{json .HostConfig}}', containerId]);
      expect(JSON.parse(stdout)).toMatchObject({
        Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, PidsLimit: 128, Privileged: false, Binds: null,
        RestartPolicy: { Name: 'unless-stopped' }, SecurityOpt: ['no-new-privileges:true'],
      });

      step = 'stop a real crash-looping deployment';
      await exec('docker', ['exec', containerId, 'touch', '/tmp/deployflow-stop-fixture']);
      await vi.waitFor(async () => {
        expect(await containerService.inspectStatus(containerId)).toMatchObject({ status: 'restarting' });
      }, { timeout: 10_000 });

      const interruptedStop = vi.spyOn(containerService, 'stopContainer').mockClear()
        .mockRejectedValueOnce(new ContainerLifecyclePendingError());
      await action(rollbackId, 'stop').expect(503);
      expect(interruptedStop).toHaveBeenCalledExactlyOnceWith(containerId);
      await expectDenied(host, ca);
      await expectOtherServed();
      expect(await database.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ routingOperation: 'STOP' });
      await deploymentRoutingService?.reconcile();
      expect(await containerService.inspectStatus(containerId)).toMatchObject({ status: 'exited', running: false });
      expect(await database.project.findUniqueOrThrow({ where: { id: projectId } }))
        .toMatchObject({ activeDeploymentId: null, routingOperation: null, routingDeploymentId: null });
      expect(await database.deployment.findUniqueOrThrow({ where: { id: rollbackId } })).toMatchObject({ status: 'STOPPED' });
      await expectDenied(host, ca);

      const next = await api.post('/api/projects/' + projectId + '/deploy').set('Authorization', auth)
        .send({ commitHash: commit2 }).expect(201);
      const { deployment: replacement } = next.body as { deployment: { id: string; containerId: string } };
      expect(await active()).toBe(replacement.id);
      expect((await https('/', host, ca)).body).toBe('v2');
      expect(await containerService.inspectStatus(unrelated.containerId)).toMatchObject({ status: 'running', running: true });
      expect(await database.deployment.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({ status: 'RUNNING' });

      step = 'legacy revocation';
      const revoke = () => api.delete('/api/projects/' + projectId + '/public-approval').set('Authorization', auth);
      const hiddenAdmin = adminSocket + '.hidden';
      await rename(adminSocket, hiddenAdmin);
      try {
        const pending = await revoke().expect(202);
        expect(pending.body).toMatchObject({ approval: { status: 'WITHDRAWAL_PENDING' } });
        expect((await https('/', host, ca)).status).toBe(404);
        expect((await action(replacement.id, 'stop')).status).toBe(503);
      } finally {
        await rename(hiddenAdmin, adminSocket);
      }
      await reconcilePendingPublicWithdrawals();
      const complete = await revoke().expect(200);
      expect(complete.body).toMatchObject({ approval: { status: 'REVOKED' } });
      await expect(exec('docker', ['inspect', replacement.containerId])).rejects.toThrow();
      await expectDenied(host, ca);
      await deploymentRoutingService?.reconcile();
      await expectDenied(host, ca);
      await expectOtherServed();
      expect((await action(replacement.id, 'restart')).status).toBe(403);

      step = 'managed backend restart';
      const closedForRestart = new Promise<void>((resolve) => { ingress?.close(() => { resolve(); }); });
      ingress?.closeAllConnections();
      await closedForRestart;
      ingress = undefined;
      let backendLogs = '';
      const backendEnv: NodeJS.ProcessEnv = { ...process.env, PORT: '18087', BIND_HOST: '127.0.0.1', APP_PUBLIC_HOSTING_ENABLED: 'true' };
      delete backendEnv.APP_PUBLIC_PROJECT_ID;
      delete backendEnv.APP_PUBLIC_REPOSITORY_URL;
      delete backendEnv.APP_PUBLIC_BRANCH;
      delete backendEnv.APP_PUBLIC_COMMITS;
      for (const attempt of [1, 2]) {
        step = 'managed backend restart ' + String(attempt);
        await stopCaddy();
        await startCaddy();
        await expectDenied(otherHost, ca);
        const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
          env: backendEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        backend.stdout.resume();
        backend.stderr.on('data', (data: Buffer) => { backendLogs = (backendLogs + data.toString()).slice(-8000); });
        try {
          await vi.waitFor(async () => {
            expect((await fetch('http://127.0.0.1:18087/api/health', { signal: AbortSignal.timeout(1000) })).status).toBe(200);
            await expectOtherServed();
          }, { timeout: 15_000 });
          await expectDenied(host, ca);
        } catch (error) {
          console.error(backendLogs);
          throw error;
        } finally {
          if (backend.exitCode === null && backend.signalCode === null) {
            const exited = once(backend, 'exit');
            backend.kill('SIGTERM');
            await exited;
          }
        }
      }
    } catch (error) {
      console.error('Linux hosting fixture failed during ' + step + '\n' + caddyLogs);
      throw error;
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await sockets.close();
      ingress?.closeAllConnections();
      if (ingress !== undefined) await new Promise<void>((resolve) => { ingress?.close(() => { resolve(); }); });
      await stopCaddy();
      if (legacyContainerId !== undefined) await exec('docker', ['rm', '-f', legacyContainerId]).catch(() => undefined);
      const rows = await database.deployment.findMany({ where: { project: { userId: user.id } } });
      for (const row of rows) {
        if (row.containerId !== null) await exec('docker', ['rm', '-f', row.containerId]).catch(() => undefined);
      }
      for (const tag of new Set(rows.flatMap((row) => row.imageTag === null ? [] : [row.imageTag]))) {
        await exec('docker', ['image', 'rm', tag]).catch(() => undefined);
      }
      await database.project.updateMany({ where: { userId: user.id },
        data: { activeDeploymentId: null, routingDeploymentId: null, routingOperation: null } });
      await database.publicRoutingBinding.deleteMany({ where: { id: 1, projectId } });
      await database.projectPublicApproval.deleteMany({ where: { project: { userId: user.id } } });
      await database.user.delete({ where: { id: user.id } });
      await database.$disconnect();
      await rm(folder, { recursive: true, force: true });
    }
  }, 360_000);
});
