import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout } from 'node:timers/promises';

import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import { projectHostnameLabel } from '../utils/project-hostname.js';
import { workloadAddress } from '../utils/workload-address.js';
import { DEFAULT_INGRESS_SOCKET } from './application-routing.service.js';
import { PublicApplicationPolicy } from './public-application-policy.js';

export async function authorizePublicIngress(host: unknown, target: unknown, hosting: HostingConfig = env.hosting, db = database) {
  const projectId = hosting.publicHosting?.routeProjectId;
  if (projectId === undefined || host !== projectHostnameLabel(projectId) + '.' + hosting.hostnameSuffix ||
    typeof target !== 'string') return false;
  return db.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: projectId }, include: { activeDeployment: true, routingDeployment: true },
    });
    if (project === null) return false;
    const liveLease = project.operationLockToken !== null && project.operationLockExpiresAt !== null &&
      project.operationLockExpiresAt.getTime() > Date.now();
    const eligible = liveLease && (project.routingOperation === 'PROMOTE' || project.routingOperation === 'RESTART')
      ? [project.activeDeployment, project.routingDeployment] : [project.activeDeployment];
    const chosen = eligible.find((candidate) => candidate?.containerId != null &&
      candidate.publicAddressIndex !== null && candidate.hostPort !== null &&
      target === workloadAddress(candidate.publicAddressIndex) + ':' + String(candidate.hostPort));
    if (chosen == null) return false;
    await new PublicApplicationPolicy(hosting, db).assertApproved(project, chosen.commitHash, tx);
    return true;
  }, { isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 800 });
}

export async function startPublicIngress(hosting: HostingConfig = env.hosting) {
  if (hosting.publicHosting?.routeProjectId === undefined) return undefined;
  const path = hosting.publicHosting.ingressSocketPath ?? DEFAULT_INGRESS_SOCKET;
  try {
    if (!(await lstat(path)).isSocket()) throw new Error('The public ingress path is not a socket');
    await new Promise<void>((resolve, reject) => {
      const peer = createConnection(path);
      peer.once('connect', () => peer.destroy(new Error('The public ingress socket already has a listener')));
      peer.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
      peer.setTimeout(1_000, () => peer.destroy(new Error('The existing public ingress socket could not be verified')));
    });
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const server = createServer((req, res) => {
    const respond = (status: number) => {
      res.writeHead(status, { 'Cache-Control': 'no-store' });
      res.end();
    };
    if (req.method !== 'GET' || req.url !== '/authorize') { respond(404); return; }
    const deadline = new AbortController();
    void Promise.race([
      authorizePublicIngress(req.headers['x-deployflow-host'], req.headers['x-deployflow-target'], hosting),
      setTimeout(1_000, false, { signal: deadline.signal }),
    ]).then((allowed) => { respond(allowed ? 204 : 404); }, () => { respond(404); })
      .finally(() => { deadline.abort(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o660);
  return server;
}
