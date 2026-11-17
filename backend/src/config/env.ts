import 'dotenv/config';

import { isIP } from 'node:net';
import { posix, win32 } from 'node:path';

import { parseGitHubRepositoryUrl } from '../utils/github-repository.js';

const DEFAULT_PORT = 4000;
const DEFAULT_BIND_HOST = '127.0.0.1';
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const JWT_SECRET_EXAMPLE = 'replace-with-at-least-32-random-characters';
const WEBHOOK_SECRET_EXAMPLE =
  'replace-with-a-different-32-character-random-secret';
const OBVIOUSLY_WEAK_SECRET_PATTERN =
  /(change[-_ ]?me|replace[-_ ]?with|placeholder|example[-_ ]?secret|secret[-_ ]?here|your[-_ ]?secret)/i;

const requireValue = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }

  return value;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
};

const parseNodeEnv = (
  value: string | undefined,
): 'development' | 'test' | 'production' => {
  if (value === undefined) {
    return 'development';
  }

  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }

  throw new Error('NODE_ENV must be development, test, or production');
};

const parseBoolean = (
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean => {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

const parseBindHost = (value: string | undefined): string => {
  const host = value?.trim() ?? DEFAULT_BIND_HOST;
  const hostnamePattern =
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;

  if (isIP(host) === 0 && !hostnamePattern.test(host)) {
    throw new Error('BIND_HOST must be a valid IP address or hostname');
  }

  return host;
};

export const parseSecret = (
  name: 'JWT_SECRET' | 'GITHUB_WEBHOOK_SECRET_KEY',
  value: string | undefined,
  nodeEnv: 'development' | 'test' | 'production',
  knownPlaceholder: string,
): string => {
  const secret = requireValue(name, value).trim();

  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }

  if (
    nodeEnv !== 'test' &&
    (secret === knownPlaceholder || OBVIOUSLY_WEAK_SECRET_PATTERN.test(secret))
  ) {
    throw new Error(`${name} must be replaced with a cryptographically random value`);
  }

  return secret;
};

const parseWebhookSecretKey = (
  value: string | undefined,
  nodeEnv: 'development' | 'test' | 'production',
): string | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  return parseSecret(
    'GITHUB_WEBHOOK_SECRET_KEY',
    value,
    nodeEnv,
    WEBHOOK_SECRET_EXAMPLE,
  );
};

const parsePublicBaseUrl = (
  value: string | undefined,
  port: number,
): string => {
  const candidate = value?.trim() ?? `http://localhost:${String(port)}`;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be a valid HTTP or HTTPS origin');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('PUBLIC_BASE_URL must be a valid HTTP or HTTPS origin');
  }

  return url.origin;
};

export type HostingConfig = Readonly<{
  origin: string;
  hostnameSuffix: string;
  adminSocketPath: string | undefined;
  publicHosting?: Readonly<{ operatorId: string; legacyProjectId?: string; ingressSocketPath?: string; dnsTarget?: string }>;
  publicApp?: PublicApplication;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PublicApplication = Readonly<{
  projectId: string;
  repositoryUrl: string;
  branch: string;
  commits: ReadonlySet<string>;
}>;

const parsePublicApplication = (input: {
  projectId?: string | undefined;
  repositoryUrl?: string | undefined;
  branch?: string | undefined;
  commits?: string | undefined;
}): PublicApplication | undefined => {
  const { projectId, repositoryUrl, branch, commits } = input;
  if ([repositoryUrl, branch, commits].every((value) => value === undefined)) return undefined;
  if (!projectId ||
    !branch || branch.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) ||
    !commits || !/^[0-9a-f]{40}(?:,[0-9a-f]{40})*$/.test(commits)) {
    throw new Error('Public hosting requires an approved project UUID, Git branch, and comma-separated full Git commit hashes');
  }
  return Object.freeze({ projectId, repositoryUrl: parseGitHubRepositoryUrl(repositoryUrl).repositoryUrl, branch,
    commits: new Set(commits.split(',')) });
};

export const parseCaddyAdminSocketPath = (
  value: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const windows = platform === 'win32';
  const absolute = windows
    ? /^[a-z]:[\\/]/i.test(value) && !/[:*?"<>]/.test(value.slice(2))
    : /^\/[^/]/.test(value);
  const path = windows ? win32.normalize(value) : posix.normalize(value);
  if (
    !absolute ||
    value.includes('|') ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    value.split(windows ? /[\\/]/ : '/').some((part) => part === '.' || part === '..') ||
    path.endsWith(windows ? '\\' : '/') ||
    Buffer.byteLength(path) > 107
  ) {
    throw new Error('CADDY_ADMIN_SOCKET must be an absolute local Unix socket file path of at most 107 bytes');
  }
  return path;
};

export const parseHostingConfig = (
  input: {
    origin?: string | undefined;
    hostnameSuffix?: string | undefined;
    adminSocketPath?: string | undefined;
    publicHostingEnabled?: boolean | undefined;
    publicOperatorId?: string | undefined;
    publicIngressSocket?: string | undefined;
    publicDnsTarget?: string | undefined;
    publicProjectId?: string | undefined;
    publicRepositoryUrl?: string | undefined;
    publicBranch?: string | undefined;
    publicCommits?: string | undefined;
  },
  platform: NodeJS.Platform = process.platform,
): HostingConfig => {
  const origin = input.origin?.trim() ?? 'http://localhost:8080';
  const hostnameSuffix = input.hostnameSuffix?.trim().toLowerCase() ?? 'localhost';
  if (
    hostnameSuffix.length > 216 ||
    isIP(hostnameSuffix) !== 0 ||
    !hostnameSuffix.split('.').every((label) => DNS_LABEL.test(label))
  ) {
    throw new Error('APP_HOSTNAME_SUFFIX must be a DNS suffix that fits after a project label');
  }
  const socket = input.adminSocketPath?.trim();
  const legacyProjectId = input.publicProjectId?.toLowerCase();
  if (legacyProjectId !== undefined && !UUID_PATTERN.test(legacyProjectId)) {
    throw new Error('APP_PUBLIC_PROJECT_ID must be a project UUID');
  }
  const publicApp = parsePublicApplication({ projectId: legacyProjectId,
    repositoryUrl: input.publicRepositoryUrl, branch: input.publicBranch, commits: input.publicCommits });
  const publicEnabled = input.publicHostingEnabled ?? publicApp !== undefined;
  if (publicEnabled) {
    const operatorId = input.publicOperatorId?.toLowerCase();
    if (operatorId === undefined || !UUID_PATTERN.test(operatorId)) {
      throw new Error('APP_PUBLIC_OPERATOR_ID must be the existing operator user UUID');
    }
    if (platform !== 'linux' || !socket || origin !== `https://${hostnameSuffix}` ||
      !hostnameSuffix.includes('.') || /\.(localhost|local|internal|invalid|test|example)$/.test(hostnameSuffix)) {
      throw new Error('Public hosting requires Linux, a private Caddy socket, and an HTTPS origin matching APP_HOSTNAME_SUFFIX');
    }
    const adminSocketPath = parseCaddyAdminSocketPath(socket, platform);
    const dnsTarget = input.publicDnsTarget?.trim().toLowerCase() ?? hostnameSuffix;
    if (dnsTarget.length > 253 || !dnsTarget.includes('.') || isIP(dnsTarget) !== 0 ||
      !dnsTarget.split('.').every((label) => DNS_LABEL.test(label))) {
      throw new Error('APP_PUBLIC_DNS_TARGET must be the hostname whose A record points to the public server');
    }
    const ingressSocketPath = input.publicIngressSocket === undefined ? undefined
      : parseCaddyAdminSocketPath(input.publicIngressSocket, platform);
    if (adminSocketPath === (ingressSocketPath ?? '/run/deployflow-ingress/auth.sock')) {
      throw new Error('Public ingress and Caddy administration require separate sockets');
    }
    return Object.freeze({
      origin, hostnameSuffix, adminSocketPath,
      publicHosting: Object.freeze({ operatorId, dnsTarget, ...(legacyProjectId === undefined ? {} : { legacyProjectId }),
        ...(ingressSocketPath === undefined ? {} : { ingressSocketPath }) }),
      ...(publicApp === undefined ? {} : { publicApp }),
    });
  }
  if (legacyProjectId !== undefined || input.publicOperatorId !== undefined || input.publicIngressSocket !== undefined ||
    input.publicDnsTarget !== undefined || publicApp !== undefined) {
    throw new Error('Public hosting settings require APP_PUBLIC_HOSTING_ENABLED=true or a complete legacy approval');
  }
  const match = /^http:\/\/(localhost|127\.0\.0\.1)(?::([1-9]\d{0,4}))?\/?$/.exec(origin);
  if (match === null || (match[2] !== undefined && Number(match[2]) > 65_535)) {
    throw new Error('APP_HOSTING_ORIGIN must be a local HTTP origin on localhost or 127.0.0.1');
  }
  return Object.freeze({
    origin: new URL(origin).origin,
    hostnameSuffix,
    adminSocketPath: socket ? parseCaddyAdminSocketPath(socket, platform) : undefined,
  });
};

const port = parsePort(process.env.PORT);
const nodeEnv = parseNodeEnv(process.env.NODE_ENV);

export const env = Object.freeze({
  bindHost: parseBindHost(process.env.BIND_HOST),
  hosting: parseHostingConfig({
    origin: process.env.APP_HOSTING_ORIGIN,
    hostnameSuffix: process.env.APP_HOSTNAME_SUFFIX,
    adminSocketPath: process.env.CADDY_ADMIN_SOCKET,
    publicHostingEnabled: process.env.APP_PUBLIC_HOSTING_ENABLED === undefined ? undefined :
      parseBoolean('APP_PUBLIC_HOSTING_ENABLED', process.env.APP_PUBLIC_HOSTING_ENABLED, false),
    publicOperatorId: process.env.APP_PUBLIC_OPERATOR_ID,
    publicIngressSocket: process.env.APP_PUBLIC_INGRESS_SOCKET,
    publicDnsTarget: process.env.APP_PUBLIC_DNS_TARGET,
    publicProjectId: process.env.APP_PUBLIC_PROJECT_ID,
    publicRepositoryUrl: process.env.APP_PUBLIC_REPOSITORY_URL,
    publicBranch: process.env.APP_PUBLIC_BRANCH,
    publicCommits: process.env.APP_PUBLIC_COMMITS,
  }),
  databaseUrl: requireValue('DATABASE_URL', process.env.DATABASE_URL),
  githubWebhookSecretKey: parseWebhookSecretKey(
    process.env.GITHUB_WEBHOOK_SECRET_KEY,
    nodeEnv,
  ),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
  jwtSecret: parseSecret(
    'JWT_SECRET',
    process.env.JWT_SECRET,
    nodeEnv,
    JWT_SECRET_EXAMPLE,
  ),
  nodeEnv,
  port,
  publicBaseUrl: parsePublicBaseUrl(process.env.PUBLIC_BASE_URL, port),
  registrationEnabled: parseBoolean(
    'REGISTRATION_ENABLED',
    process.env.REGISTRATION_ENABLED,
    false,
  ),
});

if (env.hosting.publicHosting !== undefined && (env.bindHost !== DEFAULT_BIND_HOST || env.registrationEnabled ||
  env.githubWebhookSecretKey !== undefined || process.env.DOCKER_HOST !== undefined ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')) {
  throw new Error('Public hosting requires private API binding, disabled registration and webhooks, local Docker, and TLS verification');
}
