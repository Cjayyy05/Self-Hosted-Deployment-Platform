import { describe, expect, it, vi } from 'vitest';

import { ProjectHostingService } from '../src/services/project-hosting.service.js';

const hostnameLabel = 'app-11111111111141118111111111111111';
const hostname = hostnameLabel + '.localhost';
const hosting = { origin: 'http://localhost:18083', hostnameSuffix: 'localhost', adminSocketPath: undefined };
const active = { status: 'RUNNING', hostPort: 51001 } as const;
const project = {
  hostnameLabel,
  healthCheckPath: '/health',
  activeDeployment: active,
  deployments: [{ status: 'RUNNING' as const }],
  routingOperation: null,
};

const setup = () => {
  const route = new Map([[hostname, active.hostPort]]);
  const routes = { readDashboardPorts: vi.fn<() => Promise<ReadonlyMap<string, number>>>().mockResolvedValue(route) };
  const health = { waitUntilHealthy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
  return { ...routes, ...health, service: new ProjectHostingService(routes, hosting, health) };
};

describe('project hosting status', () => {
  it('handles disabled hosting and skips Caddy for new projects and initial builds', async () => {
    const disabled = new ProjectHostingService(undefined, hosting);
    const { service, readDashboardPorts } = setup();
    const newProject = { ...project, activeDeployment: null, deployments: [] };
    await expect(disabled.summarize(newProject)).resolves.toEqual({
      localApplicationUrl: null, hostingStatus: 'DISABLED',
    });
    await expect(service.summarize(newProject)).resolves.toEqual({
      localApplicationUrl: 'http://' + hostname + ':18083', hostingStatus: 'UNAVAILABLE',
    });
    await expect(service.summarize({ ...newProject, deployments: [{ status: 'BUILDING' }] }))
      .resolves.toMatchObject({ hostingStatus: 'DEPLOYING' });
    expect(readDashboardPorts).not.toHaveBeenCalled();
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
    const { service, waitUntilHealthy, readDashboardPorts } = setup();
    await service.summarize(project);
    await service.summarize({ ...project, healthCheckPath: '/new' });
    readDashboardPorts.mockResolvedValue(new Map([[hostname, active.hostPort]]));
    await service.summarize(project);
    expect(waitUntilHealthy).toHaveBeenCalledTimes(3);
  });

  it('requires attention for unavailable admin, absent routes, and routes to the wrong deployment', async () => {
    const { service, readDashboardPorts, waitUntilHealthy } = setup();
    readDashboardPorts.mockRejectedValueOnce(new Error('Caddy stopped'));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardPorts.mockResolvedValueOnce(new Map());
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardPorts.mockResolvedValueOnce(new Map([[hostname, 51002]]));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    expect(waitUntilHealthy).not.toHaveBeenCalled();
  });

  it('requires attention when the proxy fails or the route changes during its health check', async () => {
    const { service, readDashboardPorts, waitUntilHealthy } = setup();
    waitUntilHealthy.mockRejectedValueOnce(new Error('Proxy timed out'));
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
    readDashboardPorts.mockResolvedValueOnce(new Map([[hostname, active.hostPort]]))
      .mockResolvedValueOnce(new Map());
    await expect(service.summarize(project)).resolves.toMatchObject({ hostingStatus: 'RECOVERING' });
  });

  it('returns a route-specific browser check after verified local TLS and rejects other projects', async () => {
    const publicHostname = hostnameLabel + '.apps.example.net';
    const routes = { readDashboardPorts: vi.fn().mockResolvedValue(new Map([[publicHostname, active.hostPort]])) };
    const health = { waitUntilHealthy: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectHostingService(routes, {
      origin: 'https://apps.example.net', hostnameSuffix: 'apps.example.net', adminSocketPath: '/run/caddy/admin.sock',
      publicApp: { projectId: '11111111-1111-4111-8111-111111111111', repositoryUrl: 'https://github.com/example/app',
        branch: 'main', commits: new Set() },
    }, health);
    const verified = await service.summarize(project);
    expect(verified).toMatchObject({
      localApplicationUrl: null, publicApplicationUrl: 'https://' + publicHostname, hostingStatus: 'VERIFYING_HTTPS',
    });
    expect(verified.publicProbePath).toMatch(/^\/\.well-known\/deployflow-health\/[a-f0-9]{64}$/);
    expect(health.waitUntilHealthy).toHaveBeenCalledWith({
      hostPort: 443, hostname: publicHostname, path: '/health', https: true,
    });
    await expect(service.summarize({ ...project, hostnameLabel: 'other' }))
      .resolves.toEqual({ localApplicationUrl: null, hostingStatus: 'DISABLED' });
    routes.readDashboardPorts.mockResolvedValue(new Map([[publicHostname, active.hostPort]]));
    health.waitUntilHealthy.mockRejectedValueOnce(new Error('certificate invalid'));
    const unverified = await service.summarize(project);
    expect(unverified.hostingStatus).toBe('RECOVERING');
    expect(unverified.publicProbePath).toBeUndefined();
  });
});
