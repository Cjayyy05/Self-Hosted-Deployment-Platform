import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const exec = promisify(execFile);
const port = 18083;
const managementPort = 19083;
const docker = (...args: string[]) => exec('docker', ['--context', 'desktop-linux', ...args], { timeout: 15_000 });
const powershell = (script: string) => exec('pwsh.exe', [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
], { timeout: 5000 });

function hit(host: string, path = '/', listener = port): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: listener, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: body.trim() }); });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => { req.destroy(new Error('Fixture HTTP probe timed out')); });
    req.end();
  });
}

async function stop(process: ChildProcess | undefined) {
  if (process?.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill();
  await exited;
}

describe.skipIf(process.env.DEPLOYFLOW_PHASE3_SMOKE !== '1')('disposable deployment routing smoke test', () => {
  it('exercises lifecycle, webhook, and process recovery with PostgreSQL, Docker and Caddy', async () => {
    const directory = process.env.DEPLOYFLOW_PHASE3_DIR ?? '';
    const databaseUrl = new URL(process.env.DEPLOYFLOW_PHASE3_DB ?? '');
    expect(directory).toMatch(/[/\\]df3-[a-f0-9]+$/);
    expect(databaseUrl.hostname).toBe('127.0.0.1');
    expect(databaseUrl.pathname).toBe('/deployflow_phase3');
    const socket = join(directory, 'admin.sock');
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.CADDY_ADMIN_SOCKET = socket;
    process.env.APP_HOSTING_ORIGIN = 'http://localhost:' + String(port);
    process.env.APP_HOSTNAME_SUFFIX = 'localhost';
    process.env.BIND_HOST = '127.0.0.1';
    process.env.PORT = String(managementPort);
    const webhookKey = randomUUID();
    process.env.GITHUB_WEBHOOK_SECRET_KEY = webhookKey;
    const { database } = await import('../src/config/database.js');
    const { createApp } = await import('../src/app.js');
    const { createAccessToken } = await import('../src/services/token.service.js');
    const { gitRepositoryService } = await import('../src/services/git-repository.service.js');
    const { applicationHealthCheckService, ApplicationHealthCheckService } =
      await import('../src/services/application-health-check.service.js');
    const { containerService } = await import('../src/services/container.service.js');
    const { createCaddyAdminTransport } = await import('../src/services/caddy-admin-transport.js');
    const { deploymentRoutingService } = await import('../src/services/deployment-routing.service.js');
    const { projectOperationLockService } = await import('../src/services/project-operation-lock.service.js');
    if (deploymentRoutingService === undefined) throw new Error('Routing was not enabled in the disposable test');
    const { ApplicationRoutingService } = await import('../src/services/application-routing.service.js');
    const admin = createCaddyAdminTransport(socket);
    const managed = new ApplicationRoutingService(admin, 'localhost');
    const userId = '55555555-5555-4555-8555-555555555555';
    const token = await createAccessToken(userId);
    const auth = 'Bearer ' + token;
    const app = createApp();
    const projects = new Set<string>();
    let caddy: ChildProcess | undefined;
    let backend: ChildProcess | undefined;
    let revision = 'v1';
    let caddyLogs = '';
    let backendLogs = '';
    let probeId: string | undefined;
    const configPath = join(directory, 'caddy.json');
    const bootstrap = await readFile(join(directory, 'caddy.json'), 'utf8');
    const caddyBinary = join(directory, 'bin', 'caddy.exe');
    const fastHealth = new ApplicationHealthCheckService({ maxAttempts: 4, retryDelayMs: 200 });
    vi.spyOn(applicationHealthCheckService, 'waitUntilHealthy')
      .mockImplementation((input) => fastHealth.waitUntilHealthy(input));
    // Only repository acquisition is replaced. Docker build and lifecycle are real.
    vi.spyOn(gitRepositoryService, 'prepareRepository').mockImplementation(async (input) => {
      const folder = await mkdtemp(join(directory, 'repo-'));
      try {
        const instruction = revision === 'bad-build' ? 'UNKNOWN_INSTRUCTION intentional' : [
          'FROM busybox:1.37.0-glibc',
          'RUN mkdir -p /www',
          ...(revision === 'bad-health' ? [] : ["RUN printf '" + revision + "' > /www/index.html"]),
          'CMD ["httpd","-f","-p","8080","-h","/www"]',
        ].join('\n');
        await writeFile(join(folder, 'Dockerfile'), instruction + '\n');
        return {
          repositoryPath: folder, commitHash: (revision === 'v1' ? '1' : '2').repeat(40),
          metadata: { provider: 'github', owner: 'example', name: 'app', ...input },
        };
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
    });
    // The real cleanup deliberately accepts only its own standard clone path.
    vi.spyOn(gitRepositoryService, 'cleanup').mockImplementation(async (folder) => {
      if (!folder.startsWith(join(directory, 'repo-'))) throw new Error('Unexpected fixture clone path');
      await rm(folder, { recursive: true, force: true });
    });

    const startCaddy = async () => {
      await powershell('if(Test-Path -LiteralPath $env:CADDY_ADMIN_SOCKET){Remove-Item -LiteralPath $env:CADDY_ADMIN_SOCKET -Force -ErrorAction Stop}');
      await writeFile(configPath, bootstrap);
      caddy = spawn(caddyBinary, ['run', '--config', configPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      caddy.stderr?.on('data', (chunk: Buffer) => { caddyLogs = (caddyLogs + chunk.toString()).slice(-6000); });
      await vi.waitFor(async () => { expect((await admin({ method: 'GET' })).status).toBe(200); }, { timeout: 6000 });
    };
    const stopCaddy = async () => {
      if (caddy?.exitCode === null && caddy.signalCode === null) {
        const exited = once(caddy, 'exit');
        try {
          const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe');
          await exec(executable, ['-q', '--noproxy', '*', '--max-time', '2', '--unix-socket', socket,
            '--request', 'POST', 'http://localhost/stop'], { timeout: 3000 });
        } finally {
          await Promise.race([exited, sleep(1500)]);
          await stop(caddy);
          await exited;
        }
      }
      caddy = undefined;
    };
    const assertCaddyPrivate = async () => {
      const { stdout } = await exec('netstat.exe', ['-ano']);
      const lines = stdout.split(/\r?\n/);
      const listeners = lines.filter((line) => new RegExp(
        '^\\s*(?:TCP\\s+.*\\s+LISTENING|UDP\\s+.*)\\s+' + String(caddy?.pid) + '\\s*$',
      ).test(line));
      expect(listeners).toHaveLength(1);
      expect(listeners[0]).toMatch(/^\s*TCP\s+127\.0\.0\.1:18083\s/);
      expect(lines.some((line) => /^\s*TCP\s+\S+:(?:2019|2021)\s+\S+\s+LISTENING/.test(line))).toBe(false);
      const check = [
        '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$acl=Get-Acl -LiteralPath $env:CADDY_ADMIN_SOCKET -ErrorAction Stop',
        '$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
        'if($rules.Count -ne 2 -or @($rules.IdentityReference.Value | Sort-Object -Unique).Count -ne 2 -or',
        ' @($rules | Where-Object { $_.IdentityReference.Value -notin @($sid,"S-1-5-18") -or',
        ' $_.AccessControlType -ne "Allow" -or $_.FileSystemRights -ne "FullControl" }).Count){exit 1}',
      ].join('\n');
      await powershell(check);
    };
    const startBackend = async () => {
      backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      backend.stdout?.on('data', (chunk: Buffer) => { backendLogs = (backendLogs + chunk.toString()).slice(-2000); });
      backend.stderr?.on('data', (chunk: Buffer) => { backendLogs = (backendLogs + chunk.toString()).slice(-2000); });
      await vi.waitFor(async () => {
        expect((await hit('localhost', '/api/health', managementPort)).status).toBe(200);
      }, { timeout: 8000 });
    };
    const project = async (name: string) => {
      const response = await request(app).post('/api/projects').set('Authorization', auth)
        .send({ name, repositoryUrl: 'https://github.com/example/app', containerPort: 8080 });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const { project: row } = response.body as { project: { id: string; hostnameLabel: string } };
      projects.add(row.id);
      return { id: row.id, host: row.hostnameLabel + '.localhost' };
    };
    const active = async (projectId: string) => (await database.project.findUniqueOrThrow({
      where: { id: projectId }, select: { activeDeploymentId: true },
    })).activeDeploymentId;
    const deployment = async (id: string | null) => {
      if (id === null) throw new Error('Expected an active deployment');
      return database.deployment.findUniqueOrThrow({ where: { id } });
    };
    const expectContainerState = async (id: string | null, running: boolean) => {
      if (id === null) throw new Error('Expected a fixture container');
      const { stdout } = await docker('inspect', '--format', '{{.HostConfig.RestartPolicy.Name}} {{.State.Running}}', id);
      expect(stdout.trim()).toBe(`unless-stopped ${String(running)}`);
    };
    const deploy = (id: string) => request(app).post('/api/projects/' + id + '/deploy').set('Authorization', auth);
    const action = (id: string, kind: string) => request(app).post('/api/deployments/' + id + '/' + kind).set('Authorization', auth);
    const expectHosting = async (p: { id: string; host: string }, status: string, activeId: string | null, latest?: string) => {
      await vi.waitFor(async () => {
        const response = await request(app).get('/api/projects/' + p.id).set('Authorization', auth);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          project: {
            localApplicationUrl: 'http://' + p.host + ':' + String(port),
            hostingStatus: status,
            activeDeployment: activeId === null ? null : { id: activeId },
            ...(latest === undefined ? {} : { latestDeployment: { status: latest } }),
          },
        });
      }, { timeout: 6_000, interval: 250 });
    };
    const expectBody = async (host: string, body: string) => {
      expect(await hit(host)).toEqual({ status: 200, body });
    };

    try {
      await startCaddy();
      await assertCaddyPrivate();
      const p = await project('Phase 3 smoke app');
      const other = await project('Phase 3 second app');
      await expectHosting(p, 'UNAVAILABLE', null);
      expect((await hit('app-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa.localhost')).status).toBe(404);
      const initial = await deploy(p.id);
      expect(initial.status, JSON.stringify(initial.body)).toBe(201);
      const first = await deployment(await active(p.id));
      await expectContainerState(first.containerId, true);
      await expectBody(p.host, 'v1');
      await expectHosting(p, 'AVAILABLE', first.id, 'RUNNING');
      expect((await hit('unknown.localhost')).status).toBe(404);

      revision = 'other';
      expect((await deploy(other.id)).status).toBe(201);
      await expectBody(other.host, 'other');
      const otherActive = await active(other.id);
      revision = 'v2';
      expect((await action(first.id, 'redeploy')).status).toBe(201);
      const second = await deployment(await active(p.id));
      expect(second.id).not.toBe(first.id);
      expect((await deployment(first.id)).status).toBe('STOPPED');
      await expectContainerState(first.containerId, false);
      await expectContainerState(second.containerId, true);
      await expectBody(p.host, 'v2');
      await expectHosting(p, 'AVAILABLE', second.id, 'RUNNING');
      expect(await active(other.id)).toBe(otherActive);
      await expectBody(other.host, 'other');
      console.info('Live initial deploy and redeploy: exact stable hostname and two isolated projects.');

      for (const failedRevision of ['bad-build', 'bad-health']) {
        revision = failedRevision;
        const failed = await action(second.id, 'redeploy');
        expect(failed.status, JSON.stringify(failed.body)).toBe(422);
        expect(await active(p.id)).toBe(second.id);
        await expectBody(p.host, 'v2');
        await expectHosting(p, 'AVAILABLE', second.id, 'FAILED');
      }
      console.info('Real Docker build and health failures preserved the active v2 route.');

      await database.$executeRaw`
        CREATE FUNCTION phase3_reject_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD."activeDeploymentId" IS NOT NULL AND NEW."activeDeploymentId" IS NOT NULL
            AND OLD."activeDeploymentId" IS DISTINCT FROM NEW."activeDeploymentId" THEN
            RAISE EXCEPTION 'Disposable test refused the promotion commit';
          END IF;
          RETURN NEW;
        END; $$`;
      try {
        await database.$executeRaw`
          CREATE TRIGGER phase3_reject_promotion BEFORE UPDATE OF "activeDeploymentId" ON "Project"
          FOR EACH ROW EXECUTE FUNCTION phase3_reject_promotion()`;
        revision = 'database-failure';
        const failedCommit = await action(second.id, 'redeploy');
        expect(failedCommit.status, JSON.stringify(failedCommit.body)).toBe(502);
        expect(await active(p.id)).toBe(second.id);
        await expectBody(p.host, 'v2');
      } finally {
        await database.$executeRaw`DROP TRIGGER IF EXISTS phase3_reject_promotion ON "Project"`;
        await database.$executeRaw`DROP FUNCTION phase3_reject_promotion()`;
      }
      console.info('Real PostgreSQL promotion rejection restored the v2 route before candidate cleanup.');

      const rollback = await action(first.id, 'rollback');
      expect(rollback.status, JSON.stringify(rollback.body)).toBe(201);
      const rolledBack = await deployment(await active(p.id));
      expect(rolledBack.rollbackSourceDeploymentId).toBe(first.id);
      await expectContainerState(second.containerId, false);
      await expectContainerState(rolledBack.containerId, true);
      await expectBody(p.host, 'v1');
      await expectHosting(p, 'AVAILABLE', rolledBack.id, 'RUNNING');
      expect((await action(rolledBack.id, 'stop')).status).toBe(200);
      await expectContainerState(rolledBack.containerId, false);
      expect(await active(p.id)).toBeNull();
      expect((await hit(p.host)).status).toBe(404);
      await expectHosting(p, 'UNAVAILABLE', null, 'STOPPED');
      expect((await action(rolledBack.id, 'restart')).status).toBe(200);
      await expectContainerState(rolledBack.containerId, true);
      expect(await active(p.id)).toBe(rolledBack.id);
      await expectBody(p.host, 'v1');
      await expectHosting(p, 'AVAILABLE', rolledBack.id, 'RUNNING');
      console.info('Real rollback, stop, and explicit restart reused the same hostname.');

      const beforeFence = await admin({ method: 'GET' });
      const { containerId } = rolledBack;
      if (containerId === null || beforeFence.etag === undefined) throw new Error('Missing active fixture state');
      await projectOperationLockService.runExclusive(p.id, async (lease) => {
        if (lease === undefined) throw new Error('Expected lease');
        await managed.repair(p.id, { containerId, deploymentId: rolledBack.id, containerPort: 8080 }, {
          beforeWrite: lease.assertValid,
        });
      });
      const afterFence = await admin({ method: 'GET' });
      expect(afterFence.etag).not.toBe(beforeFence.etag);
      expect((JSON.parse(afterFence.body) as { '@id'?: string }[]).at(-1)?.['@id'])
        .toMatch(/^deployflow-revision-[a-f0-9]{32}$/);
      expect((await admin({ method: 'PATCH', body: beforeFence.body, etag: beforeFence.etag })).status).toBe(412);
      await expectBody(p.host, 'v1');
      console.info('Real Caddy changed the ETag for an identical route target with a fresh fallback revision; stale PATCH returned 412.');

      revision = 'webhook';
      const body = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'example/app' } });
      const secret = createHmac('sha256', webhookKey)
        .update('github-webhook:' + p.id).digest('base64url');
      const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
      const delivery = randomUUID();
      const webhook = (signed: string) => request(app).post('/api/webhooks/github/' + p.id)
        .set('Content-Type', 'application/json').set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', delivery).set('X-Hub-Signature-256', signed).send(body);
      expect((await webhook('sha256=' + '0'.repeat(64))).status).toBe(401);
      expect((await webhook(signature)).status).toBe(202);
      await vi.waitFor(async () => {
        await expectBody(p.host, 'webhook');
        expect(await active(p.id)).not.toBe(rolledBack.id);
      }, { timeout: 15_000 });
      const hookDeployment = await deployment(await active(p.id));
      expect(hookDeployment.id).not.toBe(rolledBack.id);
      await expectHosting(p, 'AVAILABLE', hookDeployment.id, 'RUNNING');
      await vi.waitFor(async () => {
        expect((await database.project.findUniqueOrThrow({ where: { id: p.id } })).routingOperation).toBeNull();
      }, { timeout: 8000 });
      const count = await database.deployment.count({ where: { projectId: p.id } });
      const duplicate = await webhook(signature);
      expect(duplicate.body).toMatchObject({ accepted: false, reason: 'duplicate_delivery' });
      expect(await database.deployment.count({ where: { projectId: p.id } })).toBe(count);
      console.info('Signed webhook promoted a real Docker version; bad signature and duplicate were rejected.');

      // Emulate a process dying after Caddy has changed but before committing its promotion.
      if (rolledBack.containerId === null) throw new Error('Historical fixture container missing');
      await containerService.restartContainer(rolledBack.containerId, 8080);
      await database.project.update({
        where: { id: p.id }, data: { routingOperation: 'PROMOTE', routingDeploymentId: rolledBack.id },
      });
      await managed.upsert(p.id, {
        deploymentId: rolledBack.id, containerId: rolledBack.containerId, containerPort: 8080,
      });
      await expectBody(p.host, 'v1');
      await startBackend();
      await vi.waitFor(async () => {
        await expectBody(p.host, 'webhook');
        expect(await database.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
          routingOperation: null, operationLockToken: null,
        });
      }, { timeout: 12_000 });
      expect(await active(p.id)).toBe(hookDeployment.id);
      expect((await containerService.inspectStatus(rolledBack.containerId)).running).toBe(false);
      await stop(backend);
      backend = undefined;
      await stopCaddy();
      await expectHosting(p, 'RECOVERING', hookDeployment.id, 'RUNNING');
      await startCaddy();
      expect((await hit(p.host)).status).toBe(404);
      await database.deployment.update({ where: { id: hookDeployment.id }, data: { hostPort: 1 } });
      await startBackend();
      await vi.waitFor(async () => {
        await expectBody(p.host, 'webhook');
        await expectBody(other.host, 'other');
        expect((await deployment(hookDeployment.id)).hostPort).not.toBe(1);
        expect(await database.project.count({
          where: { id: { in: [p.id, other.id] }, operationLockToken: { not: null } },
        })).toBe(0);
      }, { timeout: 12_000 });
      await stopCaddy();
      await startCaddy();
      await vi.waitFor(async () => {
        await expectBody(p.host, 'webhook');
        await expectBody(other.host, 'other');
        expect(await database.project.count({
          where: { id: { in: [p.id, other.id] }, operationLockToken: { not: null } },
        })).toBe(0);
      }, { timeout: 20_000 });
      await stop(backend);
      backend = undefined;
      await expectHosting(p, 'AVAILABLE', hookDeployment.id, 'RUNNING');
      console.info('Fresh backend process repaired an interrupted promotion; fresh Caddy bootstraps recovered both active routes.');
      await assertCaddyPrivate();

      const { stdout } = await docker('run', '--rm', '-d', '--pull=never', '--label', 'deployflow.phase3=56a1',
        '--user', '65534:65534', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--entrypoint', '/bin/sh', 'docker.io/curlimages/curl:8.22.0', '-c', 'exec sleep 120');
      probeId = stdout.trim();
      const probe = await docker('inspect', probeId, '--format', '{{.Config.User}}|{{.HostConfig.Privileged}}|{{json .Mounts}}');
      expect(probe.stdout.trim()).toBe('65534:65534|false|[]');
      const publicControl = await docker('exec', probeId, 'curl', '-q', '-sS', '--noproxy', '*', '--max-time', '3',
        '-H', 'Host: ' + p.host, 'http://host.docker.internal:' + String(port) + '/');
      expect(publicControl.stdout).toBe('webhook');
      for (const host of ['host.docker.internal', 'gateway.docker.internal']) {
        for (const adminPort of [2019, 2021]) {
          const failure: unknown = await docker('exec', probeId, 'curl', '-q', '-sS', '--noproxy', '*', '--max-time', '2',
            'http://' + host + ':' + String(adminPort) + '/config/').then(() => undefined, (error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect([7, 28]).toContain((failure as { code?: number }).code);
        }
      }
      await docker('exec', probeId, 'sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/admin.sock');
      const denied = await docker('exec', probeId, 'curl', '-q', '-sS', '--max-time', '2', '-X', 'PATCH',
        '-w', '%{http_code}', 'http://host.docker.internal:' + String(port) + '/config/');
      expect(denied.stdout).toBe('Unknown host404');
      await expectBody(p.host, 'webhook');
      console.info('Unprivileged workload reached the data plane but no TCP admin, admin socket, or admin write path.');

      const originalRemove = containerService.removeContainer.bind(containerService);
      const removal = vi.spyOn(containerService, 'removeContainer').mockImplementation((id) =>
        id === hookDeployment.containerId ? Promise.reject(new Error('Injected fixture removal failure')) : originalRemove(id));
      try {
        const failedDelete = await request(app).delete('/api/projects/' + p.id).set('Authorization', auth);
        expect(failedDelete.status).toBe(502);
        expect(await active(p.id)).toBe(hookDeployment.id);
        await expectBody(p.host, 'webhook');
      } finally {
        removal.mockRestore();
      }
      expect((await request(app).delete('/api/projects/' + p.id).set('Authorization', auth)).status).toBe(204);
      expect((await hit(p.host)).status).toBe(404);
      await expectBody(other.host, 'other');
      console.info('A deletion failure restored the surviving application. A successful retry withdrew only its route.');

      const disappeared = await deployment(otherActive);
      if (disappeared.containerId === null) throw new Error('Expected a disposable active container');
      const expectedContainer = await docker('inspect', disappeared.containerId, '--format',
        '{{index .Config.Labels "deployflow.deployment-id"}}');
      expect(expectedContainer.stdout.trim()).toBe(disappeared.id);
      await expectBody(other.host, 'other');
      await docker('rm', '-f', disappeared.containerId);
      await deploymentRoutingService.reconcile();
      expect((await hit(other.host)).status).toBe(404);
      expect(await active(other.id)).toBe(disappeared.id);
      expect((await deployment(disappeared.id)).hostPort).toBeNull();
      console.info('Recovery removed a route for a confirmed missing fixture without choosing a different deployment.');
    } catch (error) {
      console.error('Disposable Caddy logs:', caddyLogs);
      console.error('Disposable backend logs:', backendLogs);
      throw error;
    } finally {
      await stop(backend);
      await stopCaddy().catch(async () => { await stop(caddy); });
      if (probeId !== undefined && /^[a-f0-9]{64}$/.test(probeId)) await docker('stop', '--timeout', '1', probeId);
      const rows = await database.deployment.findMany({ where: { projectId: { in: [...projects] } } });
      for (const row of rows) {
        if (row.containerId !== null) {
          const found = await docker('ps', '-a', '-q', '--no-trunc', '--filter', 'label=deployflow.deployment-id=' + row.id);
          if (found.stdout.trim() === row.containerId) await docker('rm', '-f', row.containerId);
        }
      }
      for (const projectId of projects) {
        const images = await docker('image', 'ls', '--format', '{{.Repository}}', 'deployflow/project-' + projectId + '/*');
        for (const tag of new Set(images.stdout.split(/\r?\n/).filter((entry) =>
          entry.startsWith('deployflow/project-' + projectId + '/deployment-')))) {
          await docker('image', 'rm', tag);
        }
      }
      await database.project.deleteMany({ where: { id: { in: [...projects] }, userId } });
      await database.$disconnect();
    }
  }, 180_000);
});
