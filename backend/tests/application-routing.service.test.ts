import { describe, expect, it, vi } from 'vitest';

import { ApplicationRoutingService } from '../src/services/application-routing.service.js';
import type { CaddyAdminResponse, CaddyAdminTransport } from '../src/services/caddy-admin-transport.js';

const project = '11111111-1111-4111-8111-111111111111';
const second = '11111111-1111-4111-8111-111111111112';
const host = 'app-11111111111141118111111111111111.localhost';
const secondHost = 'app-11111111111141118111111111111112.localhost';
const container = {
  containerId: 'a'.repeat(64),
  deploymentId: '22222222-2222-4222-8222-222222222222',
  containerPort: 8080,
};
const fallback = {
  handle: [{ handler: 'static_response', status_code: 404, body: 'Unknown host' }],
  terminal: true,
};
const route = (name: string, port = 49153) => ({
  match: [{ host: [name] }],
  handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:' + String(port) }] }],
  terminal: true,
});
const tag = (sequence: number) =>
  '"/config/apps/http/servers/deployflow/routes ' + sequence.toString(16) + '"';
const reply = (status: number, body = '', etag?: string): CaddyAdminResponse => ({ status, body, etag });

function fixture(initial: unknown[] = [fallback]) {
  let current = initial;
  let sequence = 1;
  const transport = vi.fn<CaddyAdminTransport>().mockImplementation((input) => {
    if (input.method === 'GET') return Promise.resolve(reply(200, JSON.stringify(current), tag(sequence)));
    if (input.etag !== tag(sequence)) return Promise.resolve(reply(412));
    current = JSON.parse(input.body) as unknown[];
    sequence += 1;
    return Promise.resolve(reply(200));
  });
  const docker = { inspectLoopbackRoutingPort: vi.fn().mockResolvedValue(49153) };
  return { service: new ApplicationRoutingService(transport, 'localhost', docker), transport, docker };
}

describe('ApplicationRoutingService', () => {
  it('uses exact hosts and the inspected port, serializes projects, and preserves the final 404', async () => {
    const { service, transport, docker } = fixture();
    await Promise.all([service.upsert(project, container), service.upsert(second, container)]);
    await service.remove(project);
    expect(docker.inspectLoopbackRoutingPort).toHaveBeenCalledWith(container);
    const writes = transport.mock.calls.flatMap(([input]) =>
      input.method === 'PATCH' ? [{ etag: input.etag, routes: JSON.parse(input.body) as unknown }] : []);
    const revisions = writes.map((write) => {
      const routes = write.routes as Record<string, unknown>[];
      const { '@id': revision, ...last } = routes.at(-1) ?? {};
      expect(last).toEqual(fallback);
      expect(revision).toMatch(/^deployflow-revision-[a-f0-9]{32}$/);
      return revision;
    });
    expect(new Set(revisions).size).toBe(3);
    expect(writes.map(({ etag, routes }) => ({ etag, routes: (routes as unknown[]).slice(0, -1) }))).toEqual([
      { etag: tag(1), routes: [route(host)] },
      { etag: tag(2), routes: [route(host), route(secondHost)] },
      { etag: tag(3), routes: [route(secondHost)] },
    ]);
    expect(transport.mock.calls.map(([input]) => input.method))
      .toEqual(['GET', 'PATCH', 'GET', 'GET', 'PATCH', 'GET', 'GET', 'PATCH', 'GET']);
  });

  it('avoids writes when the requested state is already present', async () => {
    const { service, transport } = fixture([route(host), fallback]);
    await service.upsert(project, container);
    await service.remove(second);
    expect(transport.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'GET']);
  });

  it.each([
    [route(host)],
    [route('*.localhost'), fallback],
    [route(host), route(host), fallback],
    [fallback, route(host), fallback],
  ].map((routes) => ({ routes })))('refuses to overwrite an invalid managed layout', async ({ routes }) => {
    const { service, transport } = fixture(routes);
    await expect(service.upsert(project, container)).rejects.toMatchObject({ code: 'invalid-config' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not send a write when Docker cannot verify the binding', async () => {
    const { service, transport, docker } = fixture();
    docker.inspectLoopbackRoutingPort.mockRejectedValueOnce(new Error('Docker refused the binding'));
    await expect(service.upsert(project, container)).rejects.toThrow('Docker refused');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([[412, 'conflict'], [400, 'rejected']] as const)(
    'reports HTTP %s without repeating the write or blocking later work',
    async (status, code) => {
      const { service, transport } = fixture();
      transport.mockResolvedValueOnce(reply(200, JSON.stringify([fallback]), tag(1)));
      transport.mockResolvedValueOnce(reply(status));
      await expect(service.upsert(project, container)).rejects.toMatchObject({ code });
      expect(transport).toHaveBeenCalledTimes(2);
      await service.upsert(second, container);
    },
  );

  it.each([true, false])('reads back using fresh requests after write acknowledgment=%s', async (acknowledged) => {
    const { service, transport } = fixture();
    let written = '';
    transport.mockResolvedValueOnce(reply(200, JSON.stringify([fallback]), tag(1)));
    transport.mockImplementationOnce((input) => {
      if (input.method === 'PATCH') written = input.body;
      return acknowledged ? Promise.resolve(reply(200)) : Promise.reject(new Error('write timed out'));
    });
    transport.mockRejectedValueOnce(new Error('empty reply from old connection'));
    transport.mockImplementationOnce(() => Promise.resolve(reply(200, written, tag(2))));
    await expect(service.upsert(project, container)).resolves.toBeUndefined();
    expect(transport.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'PATCH', 'GET', 'GET']);
    expect(transport.mock.calls[3]?.[1]).toBeLessThanOrEqual(2_000);
  });

  it('fences stale requests even when the repaired route is unchanged', async () => {
    const { service, transport } = fixture([route(host), fallback]);
    const options = { beforeWrite: vi.fn().mockResolvedValue(undefined), expectedPort: 49153 };
    await service.repair(project, container, options);
    expect(options.beforeWrite).toHaveBeenCalledOnce();
    expect(await transport({ method: 'PATCH', body: JSON.stringify([fallback]), etag: tag(1) }))
      .toMatchObject({ status: 412 });
    expect(await service.readPort(project)).toBe(49153);
  });

  it('pauses further writes after an unconfirmed update, without a blind retry', async () => {
    const { service, transport } = fixture();
    transport.mockResolvedValueOnce(reply(200, JSON.stringify([fallback]), tag(1)));
    transport.mockRejectedValueOnce(new Error('write timed out'));
    await expect(service.upsert(project, container)).rejects.toMatchObject({ code: 'uncertain' });
    const calls = transport.mock.calls.length;
    await expect(service.upsert(second, container)).rejects.toMatchObject({ code: 'uncertain' });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(transport.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(1);
  });
});
