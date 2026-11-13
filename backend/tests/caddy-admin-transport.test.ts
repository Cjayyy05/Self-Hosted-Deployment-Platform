import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCaddyAdminTransport } from '../src/services/caddy-admin-transport.js';

const path = '/config/apps/http/servers/deployflow/routes';
const etag = '"' + path + ' 1234abcd"';

describe('Caddy admin transport input limits', () => {
  it('refuses TCP endpoints', () => {
    expect(() => createCaddyAdminTransport('http://127.0.0.1:2019')).toThrow('CADDY_ADMIN_SOCKET');
  });

  it('rejects injected ETags and oversized updates before opening the socket', async () => {
    const transport = createCaddyAdminTransport(process.platform === 'win32' ? 'C:\\df\\admin.sock' : '/tmp/admin.sock');
    await expect(transport({ method: 'PATCH', body: '[]', etag: etag + '\r\nHost: invalid' }))
      .rejects.toThrow('invalid ETag');
    await expect(transport({ method: 'PATCH', body: 'x'.repeat(1024 * 1024 + 1), etag }))
      .rejects.toThrow('request limits');
  });
});

describe.skipIf(process.platform === 'win32')('native Unix-socket admin transport', () => {
  it('uses fresh Unix connections, forwards If-Match, and bounds responses and time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'df-caddy-'));
    const socket = join(directory, 'admin.sock');
    let requests = 0;
    let connections = 0;
    const seen: { path: string | undefined; etag: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      requests += 1;
      if (requests === 3) {
        res.end('x'.repeat(1024 * 1024 + 1));
      } else if (requests !== 4) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          seen.push({ path: req.url, etag: req.headers['if-match'], body });
          res.setHeader('etag', etag);
          res.end('[]');
        });
      }
    });
    server.on('connection', () => { connections += 1; });
    try {
      server.listen(socket);
      await once(server, 'listening');
      const transport = createCaddyAdminTransport(socket);
      await expect(transport({ method: 'GET' })).resolves.toEqual({ status: 200, body: '[]', etag });
      await expect(transport({ method: 'PATCH', etag, body: '[]' })).resolves.toMatchObject({ status: 200 });
      expect(seen).toEqual([{ path, etag: undefined, body: '' }, { path, etag, body: '[]' }]);
      await expect(transport({ method: 'GET' })).rejects.toThrow('size limit');
      await expect(transport({ method: 'GET' }, 100)).rejects.toThrow('timed out');
      expect(connections).toBe(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
