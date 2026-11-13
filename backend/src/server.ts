import { createServer } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { attachDeploymentSocket } from './realtime/deployment-socket.js';
import { deploymentRoutingService } from './services/deployment-routing.service.js';

const app = createApp();
const server = createServer(app);
attachDeploymentSocket(server);

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
  setInterval(reconcile, 10_000).unref();
}
