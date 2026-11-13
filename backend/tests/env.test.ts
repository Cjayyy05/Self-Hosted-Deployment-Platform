import { describe, expect, it } from 'vitest';

import { parseHostingConfig, parseSecret } from '../src/config/env.js';

describe('secret configuration', () => {
  it.each([
    [
      'JWT_SECRET' as const,
      'replace-with-at-least-32-random-characters',
    ],
    [
      'GITHUB_WEBHOOK_SECRET_KEY' as const,
      'replace-with-a-different-32-character-random-secret',
    ],
    ['JWT_SECRET' as const, 'this-is-an-obvious-placeholder-secret-value'],
  ])('rejects an insecure %s placeholder', (name, value) => {
    expect(() => parseSecret(name, value, 'production', value)).toThrow(
      `${name} must be replaced with a cryptographically random value`,
    );
  });

  it('accepts a sufficiently long random-looking value', () => {
    const secret = 'iR8RkCNVp2QdUF87x2dHq3QzrB3h1K8mFzR9dQ4sY1A';

    expect(
      parseSecret('JWT_SECRET', secret, 'production', 'not-this-value'),
    ).toBe(secret);
  });
});

describe('local hosting configuration', () => {
  it('reserves a local address and disables admin by default', () => {
    expect(parseHostingConfig({})).toEqual({
      origin: 'http://localhost:8080',
      hostnameSuffix: 'localhost',
      adminSocketPath: undefined,
    });
  });

  it('accepts absolute private socket paths for Windows and Linux', () => {
    expect(parseHostingConfig({
      hostnameSuffix: 'Apps.Localhost',
      origin: 'http://127.0.0.1:8180/',
      adminSocketPath: 'C:/private/admin.sock',
    }, 'win32')).toEqual({
      hostnameSuffix: 'apps.localhost',
      origin: 'http://127.0.0.1:8180',
      adminSocketPath: 'C:\\private\\admin.sock',
    });
    expect(parseHostingConfig({ adminSocketPath: '/run/caddy/admin.sock' }, 'linux').adminSocketPath)
      .toBe('/run/caddy/admin.sock');
  });

  it.each([
    'http://example.com:8080',
    'https://localhost:8080',
    'http://localhost:0',
    'http://localhost:65536',
    'http://localhost:8080/path',
    'http://localhost:8080/#',
  ])('rejects an invalid local hosting origin %s', (origin) => {
    expect(() => parseHostingConfig({ origin })).toThrow('APP_HOSTING_ORIGIN');
  });

  it.each(['*.localhost', '127.0.0.1', 'foo..localhost', 'foo.localhost.'])(
    'rejects an invalid hostname suffix %s', (hostnameSuffix) => {
      expect(() => parseHostingConfig({ hostnameSuffix })).toThrow('APP_HOSTNAME_SUFFIX');
    },
  );

  it.each([
    ['tcp://127.0.0.1:2019', 'win32'],
    ['\\\\host\\share\\admin.sock', 'win32'],
    ['C:\\private\\..\\admin.sock', 'win32'],
    ['/run/admin.sock|0660', 'linux'],
    ['/run/' + 'x'.repeat(108), 'linux'],
  ] as const)('rejects an invalid admin socket %s', (adminSocketPath, platform) => {
    expect(() => parseHostingConfig({ adminSocketPath }, platform)).toThrow('CADDY_ADMIN_SOCKET');
  });
});
