import { describe, expect, it, vi } from 'vitest';

import { ProjectHostingService } from '../src/services/project-hosting.service.js';
import { PublicHostingReadinessError } from '../src/services/public-hosting-readiness.service.js';

const hostnameLabel = 'app-11111111111141118111111111111111';
const hostname = hostnameLabel + '.localhost';
const hosting = { origin: 'http://localhost:18083', hostnameSuffix: 'localhost', adminSocketPath: undefined };
const active = { id: '33333333-3333-4333-8333-333333333333', status: 'RUNNING', hostPort: 51001,
  publicAddressIndex: null, commitHash: 'a'.repeat(40) } as const;
const project = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  repositoryUrl: 'https://github.com/example/app',
  branch: 'main',
  hostnameLabel,
  healthCheckPath: '/health',
  activeDeployment: active,
  deployments: [{ status: 'RUNNING' as const }],
  routingOperation: null,
};

const setup = () => {
  const route = new Map([[hostname, { address: '127.0.0.1', port: active.hostPort }]]);
  const routes = { readDashboardTargets: vi.fn<() => Promise<ReadonlyMap<string, { address: string; port: number }>>>().mockResolvedValue(route) };
  const health = { waitUntilHealthy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
  return { ...routes, ...health, service: new ProjectHostingService(routes, hosting, health) };
};

const publicHostname = hostnameLabel + '.apps.example.net';
const publicTarget = { address: '127.64.0.1', port: 787 };
const publicProject = { ...project, activeDeployment: { ...active, publicAddressIndex: 1, hostPort: publicTarget.port } };
const publicApproval = { revokedAt: null, commits: [active.commitHash] };

const setupPublic = () => {
  const readDashboardTargets = vi.fn().mockResolvedValue(new Map([[publicHostname, publicTarget]]));
  const readiness = { verifyDashboardDns: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    verifyHttps: vi.fn().mockResolvedValue(undefined) };
  const read = vi.fn().mockResolvedValue(publicApproval);
  const now = vi.fn().mockReturnValue(0);
  const service = new ProjectHostingService({ readDashboardTargets }, {
    origin: 'https://apps.example.net', hostnameSuffix: 'apps.example.net', adminSocketPath: '/run/caddy/admin.sock',
    publicHosting: { operatorId: project.userId },
  }, undefined, { read }, readiness, now);
  return { service, readDashboardTargets, readiness, read, now };
};

describe('project hosting status', () => {
  it('handles disabled hosting and skips Caddy for new projects and initial builds', async () => {
    const disabled = new ProjectHostingService(undefined, hosting);
    const { service, readDashboardTargets } = setup();
    const newProject = { ...project, activeDeployment: null, deployments: [] };
    await expect(disabled.summarize(newProject)).resolves.toEqual({
      localApplicationUrl: null, hostingStatus: 'DISABLED',
    });
    await expect(service.summarize(newProject)).resolves.toEqual({
      localApplicationUrl: 'http://' + hostname + ':18083', hostingStatus: 'UNAVAILABLE',
    });
    await expect(service.summarize({ ...newProject, deployments: [{ status: 'BUILDING' }] }))
      .resolves.toMatchObject({ hostingStatus: 'DEPLOYING' });
    expect(readDashboardTargets).not.toHaveBeenCalled();
  });

  it('keeps a confirmed active route available during and after a failed replacement', async () => {
    const { service, waitUntilHealthy } = setup();
    const [building, failed] = await Promise.all([
      service.summarize({ ...project, deployments: [{ status: 'BUILDING' }] }),
      service.summarize({ ...project, deployments: [{ status: 'FAILED' }] }),
    ]);
    expect(building.hostingStatus).toBe('AVAILABLE');
    expect(failed).toEqual({ localApplicationUrl: 'http://' + hostname + ':18083', hostingStatus: 'AVAILABLE' });
    expect(waitUntilHealthy).toHaveBeenCalledExactlyOnceWith({
      hostPort: 18083, hostname, path: '/health',
    });
  });

  it('checks health again with a fresh route snapshot or an edited health-check path', async () => {
    const { service, waitUntilHealthy, readDashboardTargets } = setup();
    await service.summarize(project);
    await service.summarize({ ...project, healthCheckPath: '/new' });
    readDashboardTargets.mockResolvedValue(new Map([[hostname, { address: '127.0.0.1', port: active.hostPort }]]));
    await service.summarize(project);
    expect(waitUntilHealthy).toHaveBeenCalledTimes(3);
  });

  it('requires attention for unavailable admin, absent routes, and routes to the wrong deployment', async () => {
    const { service, readDashboardTargets, waitUntilHealthy } = setup();
    readDashboardTargets.mockRejectedValueOnce(new Error('Caddy stopped'));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardTargets.mockResolvedValueOnce(new Map());
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardTargets.mockResolvedValueOnce(new Map([[hostname, { address: '127.0.0.1', port: 51002 }]]));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    expect(waitUntilHealthy).not.toHaveBeenCalled();
  });

  it('requires attention when the proxy fails or the route changes during its health check', async () => {
    const { service, readDashboardTargets, waitUntilHealthy } = setup();
    waitUntilHealthy.mockRejectedValueOnce(new Error('Proxy timed out'));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardTargets.mockResolvedValueOnce(new Map([[hostname, { address: '127.0.0.1', port: active.hostPort }]]))
      .mockResolvedValueOnce(new Map());
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
  });

  it('returns a route-specific browser check only after approval, DNS and HTTPS checks', async () => {
    const { service, readDashboardTargets, readiness, read } = setupPublic();
    const verified = await service.summarize(publicProject);
    expect(verified).toMatchObject({
      localApplicationUrl: null, publicHostname, publicApplicationUrl: 'https://' + publicHostname,
      hostingStatus: 'AVAILABLE', certificateStatus: 'READY', approvalStatus: 'APPROVED',
    });
    expect(verified.publicProbePath).toMatch(/^\/\.well-known\/deployflow-health\/[a-f0-9]{64}$/);
    expect(readiness.verifyDashboardDns).toHaveBeenCalledWith(publicHostname);
    expect(readiness.verifyHttps).toHaveBeenCalledWith(new URL('https://' + publicHostname), verified.publicProbePath);
    await expect(service.summarize({ ...publicProject, routingOperation: 'STOP' }))
      .resolves.toMatchObject({ hostingStatus: 'RECOVERING', certificateStatus: 'UNVERIFIED' });
    read.mockResolvedValueOnce(null);
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ publicHostname, hostingStatus: 'UNAVAILABLE', approvalStatus: 'UNAPPROVED' });
    const replacement = { ...publicProject, activeDeployment: { ...publicProject.activeDeployment, publicAddressIndex: 2 } };
    await expect(service.summarize(replacement)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardTargets.mockResolvedValue(new Map([[publicHostname, { address: '127.64.0.2', port: 787 }]]));
    const updated = await service.summarize(replacement);
    expect(updated.hostingStatus).toBe('AVAILABLE');
    expect(updated.publicProbePath).not.toBe(verified.publicProbePath);
    readDashboardTargets.mockResolvedValue(new Map([[publicHostname, publicTarget]]));
    readiness.verifyHttps.mockRejectedValueOnce(new PublicHostingReadinessError('CERTIFICATE'));
    const unverified = await service.summarize(publicProject);
    expect(unverified.hostingStatus).toBe('RECOVERING');
    expect(unverified.hostingError?.code).toBe('CERTIFICATE');
    expect(unverified.publicProbePath).toBeUndefined();
  });

  it('shares an in-flight verification and escalates only after three failed transient rounds', async () => {
    const { service, readiness } = setupPublic();
    const verified = await service.summarize(publicProject);
    readiness.verifyDashboardDns.mockResolvedValue(false);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => service.summarize(publicProject)));
    for (const summary of concurrent) {
      expect(summary).toMatchObject({ hostingStatus: 'VERIFYING_DNS', publicProbePath: verified.publicProbePath });
    }
    expect(readiness.verifyDashboardDns).toHaveBeenCalledTimes(2);
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'VERIFYING_DNS' });
    const unverified = await service.summarize(publicProject);
    expect(unverified.hostingStatus).toBe('DNS_UNVERIFIED');
    expect(unverified.publicProbePath).toBeUndefined();
    readiness.verifyDashboardDns.mockResolvedValueOnce(true);
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'AVAILABLE' });
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'VERIFYING_DNS' });
  });

  it('requires an unexpired verification for this deployment and health path', async () => {
    const { service, readiness, now } = setupPublic();
    readiness.verifyDashboardDns.mockResolvedValue(false);
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    readiness.verifyDashboardDns.mockResolvedValueOnce(true);
    await service.summarize(publicProject);
    now.mockReturnValue(20_000);
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    readiness.verifyDashboardDns.mockResolvedValueOnce(true);
    await service.summarize(publicProject);
    await expect(service.summarize({ ...publicProject, healthCheckPath: '/changed' }))
      .resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    readiness.verifyDashboardDns.mockResolvedValueOnce(true);
    await service.summarize(publicProject);
    await expect(service.summarize({ ...publicProject, activeDeployment: { ...publicProject.activeDeployment, id: 'replacement' } }))
      .resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
  });

  it.each(['DNS', 'APPLICATION', 'CERTIFICATE', 'ROUTING'] as const)(
    'reports a confirmed %s failure immediately and clears the previous verification',
    async (code) => {
      const { service, readiness } = setupPublic();
      await service.summarize(publicProject);
      readiness.verifyDashboardDns.mockResolvedValue(false);
      const check = code === 'DNS' ? readiness.verifyDashboardDns : readiness.verifyHttps;
      check.mockRejectedValueOnce(new PublicHostingReadinessError(code));
      const failure = await service.summarize(publicProject);
      expect(failure).toMatchObject({ hostingStatus: 'RECOVERING', hostingError: { code } });
      expect(failure.publicProbePath).toBeUndefined();
      await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    },
  );

  it('withdraws dashboard verification immediately on a route change or loss of approval', async () => {
    const { service, readiness, read, readDashboardTargets } = setupPublic();
    await service.summarize(publicProject);
    readiness.verifyDashboardDns.mockResolvedValue(false);
    readDashboardTargets.mockResolvedValueOnce(new Map([[publicHostname, publicTarget]])).mockResolvedValueOnce(new Map());
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingError: { code: 'ROUTING' } });
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    readiness.verifyDashboardDns.mockResolvedValueOnce(true);
    await service.summarize(publicProject);
    read.mockResolvedValueOnce(publicApproval).mockResolvedValueOnce({ revokedAt: new Date(), withdrawnAt: null });
    const revoked = await service.summarize(publicProject);
    expect(revoked).toMatchObject({ hostingStatus: 'UNAVAILABLE', approvalStatus: 'WITHDRAWAL_PENDING' });
    expect(revoked.publicApplicationUrl).toBeUndefined();
    expect(revoked.publicProbePath).toBeUndefined();
    await expect(service.summarize(publicProject)).resolves.toMatchObject({ hostingStatus: 'DNS_UNVERIFIED' });
    read.mockResolvedValueOnce({ ...publicApproval, commits: [] });
    await expect(service.summarize(publicProject)).resolves.toMatchObject({
      hostingStatus: 'UNAVAILABLE', hostingError: { code: 'APPROVAL' },
    });
  });
});
