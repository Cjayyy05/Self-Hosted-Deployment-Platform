import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { parseHostingConfig } from '../src/config/env.js';
import { ApplicationRoutingService } from '../src/services/application-routing.service.js';
import { createCaddyAdminTransport } from '../src/services/caddy-admin-transport.js';
import { containerService } from '../src/services/container.service.js';
import { projectHostnameLabel } from '../src/utils/project-hostname.js';

const exec = promisify(execFile);
const projectId = '11111111-1111-4111-8111-111111111111';
const deploymentId = '22222222-2222-4222-8222-222222222222';
const marker = 'DEPLOYFLOW_PHASE_2C';

function httpProbe(port: number, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      ...(host === undefined ? {} : { headers: { host } }),
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: body.trim() }); });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => { req.destroy(new Error('Application probe timed out')); });
    req.end();
  });
}

const docker = (args: string[]) =>
  exec('docker', ['--context', 'desktop-linux', ...args], { timeout: 5_000, maxBuffer: 128 * 1024 });

async function workloadProbe(id: string, args: string[]) {
  let stdout: string;
  let exit = 0;
  try {
    ({ stdout } = await docker(['exec', id, 'curl', '-q', '--noproxy', '*', '--silent', '--show-error',
      '--connect-timeout', '1', '--max-time', '2', '--write-out', '\nRESULT=%{http_code}|%{remote_ip}', ...args]));
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (typeof failure.code !== 'number' || failure.stdout === undefined) throw error;
    exit = failure.code;
    stdout = failure.stdout;
  }
  const match = /^([\s\S]*)\nRESULT=(\d{3})\|([^\r\n]*)$/.exec(stdout);
  if (match === null) throw new Error('Workload curl did not produce an HTTP result');
  return { status: Number(match[2]), peer: match[3], body: match[1]?.trim(), exit };
}

describe.skipIf(process.env.DEPLOYFLOW_ROUTING_SMOKE !== '1')('disposable Docker and Caddy smoke test', () => {
  it('uses the real transport and Docker binding with a private admin endpoint', async () => {
    const socket = process.env.DEPLOYFLOW_SMOKE_SOCKET ?? '';
    const port = Number(process.env.DEPLOYFLOW_SMOKE_PORT);
    const appId = process.env.DEPLOYFLOW_SMOKE_APP_ID ?? '';
    const probeId = process.env.DEPLOYFLOW_SMOKE_PROBE_ID ?? '';
    expect(appId).toMatch(/^[a-f0-9]{64}$/);
    expect(probeId).toMatch(/^[a-f0-9]{64}$/);
    expect(socket).toMatch(/[/\\]df2c-[a-f0-9]+[/\\]admin\.sock$/);
    const hosting = parseHostingConfig({ origin: 'http://localhost:' + String(port), adminSocketPath: socket });
    const admin = createCaddyAdminTransport(socket);
    const service = new ApplicationRoutingService(admin, hosting.hostnameSuffix);
    const input = { containerId: appId, deploymentId, containerPort: 8080 };
    const host = projectHostnameLabel(projectId) + '.localhost';
    const start = await admin({ method: 'GET' });
    expect(start.status).toBe(200);
    expect(JSON.parse(start.body)).toEqual([{
      handle: [{ handler: 'static_response', status_code: 404, body: 'Unknown host' }],
      terminal: true,
    }]);
    if (start.etag === undefined) throw new Error('Caddy did not supply an ETag');
    const upstream = await containerService.inspectLoopbackRoutingPort(input);
    expect(await httpProbe(upstream)).toEqual({ status: 200, body: marker });
    expect(await httpProbe(port, host)).toEqual({ status: 404, body: 'Unknown host' });

    await service.upsert(projectId, input);
    expect(await httpProbe(port, host)).toEqual({ status: 200, body: marker });
    expect(await httpProbe(port, 'unknown.localhost')).toEqual({ status: 404, body: 'Unknown host' });
    const conflict = await admin({ method: 'PATCH', body: start.body, etag: start.etag });
    expect(conflict.status).toBe(412);
    expect(await httpProbe(port, host)).toEqual({ status: 200, body: marker });

    const workload = await docker(['inspect', probeId, '--format',
      '{{.Config.User}}|{{.HostConfig.Privileged}}|{{json .Mounts}}|{{json .HostConfig.PortBindings}}|{{.NetworkSettings.Networks.bridge.Gateway}}']);
    const [user, privileged, mounts, bindings, gateway] = workload.stdout.trim().split('|');
    expect([user, privileged, mounts, bindings]).toEqual(['65534:65534', 'false', '[]', '{}']);
    expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    await docker(['exec', probeId, 'sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/admin.sock']);
    expect(await workloadProbe(probeId, ['--unix-socket', '/run/admin.sock', 'http://localhost/config/']))
      .toMatchObject({ exit: 7, status: 0 });

    const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address));
    const targets = new Set([
      'host.docker.internal', 'gateway.docker.internal', 'phase2c-host-gateway', '127.0.0.1',
      ...(gateway ? [gateway] : []), ...addresses,
    ]);
    let reachable = 0;
    for (const target of targets) {
      for (const adminPort of [2019, 2021]) {
        const probe = await workloadProbe(probeId, ['http://' + target + ':' + String(adminPort) + '/config/']);
        expect(probe, target + ':' + String(adminPort)).toMatchObject({ status: 0, peer: '' });
        expect([7, 28]).toContain(probe.exit);
      }
      const listener = 'http://' + target + ':' + String(port);
      const probe = await workloadProbe(probeId, ['-H', 'Host: ' + host, listener]);
      if (probe.status === 0) {
        expect(probe.peer).toBe('');
        expect([7, 28]).toContain(probe.exit);
        continue;
      }
      expect(probe).toMatchObject({ status: 200, body: marker });
      reachable += 1;
      const throughApplication = await workloadProbe(probeId, [
        '-H', 'Host: ' + host, listener + '/config/',
      ]);
      expect(throughApplication.status).toBe(404);
      for (const [method, path] of [
        ['GET', '/config/'],
        ['PATCH', '/config/apps/http/servers/deployflow/routes'],
      ] as const) {
        const denial = await workloadProbe(probeId, ['-X', method, ...(method === 'PATCH' ? [
          '-H', 'Content-Type: application/json', '--data-binary', '"PHASE2C_UNEXPECTED"',
        ] : []), listener + path]);
        expect(denial).toMatchObject({ status: 404, body: 'Unknown host' });
      }
    }
    expect(reachable).toBeGreaterThan(0);
    console.info('Docker upstream %d; exact host %s:%d; admin denied across %d paths with %d data-plane controls',
      upstream, host, port, targets.size, reachable);
    expect(await httpProbe(port, host)).toEqual({ status: 200, body: marker });
    await service.remove(projectId);
    expect(await httpProbe(port, host)).toEqual({ status: 404, body: 'Unknown host' });
    expect(await httpProbe(port, 'unknown.localhost')).toEqual({ status: 404, body: 'Unknown host' });

    await service.upsert(projectId, input);
    // Exercise a real provisioning rejection on a disposable instance. On Windows
    // this can leave the admin listener unavailable, so keep this case last.
    let writes = 0;
    let rejectedStatus: number | undefined;
    const faulted = new ApplicationRoutingService(async (request, timeout) => {
      if (request.method === 'GET') return admin(request, timeout);
      writes += 1;
      const response = await admin({
        ...request,
        body: JSON.stringify([{ handle: [{ handler: 'unregistered_phase2c_handler' }] }]),
      }, timeout);
      rejectedStatus = response.status;
      return response;
    }, hosting.hostnameSuffix);
    await expect(faulted.remove(projectId)).rejects.toMatchObject({ code: 'uncertain' });
    expect(rejectedStatus).toBe(500);
    await expect(faulted.remove(projectId)).rejects.toMatchObject({ code: 'uncertain' });
    expect(writes).toBe(1);
    expect(await httpProbe(port, host)).toEqual({ status: 200, body: marker });
    expect(await httpProbe(port, 'unknown.localhost')).toEqual({ status: 404, body: 'Unknown host' });
    console.info('Caddy rejected invalid configuration with HTTP 500; active route and 404 preserved, writes paused.');
  }, 70_000);
});
