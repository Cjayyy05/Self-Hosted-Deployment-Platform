import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { io } from 'socket.io-client';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const exec = promisify(execFile);
const projectId = '11111111-1111-4111-8111-111111111111';
const label = 'app-11111111111141118111111111111111';
const suffix = 'apps.example.net';
const host = label + '.' + suffix;
const repositoryUrl = 'https://github.com/example/app';
const commit1 = '1'.repeat(40);
const commit2 = '2'.repeat(40);

function https(path: string, servername = host, ca?: string, hostHeader = servername) {
  return new Promise<{ status: number; body: string; cors: string | undefined }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: 443, servername, ca, path, agent: false,
      headers: { Host: hostHeader, Origin: 'http://127.0.0.1:3000' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (part: string) => { body += part; });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body, cors: res.headers['access-control-allow-origin'] }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('HTTPS fixture timeout')));
    req.end();
  });
}

describe.skipIf(process.platform !== 'linux' || process.env.DEPLOYFLOW_PHASE5B_SMOKE !== '1')('Linux HTTPS hosting', () => {
  it('checks real TLS, Docker limits, lifecycle, route recovery and the private Socket.IO API', async () => {
    const databaseUrl = new URL(process.env.DEPLOYFLOW_PHASE5B_DB ?? '');
    expect(databaseUrl.hostname).toBe('127.0.0.1');
    expect(databaseUrl.port).toBe('55437');
    expect(databaseUrl.pathname).toBe('/deployflow_phase5b');
    const certificate = process.env.NODE_EXTRA_CA_CERTS ?? '';
    const ca = await readFile(certificate, 'utf8');
    const key = join(certificate, '..', 'server.key');
    const folder = await mkdtemp(join(tmpdir(), 'df5-'));
    const adminSocket = join(folder, 'admin.sock');
    const config = join(folder, 'caddy.json');
    const bootstrap = JSON.parse((await readFile('../infra/caddy/public.json', 'utf8')).replaceAll('APPROVED_HOSTNAME', host)) as {
      admin: { listen: string }; apps: { tls: { certificates: unknown }; http: { servers: { deployflow: { listen: string[]; automatic_https: unknown }; redirect: { listen: string[] } } } };
    };
    bootstrap.admin.listen = 'unix/' + adminSocket + '|0660';
    bootstrap.apps.tls.certificates = { load_files: [{ certificate, key }] };
    bootstrap.apps.http.servers.deployflow.listen = ['127.0.0.1:443'];
    bootstrap.apps.http.servers.deployflow.automatic_https = { disable: true };
    bootstrap.apps.http.servers.redirect.listen = ['127.0.0.1:18085'];
    await writeFile(config, JSON.stringify(bootstrap));
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.CADDY_ADMIN_SOCKET = adminSocket;
    process.env.APP_HOSTING_ORIGIN = 'https://' + suffix;
    process.env.APP_HOSTNAME_SUFFIX = suffix;
    process.env.APP_PUBLIC_PROJECT_ID = projectId;
    process.env.APP_PUBLIC_REPOSITORY_URL = repositoryUrl;
    process.env.APP_PUBLIC_BRANCH = 'main';
    process.env.APP_PUBLIC_COMMITS = commit1 + ',' + commit2;
    process.env.REGISTRATION_ENABLED = 'false';
    delete process.env.GITHUB_WEBHOOK_SECRET_KEY;

    const { createApp } = await import('../src/app.js');
    const { database } = await import('../src/config/database.js');
    const { attachDeploymentSocket } = await import('../src/realtime/deployment-socket.js');
    const { createAccessToken } = await import('../src/services/token.service.js');
    const { gitRepositoryService } = await import('../src/services/git-repository.service.js');
    const { applicationHealthCheckService, ApplicationHealthCheckService } = await import('../src/services/application-health-check.service.js');
    const { createCaddyAdminTransport } = await import('../src/services/caddy-admin-transport.js');
    const { deploymentRoutingService } = await import('../src/services/deployment-routing.service.js');
    const { createServer } = await import('node:http');
    const admin = createCaddyAdminTransport(adminSocket);
    const server = createServer(createApp());
    const sockets = attachDeploymentSocket(server);
    const user = await database.user.create({ data: { email: 'linux-fixture@example.net', passwordHash: 'unused' } });
    const auth = 'Bearer ' + await createAccessToken(user.id);
    let child: ReturnType<typeof spawn> | undefined;
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
    let revision = 'v1';
    let step = 'initial setup';
    const fastHealth = new ApplicationHealthCheckService({ maxAttempts: 4, retryDelayMs: 200 });
    vi.spyOn(applicationHealthCheckService, 'waitUntilHealthy').mockImplementation((input) => fastHealth.waitUntilHealthy(input));
    // A fixture supplies reviewed files without contacting or modifying a GitHub repository.
    vi.spyOn(gitRepositoryService, 'prepareRepository').mockImplementation(async (input) => {
      const source = await mkdtemp(join(folder, 'repository-'));
      await writeFile(join(source, 'Dockerfile'), [
        'FROM busybox:1.37.0-glibc',
        'RUN mkdir /www',
        ...(revision === 'bad' ? [] : [`RUN printf '${revision}' > /www/index.html`]),
        'STOPSIGNAL SIGKILL',
        'CMD ["httpd","-f","-p","8080","-h","/www"]',
        '',
      ].join('\n'));
      return { repositoryPath: source, commitHash: revision === 'v1' ? commit1 : commit2,
        metadata: { provider: 'github', owner: 'example', name: 'app', ...input } };
    });
    vi.spyOn(gitRepositoryService, 'cleanup').mockResolvedValue();

    try {
      await database.project.create({
        data: { id: projectId, hostnameLabel: label, name: 'Fixture', repositoryUrl, branch: 'main', containerPort: 8080, userId: user.id },
      });
      await startCaddy();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('Missing fixture API address');
      const api = supertest(server);
      const action = (id: string, operation: string) => api.post('/api/deployments/' + id + '/' + operation).set('Authorization', auth);
      const status = () => api.get('/api/projects/' + projectId).set('Authorization', auth);
      const active = async () => {
        const { activeDeploymentId } = await database.project.findUniqueOrThrow({ where: { id: projectId } });
        if (activeDeploymentId === null) throw new Error('Fixture has no active deployment');
        return activeDeploymentId;
      };
      expect((await https('/', host, ca)).status).toBe(404);
      expect((await api.post('/api/projects').set('Authorization', auth).send({ name: 'Other', repositoryUrl, containerPort: 8080 })).status).toBe(403);
      const first = await api.post('/api/projects/' + projectId + '/deploy').set('Authorization', auth);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const firstId = await active();
      expect(await https('/', host, ca)).toMatchObject({ status: 200, body: 'v1' });
      expect((await https('/', host, ca, 'unknown.example.net')).status).toBe(421);
      await expect(https('/', 'other.apps.example.net', ca)).rejects.toThrow();
      const summary = (await status()).body as { project: { publicProbePath: string } };
      expect(summary.project).toMatchObject({
        publicApplicationUrl: 'https://' + host, hostingStatus: 'VERIFYING_HTTPS',
      });
      const firstProbe = summary.project.publicProbePath;
      expect(await https(firstProbe, host, ca)).toEqual({ status: 204, body: '', cors: 'http://127.0.0.1:3000' });
      expect((await https(firstProbe + 'wrong', host, ca)).status).toBe(404);
      const redirect = await new Promise<{ status: number | undefined; location: string | undefined }>((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port: 18085, headers: { Host: host } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode, location: res.headers.location });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('HTTP redirect fixture timeout')));
        req.end();
      });
      expect(redirect).toEqual({ status: 308, location: 'https://' + host + '/' });

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
      revision = 'bad';
      expect((await action(firstId, 'redeploy')).status).toBe(422);
      expect(await active()).toBe(firstId);
      expect((await https('/', host, ca)).body).toBe('v1');
      step = 'redeploy';
      revision = 'v2';
      const redeploy = await action(firstId, 'redeploy');
      expect(redeploy.status, JSON.stringify(redeploy.body)).toBe(201);
      const secondId = await active();
      expect((await https('/', host, ca)).body).toBe('v2');
      expect((await https(firstProbe, host, ca)).status).toBe(404);
      step = 'rollback';
      expect((await action(firstId, 'rollback')).status).toBe(201);
      const rollbackId = await active();
      expect((await https('/', host, ca)).body).toBe('v1');
      expect((await database.deployment.findUniqueOrThrow({ where: { id: secondId } })).status).toBe('STOPPED');
      step = 'stop, restart and Caddy recovery';
      expect((await action(rollbackId, 'stop')).status).toBe(200);
      expect((await https('/', host, ca)).status).toBe(404);
      expect((await action(rollbackId, 'restart')).status).toBe(200);
      await stopCaddy();
      await startCaddy();
      await deploymentRoutingService?.reconcile();
      expect((await https('/', host, ca)).body).toBe('v1');
      const { containerId } = await database.deployment.findUniqueOrThrow({ where: { id: rollbackId } });
      if (containerId === null) throw new Error('Fixture has no active container');
      const { stdout } = await exec('docker', ['inspect', '--format', '{{json .HostConfig}}', containerId]);
      expect(JSON.parse(stdout)).toMatchObject({
        Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, PidsLimit: 128, Privileged: false,
        RestartPolicy: { Name: 'unless-stopped' }, SecurityOpt: ['no-new-privileges:true'],
      });
    } catch (error) {
      console.error('Linux hosting fixture failed during ' + step + '\n' + caddyLogs);
      throw error;
    } finally {
      server.closeAllConnections();
      await sockets.close();
      await stopCaddy();
      const rows = await database.deployment.findMany({ where: { projectId } });
      for (const row of rows) {
        if (row.containerId !== null) await exec('docker', ['rm', '-f', row.containerId]).catch(() => undefined);
      }
      for (const tag of new Set(rows.flatMap((row) => row.imageTag === null ? [] : [row.imageTag]))) {
        await exec('docker', ['image', 'rm', tag]).catch(() => undefined);
      }
      await database.project.updateMany({ where: { id: projectId }, data: { activeDeploymentId: null, routingDeploymentId: null } });
      await database.user.delete({ where: { id: user.id } });
      await database.$disconnect();
      await rm(folder, { recursive: true, force: true });
    }
  }, 360_000);
});
