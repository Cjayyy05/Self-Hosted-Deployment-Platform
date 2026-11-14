import { createHash } from 'node:crypto';

import { AppError } from './app-error.js';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const projectHostnameLabel = (id: string): string => {
  if (!uuidPattern.test(id)) throw new AppError(400, 'Project ID must be a UUID');
  return `app-${id.toLowerCase().replaceAll('-', '')}`;
};

export const localProjectUrl = (
  label: string,
  hosting: { origin: string; hostnameSuffix: string },
): string => {
  const url = new URL(hosting.origin);
  url.hostname = `${label}.${hosting.hostnameSuffix}`;
  return url.origin;
};

export const projectRouteProbe = (url: URL, path: string) => ({
  hostPort: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
  hostname: url.hostname,
  path,
  ...(url.protocol === 'https:' ? { https: true as const } : {}),
});

export const PUBLIC_PROBE_PREFIX = '/.well-known/deployflow-health/';

export const publicProbePath = (hostname: string, upstreamPort: number, healthPath: string): string =>
  PUBLIC_PROBE_PREFIX + createHash('sha256').update(JSON.stringify([hostname, upstreamPort, healthPath])).digest('hex');
