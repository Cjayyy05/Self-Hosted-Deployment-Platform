import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/utils/app-error.js';
import { ApplicationRoutingError } from '../src/services/application-routing.service.js';
import { DeploymentRoutingService } from '../src/services/deployment-routing.service.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const oldId = '22222222-2222-4222-8222-222222222222';
const newId = '33333333-3333-4333-8333-333333333333';
const oldContainer = 'a'.repeat(64);
const newContainer = 'b'.repeat(64);
const token = '44444444-4444-4444-8444-444444444444';
const started = new Date('2026-11-13T00:00:00Z');
type Operation = 'PROMOTE' | 'ABORT' | 'RETIRE' | 'RESTART' | 'STOP' | 'DELETE' | null;
type Row = {
  id: string; projectId: string; containerId: string; hostPort: number | null; status: string;
};
type Target = { containerId: string };
type Options = { beforeWrite?: () => Promise<void> };

function harness(previous = true) {
  const project = {
    id: projectId, healthCheckPath: '/', containerPort: 8080,
    activeDeploymentId: previous ? oldId : null as string | null,
    routingOperation: null as Operation, routingDeploymentId: null as string | null,
  };
  const previousRow: Row = { id: oldId, projectId, containerId: oldContainer, hostPort: 50001, status: 'RUNNING' };
  const candidate: Row = { id: newId, projectId, containerId: newContainer, hostPort: 50002, status: 'HEALTHCHECKING' };
  const rows = new Map([[oldId, previousRow], [newId, candidate]]);
  const ports = new Map([[oldContainer, 50001], [newContainer, 50002]]);
  const running = new Set([oldContainer, newContainer]);
  let route = previous ? 50001 : null as number | null;
  let transactionFault: 'before' | 'after' | undefined;
  const events: string[] = [];
  const projectModel = {
    findUnique: () => Promise.resolve({ ...project }),
    findMany: () => Promise.resolve([{ id: projectId }]),
    updateMany: vi.fn(({ where, data }: {
      where: { operationLockToken: string; activeDeploymentId: string | null;
        routingOperation: Operation; routingDeploymentId: string | null };
      data: Partial<typeof project>;
    }) => {
      if (where.operationLockToken !== token ||
        where.activeDeploymentId !== project.activeDeploymentId ||
        where.routingOperation !== project.routingOperation ||
        where.routingDeploymentId !== project.routingDeploymentId) return Promise.resolve({ count: 0 });
      Object.assign(project, data);
      return Promise.resolve({ count: 1 });
    }),
  };
  const deploymentModel = {
    findFirst: ({ where }: { where: { id: string } }) => Promise.resolve(rows.get(where.id) ?? null),
    update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const existing = rows.get(where.id);
      if (existing === undefined) return Promise.reject(new Error('Missing row'));
      Object.assign(existing, data);
      return Promise.resolve({ ...existing });
    },
  };
  const db = {
    project: projectModel,
    deployment: deploymentModel,
    $transaction: async <T>(callback: (client: { project: typeof projectModel; deployment: typeof deploymentModel }) => Promise<T>) => {
      const fault = transactionFault;
      transactionFault = undefined;
      if (fault === 'before') throw new Error('database did not commit');
      const result = await callback({ project: projectModel, deployment: deploymentModel });
      events.push('commit');
      if (fault === 'after') throw new Error('database committed but acknowledgment was lost');
      return result;
    },
  };
  const readPort = vi.fn(() => Promise.resolve(route));
  const write = async (_id: string, target?: Target, options?: Options) => {
    await options?.beforeWrite?.();
    route = target === undefined ? null : ports.get(target.containerId) ?? null;
    events.push('route:' + String(route));
  };
  const routes = {
    readPort, upsert: vi.fn(write), repair: vi.fn(write),
    readDashboardTargets: () => Promise.resolve(new Map()),
    readTarget: () => Promise.resolve(route === null ? null : { address: '127.0.0.1', port: route }),
    remove: vi.fn((id: string, options?: Options) => write(id, undefined, options)),
  };
  const lease = { token, assertValid: vi.fn().mockResolvedValue(undefined) };
  const stop = vi.fn((id: string) => {
    expect(route).not.toBe(ports.get(id));
    events.push('stop:' + id);
    running.delete(id);
    return Promise.resolve({ containerId: id, running: false, status: 'exited' });
  });
  const inspectStatus = (id: string) => ports.has(id)
    ? Promise.resolve({ containerId: id, running: running.has(id), status: running.has(id) ? 'running' : 'exited' })
    : Promise.reject(new AppError(404, 'Missing container'));
  const inspectOwnedDeploymentContainer = vi.fn(inspectStatus);
  const inspectLoopbackRoutingPort = vi.fn(({ containerId }: Target) => Promise.resolve(ports.get(containerId) ?? 0));
  const containers = {
    inspectStatus, inspectOwnedDeploymentContainer, inspectLoopbackRoutingPort,
    stopContainer: stop,
    removeDeploymentContainers: vi.fn().mockResolvedValue(undefined),
    restartContainer: (id: string) => {
      running.add(id);
      return Promise.resolve({ containerId: id, running: true, status: 'running', hostPort: ports.get(id) ?? 0 });
    },
  };
  const health = { waitUntilHealthy: vi.fn().mockResolvedValue(undefined) };
  const lock = {
    runExclusive: <T>(_id: string, operation: (held?: typeof lease) => Promise<T>) => operation(lease),
  };
  const makeService = () => new DeploymentRoutingService(
    routes, db as unknown as ConstructorParameters<typeof DeploymentRoutingService>[1],
    containers, health, lock, { origin: 'http://localhost:8080', hostnameSuffix: 'localhost', adminSocketPath: undefined },
  );
  return {
    service: makeService(), makeService, project, candidate, previousRow, ports, running, lease, events, routes, health, stop,
    inspectOwnedDeploymentContainer, inspectLoopbackRoutingPort,
    setRoute: (port: number | null) => { route = port; },
    failTransaction: (fault: 'before' | 'after') => { transactionFault = fault; },
  };
}

describe('deployment routing state transitions', () => {
  it('commits an initial deployment without selecting legacy RUNNING history', async () => {
    const h = harness(false);
    await expect(h.service.promote(h.candidate, started, h.lease)).resolves.toMatchObject({ status: 'RUNNING' });
    expect(h.project.activeDeploymentId).toBe(newId);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.health.waitUntilHealthy).toHaveBeenCalledWith(expect.objectContaining({ hostPort: 8080 }));
  });

  it('retires the previous active container after verified route and database commit', async () => {
    const h = harness();
    await h.service.promote(h.candidate, started, h.lease);
    expect(h.events.indexOf('route:50002')).toBeLessThan(h.events.indexOf('commit'));
    expect(h.events.indexOf('commit')).toBeLessThan(h.events.indexOf('stop:' + oldContainer));
    expect(h.project).toMatchObject({ activeDeploymentId: newId, routingOperation: null });
    expect(h.previousRow.status).toBe('STOPPED');
  });

  it.each(['rejected', 'uncertain'] as const)('repairs the prior route after a %s Caddy write', async (code) => {
    const h = harness();
    h.routes.upsert.mockImplementationOnce(() => {
      if (code === 'uncertain') h.setRoute(50002);
      return Promise.reject(new ApplicationRoutingError(code, 'failed update'));
    });
    await expect(h.service.promote(h.candidate, started, h.lease)).rejects.toMatchObject({ statusCode: 502 });
    expect(await h.routes.readPort()).toBe(50001);
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(newContainer);
    expect(h.project).toMatchObject({ activeDeploymentId: oldId, routingOperation: null });
  });

  it('retains both containers while an uncertain route cannot be repaired, then recovers on a new coordinator', async () => {
    const h = harness();
    h.routes.upsert.mockImplementationOnce(() => {
      h.setRoute(50002);
      return Promise.reject(new ApplicationRoutingError('uncertain', 'lost Caddy response'));
    });
    h.routes.repair.mockRejectedValueOnce(new Error('Caddy unavailable'));
    await expect(h.service.promote(h.candidate, started, h.lease)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.project).toMatchObject({ activeDeploymentId: oldId, routingOperation: 'ABORT', routingDeploymentId: newId });
    const recovery = h.makeService();
    await recovery.reconcile();
    await recovery.reconcile();
    expect(await h.routes.readPort()).toBe(50001);
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(newContainer);
  });

  it.each(['before', 'after'] as const)('checks PostgreSQL after a failure %s commit', async (fault) => {
    const h = harness();
    h.failTransaction(fault);
    if (fault === 'after') {
      await expect(h.service.promote(h.candidate, started, h.lease)).resolves.toMatchObject({ id: newId });
      expect(h.project.activeDeploymentId).toBe(newId);
      expect(h.stop).toHaveBeenCalledExactlyOnceWith(oldContainer);
    } else {
      await expect(h.service.promote(h.candidate, started, h.lease)).rejects.toMatchObject({ statusCode: 502 });
      expect(h.project.activeDeploymentId).toBe(oldId);
      expect(h.stop).toHaveBeenCalledExactlyOnceWith(newContainer);
    }
  });

  it('persists the former target if retirement fails and retries only after restoring the committed target', async () => {
    const h = harness();
    h.stop.mockRejectedValueOnce(new Error('Docker unavailable'));
    const logging = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await h.service.promote(h.candidate, started, h.lease);
    expect(logging).toHaveBeenCalled();
    expect(h.project).toMatchObject({ activeDeploymentId: newId, routingOperation: 'RETIRE', routingDeploymentId: oldId });
    h.setRoute(null);
    await h.makeService().reconcile();
    expect(await h.routes.readPort()).toBe(50002);
    expect(h.project.routingOperation).toBeNull();
    expect(h.previousRow.status).toBe('STOPPED');
  });

  it('withholds an active stop when Caddy withdrawal cannot be confirmed', async () => {
    const h = harness();
    h.routes.repair.mockRejectedValueOnce(new Error('Caddy unavailable'));
    await expect(h.service.stop(projectId, oldId, h.lease)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.stop).not.toHaveBeenCalled();
    await h.makeService().reconcile();
    expect(await h.routes.readPort()).toBeNull();
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(oldContainer);
    expect(h.project.activeDeploymentId).toBeNull();
  });

  it('stops a restarting deployment during reconciliation with no published port', async () => {
    const h = harness();
    h.inspectOwnedDeploymentContainer.mockResolvedValue({ containerId: oldContainer, status: 'restarting', running: true });
    h.inspectLoopbackRoutingPort.mockRejectedValue(new Error('Container has no live binding'));
    h.stop.mockRejectedValueOnce(new Error('Docker unavailable after withdrawal'));
    await expect(h.service.stop(projectId, oldId, h.lease)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.project.routingOperation).toBe('STOP');
    expect(await h.routes.readPort()).toBeNull();

    const recovery = h.makeService();
    await recovery.reconcile();
    expect(h.inspectLoopbackRoutingPort).not.toHaveBeenCalled();
    expect(h.running.has(oldContainer)).toBe(false);
    expect(h.running.has(newContainer)).toBe(true);
    expect(h.previousRow.status).toBe('STOPPED');
    expect(h.project).toMatchObject({ activeDeploymentId: null, routingOperation: null, routingDeploymentId: null });
    await expect(recovery.assertIdle(projectId, h.lease)).resolves.toBeUndefined();
  });

  it('leaves the verified active route alone when stopping a restarting historical container', async () => {
    const h = harness();
    h.inspectOwnedDeploymentContainer.mockResolvedValue({ containerId: newContainer, status: 'restarting', running: true });
    await expect(h.service.stop(projectId, newId, h.lease)).resolves.toMatchObject({ status: 'STOPPED' });
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(newContainer);
    expect(await h.routes.readPort()).toBe(50001);
    expect(h.project).toMatchObject({ activeDeploymentId: oldId, routingOperation: null });
  });

  it('leaves a different active route alone during a historical restart', async () => {
    const h = harness();
    await expect(h.service.beginRestart(projectId, newId, h.lease)).resolves.toBe(false);
    expect(h.routes.repair).not.toHaveBeenCalled();
    expect(await h.routes.readPort()).toBe(50001);
  });

  it('restores a surviving active container if deletion fails after withdrawal', async () => {
    const h = harness();
    await expect(h.service.beginDelete(projectId, h.lease)).resolves.toMatchObject({ containerId: oldContainer });
    h.running.delete(oldContainer);
    await expect(h.service.deleteFailed(projectId, h.lease)).resolves.toBe(true);
    expect(h.running.has(oldContainer)).toBe(true);
    expect(await h.routes.readPort()).toBe(50001);
    expect(h.project).toMatchObject({ activeDeploymentId: oldId, routingOperation: null });
  });

  it('withdraws a missing target and restores only its committed identity on a changed port', async () => {
    const h = harness();
    h.ports.delete(oldContainer);
    await h.service.reconcile();
    expect(await h.routes.readPort()).toBeNull();
    expect(h.project.activeDeploymentId).toBe(oldId);
    h.ports.set(oldContainer, 50004);
    await h.service.reconcile();
    expect(await h.routes.readPort()).toBe(50004);
    expect(h.previousRow.hostPort).toBe(50004);
  });
});
