# Local application hosting

Each project has a permanent hostname label derived from its UUID. The dashboard shows the reserved URL as **Local only · HTTP** and enables **Open Application** after confirming that Caddy routes to the active deployment and the application answers its health check. Public DNS and HTTPS require a separate hosting setup.

For the single-instance Ubuntu and EC2 setup, see the [EC2 hosting runbook](aws-ec2-hosting.md).

## Configuration

Set `APP_HOSTING_ORIGIN=http://localhost:8080` for the listener's HTTP scheme and port, and `APP_HOSTNAME_SUFFIX=localhost` for the project hostnames. For example, the project with UUID `11111111-1111-4111-8111-111111111111` reserves `http://app-11111111111141118111111111111111.localhost:8080`. An alternate suffix requires local name resolution to the loopback listener. Keep `CADDY_ADMIN_SOCKET` unset if the local hosting configuration is disabled.

Run `npm run prisma:migrate:deploy` from `backend` against the intended PostgreSQL database before running the updated backend. The required hosting migrations are `20261113000000_project_hostname_label`, which backfills the hostname label, and `20261113010000_deployment_routing_state`, which adds the active and pending routing references. Existing projects get a route after a successful deploy, rollback, or explicit restart. Back up persistent data before applying pending migrations.

## Run Caddy on the same host as Docker

Use stock Caddy 2.11.9 or a newer compatible, security-patched release. Run a dedicated instance with [the JSON bootstrap](../infra/caddy/bootstrap.json). The server named `deployflow` listens on IPv4 loopback with automatic HTTPS disabled. Adjust its port in the bootstrap copy to match `APP_HOSTING_ORIGIN`. The final route returns `404` for unknown hosts. The routing service owns this server's route list. Keep other traffic in a separate Caddy server or instance.

On Linux, create a private runtime directory owned by the Caddy identity and a dedicated group containing the backend identity. Set its mode to `2750` so the Caddy user can create the socket and the group can traverse the directory. The bootstrap's `|0660` applies to the socket file. Set `CADDY_ADMIN_SOCKET=/run/deployflow-caddy/admin.sock` in the backend environment. Use the filesystem path alone in the backend setting.

On Windows, put the socket in a newly created NTFS directory whose ACL grants access only to the trusted Windows account and `SYSTEM`. Apply the ACL before starting Caddy, then inspect the directory and socket ACLs, including after a reload. With both Caddy and the backend running as the trusted account, set `CADDY_ADMIN_SOCKET` to the full local socket path. Copy the bootstrap and set `admin.listen` in the copy to `unix/` plus that path. The Windows transport invokes the system `curl.exe` with `--unix-socket`; `curl.exe --version` must list `UnixSockets`. Linux uses Node HTTP `socketPath`.

Validate and start the bootstrap copy with `caddy validate --config <config.json>` and `caddy run --config <config.json>`. Check that Caddy exposes only the local application listener. The socket directory and Docker daemon socket must stay outside workload mounts. Docker Desktop can make the application listener reachable from a bridge container through its host gateway even when bound to Windows loopback.

## Deploy from the dashboard

With Docker, PostgreSQL, and Caddy running, start the backend and frontend from their respective directories using `npm run dev`. Bind the frontend to loopback with `npm run dev -- --hostname 127.0.0.1` for a local-only setup. For a Windows production build, run `npm run build -- --webpack` in `frontend`, then `npm run start -- --hostname 127.0.0.1`. The default Turbopack build can fail while starting the CSS worker for `src/app/globals.css`.

1. Sign in at `http://localhost:3000`. Create a project with a trusted public GitHub repository, branch, container port, and an optional health-check path.
2. Open the project and select **Deploy**. The dashboard displays the reserved URL immediately. **Open Application** appears when the status becomes **Available**.
3. Select **Redeploy** to build the configured branch again, or select **Rollback** next to a previous successful deployment in history. The URL stays the same. During a replacement, the latest attempt shows its progress while the previous healthy route remains usable. If the attempt fails, the active version and its link stay available as long as routing is confirmed.
4. **Stop** withdraws the active route and **Restart** starts the deployment again at the same URL. A visible dashboard refreshes about every five seconds, including after signed webhook deployments. The backend shares Caddy status checks for up to three seconds, so an external outage can take a few seconds to appear.

For a manual smoke test, repeat the sequence on two projects with distinct content. Check that each opens the expected version, an unknown hostname returns `404`, and stopping Caddy removes **Open Application** until recovery confirms the route again.

## Route updates and recovery

Run one backend writer per dedicated Caddy instance. Deploy, redeploy, rollback, and signed webhooks share promotion after direct application health checks. DeployFlow verifies the local Docker binding, applies the route, reads it back, and probes the application through Caddy before committing the new active deployment. A separate durable retirement operation identifies the former active container until Docker stop and its history update finish. A deployment's `RUNNING` status alone cannot select its route.

DeployFlow uses Caddy's ETag for compare-and-set on the managed route list. A unique revision on the fallback route changes the ETag even when recovery reinstalls the same upstream. HTTP `412` means the snapshot was stale. After a lost write response, DeployFlow reads back the config with fresh connections. Recovery first changes the durable promotion or restart intent to `ABORT` so a delayed PostgreSQL commit can no longer match it. Recovery can then write the PostgreSQL-authoritative state using a fresh Caddy ETag and revision. An unresolved result keeps the pending operation and protects any container that might still be serving traffic.

On backend startup and about every ten seconds, DeployFlow reconciles active and pending projects. Starting Caddy from the empty bootstrap temporarily returns `404` until recovery verifies Docker and restores the committed routes. Missing or unhealthy containers stay unrouted, and temporary Docker API failure leaves the committed database reference intact. A crashed backend can leave a project lease that must expire before recovery can acquire it.

If the dashboard shows **Recovering or requires attention**, confirm PostgreSQL and Docker are reachable and Caddy is running with the expected listener and private socket permissions. Check the backend and Caddy logs, then allow the next reconciliation cycle to run. If Caddy's admin listener is unavailable after a rejected configuration, restart the dedicated instance using the verified bootstrap. The backend will restore committed healthy routes. Retry the deployment after reconciliation clears the pending operation. A missing or unhealthy container may require **Restart** or **Redeploy** once the platform is healthy.

## Shutdown and limitations

Let deployments and recovery finish. To take applications offline, use **Stop** while the backend, Caddy, Docker, and PostgreSQL are running. Then stop the frontend, backend, and dedicated Caddy instance with Ctrl+C in their terminals. Stop a dedicated PostgreSQL instance last. Stopping the platform processes alone can leave application containers running.

The local listener provides HTTP on the host. Use trusted repositories and one backend writer for the dedicated Caddy instance. Docker Desktop may expose the application listener to bridge workloads through its host gateway. Keep the admin socket private and outside workload mounts. Remote browsers need their own name resolution and connectivity, so the default `*.localhost` URLs are intended for a browser on the host.

With Caddy hosting disabled, the project details offer **Open local Docker port** for a running deployment. That port can change with a replacement.

## Smoke test

The ordinary backend test command covers route generation and failure handling with test doubles. The native Unix-socket transport test runs on Unix platforms. The opt-in `application-routing.integration.test.ts` exercises a disposable Caddy instance and Docker Desktop fixtures, including a rejected update and workload admin probes. Enable it only on the isolated fixture setup using `DEPLOYFLOW_ROUTING_SMOKE=1` and set `DEPLOYFLOW_SMOKE_SOCKET`, `DEPLOYFLOW_SMOKE_PORT`, `DEPLOYFLOW_SMOKE_APP_ID`, and `DEPLOYFLOW_SMOKE_PROBE_ID`. Use a fresh bootstrap, a loopback-published BusyBox app serving `DEPLOYFLOW_PHASE_2C` with the deployment label `22222222-2222-4222-8222-222222222222`, and a normal unprivileged curl probe with no mounts or published ports. The probe needs the alias `phase2c-host-gateway:host-gateway`. Run from `backend` with `npm exec -- vitest run tests/application-routing.integration.test.ts`.

This setup assumes trusted repositories. It protects the administrative socket under the configured host permissions and workload restrictions. It does not establish isolation for privileged workloads, host mounts, or arbitrary untrusted code.

The opt-in `deployment-routing.integration.test.ts` uses disposable Windows Caddy, Docker Desktop, and PostgreSQL to exercise the real lifecycle. Use a private `df3-<hex>` scratch directory with checksum-verified `bin/caddy.exe` and a loopback bootstrap in `caddy.json` with its Unix socket in that directory. Set `DEPLOYFLOW_PHASE3_SMOKE=1`, `DEPLOYFLOW_PHASE3_DIR`, and `DEPLOYFLOW_PHASE3_DB` for a migrated disposable database named `deployflow_phase3`. It needs the fixture user `55555555-5555-4555-8555-555555555555`, cached BusyBox and curl images, and free loopback ports `18083` and `19083`. Run from `backend` with `npm exec -- vitest run tests/deployment-routing.integration.test.ts`.
