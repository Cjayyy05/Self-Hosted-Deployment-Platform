import { createServer } from 'node:http';

import { createApp } from './app.js';
import { database } from './config/database.js';
import { env } from './config/env.js';
import { attachDeploymentSocket } from './realtime/deployment-socket.js';
import { deploymentRoutingService } from './services/deployment-routing.service.js';
import { reconcilePendingPublicWithdrawals } from './services/project-approval.service.js';
import { assertPublicHostingStartup, assertReservedWorkloadPortIsPrivileged } from './services/public-hosting-safety.service.js';
import { acquireBackendMode, acquireLinuxHostGate } from './services/backend-mode.service.js';
import { buildNetworkService } from './services/build-network.service.js';
import { startPublicIngress } from './services/public-ingress.service.js';

const hostGate = await acquireLinuxHostGate();
const mode = await acquireBackendMode(env.databaseUrl, env.hosting.publicHosting !== undefined);
const modeLost = (): never => {
  console.error('The DeployFlow backend mode lock was lost');
  process.exit(1);
};
mode.on('error', modeLost);
mode.on('end', modeLost);
hostGate?.on('error', modeLost);
hostGate?.on('close', modeLost);

try {
  if (env.hosting.publicHosting !== undefined) {
    await assertReservedWorkloadPortIsPrivileged();
  }
  await assertPublicHostingStartup(undefined, undefined, undefined, undefined, async () => {
    await buildNetworkService.reconcile();
    await reconcilePendingPublicWithdrawals();
  });
} catch (error) {
  mode.removeListener('end', modeLost);
  await mode.end();
  throw error;
}

const ingress = await startPublicIngress();
ingress?.on('error', modeLost);
const app = createApp();
const server = createServer(app);
const deploymentSocket = attachDeploymentSocket(server);
let reconciliationTimer: NodeJS.Timeout | undefined;

server.listen(env.port, env.bindHost, () => {
  console.log(
    `DeployFlow API listening on ${env.bindHost}:${String(env.port)}`,
  );
});

if (deploymentRoutingService !== undefined || env.hosting.publicHosting !== undefined) {
  let recovering = false;
  const resolveRouting = async () => {
    await reconcilePendingPublicWithdrawals();
    if (env.hosting.publicHosting !== undefined) await buildNetworkService.reconcile();
    await deploymentRoutingService?.reconcile();
  };
  const reconcile = () => {
    if (recovering) return;
    recovering = true;
    void resolveRouting().catch(() => {
      console.warn('Deployment routing reconciliation could not read project state; it will retry');
    }).finally(() => { recovering = false; });
  };
  reconcile();
  reconciliationTimer = setInterval(reconcile, 10_000).unref();
}

const shutdown = () => {
  clearInterval(reconciliationTimer);
  // Socket.IO also closes its attached HTTP server and stops new requests.
  // Keep the mode lock until the process exits and cannot send any more work.
  void deploymentSocket.close().then(() => database.$disconnect()).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
