import { createServer } from 'node:http';

import { createApp } from './app.js';
import { database } from './config/database.js';
import { env } from './config/env.js';
import { attachDeploymentSocket } from './realtime/deployment-socket.js';
import { deploymentRoutingService } from './services/deployment-routing.service.js';

const app = createApp();
const server = createServer(app);
const deploymentSocket = attachDeploymentSocket(server);
let reconciliationTimer: NodeJS.Timeout | undefined;

if (env.hosting.publicApp !== undefined) {
  await database.$queryRaw`SELECT 1`;
}

server.listen(env.port, env.bindHost, () => {
  console.log(
    `DeployFlow API listening on ${env.bindHost}:${String(env.port)}`,
  );
});

if (deploymentRoutingService !== undefined) {
  const routing = deploymentRoutingService;
  const reconcile = () => {
    void routing.reconcile().catch(() => {
      console.warn('Deployment routing reconciliation could not read project state; it will retry');
    });
  };
  reconcile();
  reconciliationTimer = setInterval(reconcile, 10_000).unref();
}

const shutdown = () => {
  clearInterval(reconciliationTimer);
  // Socket.IO also closes its attached HTTP server and stops new requests.
  void deploymentSocket.close().then(() => database.$disconnect()).catch(() => {
    process.exitCode = 1;
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
