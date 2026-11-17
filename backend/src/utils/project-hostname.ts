import { createHash } from 'node:crypto';

import { AppError } from './app-error.js';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const projectHostnameLabel = (id: string): string => {
  if (!uuidPattern.test(id)) throw new AppError(400, 'Project ID must be a UUID');
  return `app-${id.toLowerCase().replaceAll('-', '')}`;
};

export const projectIdFromHostname = (hostname: string, suffix: string): string | undefined => {
  if (!hostname.endsWith('.' + suffix)) return undefined;
  return /^app-([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/
    .exec(hostname.slice(0, -(suffix.length + 1)))?.slice(1).join('-');
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

export type RouteTarget = { address: string; port: number };

export const publicProbePath = (hostname: string, target: RouteTarget, healthPath: string): string =>
  PUBLIC_PROBE_PREFIX + createHash('sha256').update(JSON.stringify([hostname, target.address, target.port, healthPath])).digest('hex');
