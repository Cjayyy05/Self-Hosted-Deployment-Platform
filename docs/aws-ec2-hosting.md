# DeployFlow on one Ubuntu EC2 instance

This runbook prepares one trusted test application on Ubuntu Server 24.04 LTS (x86-64), a Malaysia `t3.medium` in Standard credit mode, one Elastic IPv4 address, a 24 GiB encrypted gp3 root volume and a 40 GiB encrypted gp3 data volume. Use a public subnet with an internet gateway. Start with zero inbound security-group rules. Use an SSM instance profile and temporary operator credentials. Enable IMDSv2 with hop limit 1, leave the IPv6 metadata endpoint disabled, and keep workload access to metadata blocked at the host firewall. Keep outbound access for SSM, package and image downloads, GitHub, DNS, the certificate authority and backups.

Phase 5B can be rehearsed on disposable Ubuntu without any AWS account actions. Phase 5C requires separate approval for AWS resources and spend, DNS, and public exposure. Existing PostgreSQL data and Git commit or push have independent approvals. Use a DNS zone you already control where possible.

## Prepare the Ubuntu host

1. Verify the AMI publisher, SSM Agent status and both port-forward permissions before relying on remote access. Use `AmazonSSMManagedInstanceCore` or its scoped equivalent, and scope the operator's session permission to this instance and the port-forwarding document. Add only the write permissions needed for the backup prefix to the host role. Use a separate operator role for restores and deletion.
2. Install Ubuntu security updates and the host packages.

   ```sh
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git jq openssl iptables postgresql-16
   ```

3. Identify the **approved empty** data volume by volume ID and serial with `lsblk -o NAME,SIZE,SERIAL,FSTYPE,MOUNTPOINTS` and `sudo blkid`. On the initial provision only, create an ext4 filesystem with `sudo mkfs.ext4 /dev/<verified-empty-device>`. Use its filesystem UUID in `/etc/fstab` as `UUID=<uuid> /srv/deployflow ext4 defaults,nofail 0 2`. Mount it and check `mountpoint /srv/deployflow`. On recovery, mount the restored volume by UUID and preserve its filesystem.
4. Install a security-patched Docker Engine release from the [official Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/). Record the selected package versions and confirm the classic build API, the systemd cgroup driver, and cgroup v2 on that version. Install stock Caddy from the [official package repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). Stop and disable the stock `caddy.service` before starting the dedicated instance. Use a security-patched release compatible with Caddy 2.11.9. Install Node.js 22.23.5 (or a later tested Node 22 patch) from the [official release directory](https://nodejs.org/dist/), verify the signed checksum manifest and the Linux x64 tarball, then extract it into `/opt/deployflow/node` using `--strip-components=1`. Record the AMI and the tested Caddy, Docker and Node versions.
5. Run the commands below from the DeployFlow release checkout. The Docker configuration selects the classic image store so the Docker data root covers image storage. Apply it on this fresh dedicated host before pulling workload images.

   ```sh
   sudo systemctl stop docker.socket docker.service postgresql@16-main.service
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin deployflow
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin deployflow-web
   sudo groupadd --system deployflow-caddy
   sudo install -d -m 0755 /etc/deployflow
   sudo install -d -m 0755 /usr/local/libexec /opt/deployflow/releases
   sudo install -d -m 0700 /srv/deployflow/docker /srv/deployflow/backup
   sudo install -d -m 0700 -o caddy -g caddy /srv/deployflow/caddy
   sudo install -d -m 0700 -o postgres -g postgres /srv/deployflow/postgresql
   sudo install -d /etc/docker /etc/systemd/system/docker.service.d /etc/systemd/system/postgresql@16-main.service.d
   sudo install -m 0644 infra/ubuntu/docker.json /etc/docker/daemon.json
   sudo dockerd --validate --config-file=/etc/docker/daemon.json
   sudo install -m 0644 infra/ubuntu/docker-deployflow.conf /etc/systemd/system/docker.service.d/deployflow.conf
   sudo install -m 0644 infra/ubuntu/postgresql-deployflow.conf /etc/systemd/system/postgresql@16-main.service.d/deployflow.conf
   sudo install -m 0644 infra/ubuntu/*.service infra/ubuntu/*.slice infra/ubuntu/*.timer /etc/systemd/system/
   sudo install -m 0644 infra/ubuntu/deployflow-caddy.conf /etc/tmpfiles.d/deployflow-caddy.conf
   sudo install -m 0755 infra/ubuntu/deployflow-firewall infra/ubuntu/deployflow-backup /usr/local/libexec/
   sudo systemd-tmpfiles --create /etc/tmpfiles.d/deployflow-caddy.conf
   sudo systemctl daemon-reload
   ```

6. On the **fresh Ubuntu cluster only**, copy its initialized data directory while stopped and point PostgreSQL at the persistent copy. Verify the source and destination before copying. Keep the original until the new cluster and a restore drill pass.

   ```sh
   sudo cp -a /var/lib/postgresql/16/main/. /srv/deployflow/postgresql/
   sudo tee /etc/postgresql/16/main/conf.d/deployflow.conf >/dev/null <<'CONF'
   data_directory = '/srv/deployflow/postgresql'
   listen_addresses = '127.0.0.1'
   password_encryption = 'scram-sha-256'
   CONF
   sudo systemctl start postgresql@16-main docker
   sudo systemctl is-active deployflow-firewall docker postgresql@16-main
   sudo docker info --format '{{.DockerRootDir}} {{.CgroupDriver}} {{.CgroupVersion}}'
   sudo -u postgres psql -c 'SHOW data_directory;'
   ```

   Keep local peer access for PostgreSQL administration. In `pg_hba.conf`, permit TCP access to the deployment database only for the designated migration and application roles at `127.0.0.1/32` using `scram-sha-256`. Place these rules above general host rules and remove the default broad host rules on this dedicated cluster. Use an owner/migrator role and an application role with no schema DDL permission.

   ```sql
   CREATE ROLE deployflow_migrator LOGIN;
   CREATE ROLE deployflow_app LOGIN;
   \password deployflow_migrator
   \password deployflow_app
   CREATE DATABASE deployflow OWNER deployflow_migrator;
   \connect deployflow
   REVOKE CONNECT, TEMPORARY ON DATABASE deployflow FROM PUBLIC;
   GRANT CONNECT ON DATABASE deployflow TO deployflow_app;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   GRANT USAGE ON SCHEMA public TO deployflow_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE deployflow_migrator IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deployflow_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE deployflow_migrator IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO deployflow_app;
   ```

7. Copy the reviewed release under `/opt/deployflow/releases/<release>`. Build as an unprivileged release user, then give root ownership of the release and point `/opt/deployflow/current` at it. Run `npm ci`, `npm run prisma:validate`, `npm run prisma:migrate:deploy`, and `npm run build` in `backend`, with `DATABASE_URL` pointing to the **new** database and authenticating as the migrator. Load that URL securely in the migration shell, then unset it. Revoke access to the migration ledger from the app role with `REVOKE ALL ON TABLE public._prisma_migrations FROM deployflow_app;`. Build the frontend with `npm ci` and the following build-time variables.

   ```sh
   BACKEND_API_URL=http://127.0.0.1:4000 \
   NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:4000 \
   NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack
   ```

## Private startup and operator access

Store environment files under `/etc/deployflow` owned by root with mode `0600`. Set backend `NODE_ENV=production`, `BIND_HOST=127.0.0.1`, `PORT=4000`, the application role's `DATABASE_URL`, a randomly generated `JWT_SECRET`, and `CADDY_ADMIN_SOCKET=/run/deployflow-caddy/admin.sock`. Leave `GITHUB_WEBHOOK_SECRET_KEY` and `DOCKER_HOST` unset. Keep `PUBLIC_BASE_URL=http://127.0.0.1:4000`.

Use `infra/caddy/bootstrap.json` as `/etc/deployflow/caddy.json` with mode `0644` for private startup. Start Caddy and both Node services.

```sh
sudo systemctl enable --now deployflow-caddy deployflow-backend deployflow-frontend
sudo stat -c '%a %U %G %n' /run/deployflow-caddy /run/deployflow-caddy/admin.sock
sudo -u nobody curl --max-time 2 --unix-socket /run/deployflow-caddy/admin.sock http://localhost/config/
sudo ss -lntup
```

The directory should be `2750 caddy deployflow-caddy` and the socket `660 caddy deployflow-caddy`. The `nobody` request should fail. Docker has a Unix socket only. The API, dashboard, and PostgreSQL listen on loopback. Docker has no public published port.

Install AWS CLI v2 and the Session Manager plugin on the operator's machine. Run these in separate terminals using an authorized SSO profile.

```sh
aws ssm start-session --target <instance-id> --region ap-southeast-5 --profile <profile> \
  --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
aws ssm start-session --target <instance-id> --region ap-southeast-5 --profile <profile> \
  --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["4000"],"localPortNumber":["4000"]}'
```

Open `http://127.0.0.1:3000`. This exact origin is permitted by the public health response and the build expects local port 4000 for WebSocket traffic. Confirm `/backend-api/health` through the frontend, then verify sign-in, project requests and a deployment log subscription through both forwards. For initial account creation, temporarily set `REGISTRATION_ENABLED=true` in the private configuration and restart the backend. Register the operator, restore `false`, and restart the backend before running workloads. Create the single reviewed project and record its UUID and hostname label.

## Public cutover after separate approvals

1. Publish an exact A record for the project hostname pointing to the approved Elastic IP. Use direct DNS resolution. Verify its public answers and check CAA, if present. Open TCP 80 and 443 on the instance security group. Keep other inbound ports closed.
2. Set `APP_HOSTNAME_SUFFIX=apps.<your-domain>`, `APP_HOSTING_ORIGIN=https://apps.<your-domain>`, `APP_PUBLIC_PROJECT_ID`, `APP_PUBLIC_REPOSITORY_URL`, `APP_PUBLIC_BRANCH`, and `APP_PUBLIC_COMMITS` (comma-separated lowercase full SHA-1s). The project must already exist in the database. Approve each source revision before deploying and retain the prior approved revision during rollback testing. Public mode rejects new projects. Repositories, image base tags and network dependencies remain trusted inputs, so pin dependencies for the fixture.
3. Render the Caddy template with the exact approved hostname. For the certificate rehearsal, add a staging ACME policy, then restore the rendered production config. The backend and browser require trusted certificates for availability. Stop the backend during cutover, start Caddy with the rendered config, and start the backend after Caddy comes up.

   ```sh
   hostname='<recorded-hostname-label>.apps.<your-domain>'
   sed "s/APPROVED_HOSTNAME/$hostname/g" infra/caddy/public.json > /tmp/deployflow-public.json
   jq --arg hostname "$hostname" '.apps.tls.automation.policies = [
     {subjects: [$hostname], issuers: [{module: "acme", ca: "https://acme-staging-v02.api.letsencrypt.org/directory"}]}
   ]' /tmp/deployflow-public.json > /tmp/deployflow-staging.json
   sudo caddy validate --config /tmp/deployflow-public.json
   ```

   Install the selected file as `/etc/deployflow/caddy.json` and restart `deployflow-caddy`. Review the Caddy journal for issuance. Repeat with the production config before testing the app.
4. Deploy through the private dashboard. Confirm the browser reports **Available** and an external network resolves the hostname, receives the HTTP redirect and validates the TLS chain without an override. Fetch the actual application and its expected version, then check the same URL across successful redeploy, failed redeploy, rollback, restart, and EC2 stop/start. An external connection to 22, 2019, 2375, 2376, 3000, 4000, 5432 and the inspected application host port should fail. Confirm that public requests do not reach the management API or webhook handlers. Also repeat the socket checks after Caddy reload or restart.

## Backup, restore and shutdown

- Use a private S3 bucket with Block Public Access, default encryption, and a 14-day lifecycle policy for current and any retained noncurrent backup objects. Install AWS CLI v2 on the host. Set `DEPLOYFLOW_BACKUP_BUCKET` and `AWS_REGION` in the root-only `/etc/deployflow/backup.env`. Start `deployflow-backup.service` once and verify the checksums are present, then enable `deployflow-backup.timer`. The timer takes a PostgreSQL custom-format dump and a protected Caddy storage archive. Preserve host configuration and secrets separately in protected storage. Take an approved EBS snapshot of the data volume for whole-host recovery, ideally after a clean shutdown.
- For a restore drill, download one complete backup with a separate restore role, verify `sha256sum -c SHA256SUMS`, and restore the dump using `pg_restore --exit-on-error --no-owner --no-acl` into a **new disposable database**. Check the migration ledger, project and active deployment rows. To replace a failed host, restore into a new cluster owned by the migration role, restore application grants, and recover Caddy storage with ownership `caddy:caddy` and restricted permissions. A database-only restore does not recreate Docker containers or rollback images. Restore Docker state from a matching data-volume snapshot or deploy the reviewed commit again.
- For application rollback, use the previous successful deployment in the dashboard and verify the served version. For platform rollback, stop the Node services, repoint the release symlink to the prior compatible release, and restart. When changing Caddy bootstrap settings, keep the previous rendered config and use a controlled restart so the backend can reconcile the committed route. Avoid pruning retained rollback images.
- For shutdown, wait for active builds and route changes to settle and stop the application explicitly if it should remain offline. Stop the frontend and backend, then Caddy, Docker and PostgreSQL, and stop EC2 normally. For full teardown after approval, preserve and verify the required backup, remove the DNS record, release the Elastic IP, terminate the instance, and confirm which EBS volumes, snapshots, S3 objects and DNS zones were retained. Check Billing for lingering resources. Stopped instances still incur storage and Elastic IP charges.

## Disposable Linux verification

Run the normal lint, tests, type checks and builds on the target Linux version. The [Linux CI fixture](../.github/workflows/ci.yml) shows how to create a disposable PostgreSQL database on port 55437, install Caddy, and run `infra/ubuntu/prepare-linux-smoke` on an Ubuntu VM with its own Docker daemon. It uses a local test certificate, a synthetic repository fixture and a loopback-only listener. Check the firewall from an ordinary bridge workload and from a classic image build, including attempts to connect to a private host fixture and a simulated metadata endpoint. Confirm the test service is reachable from the host so a negative check has a positive control. Exercise a Docker restart with one running and one explicitly stopped workload. An Ubuntu WSL2 distro with systemd exercises Linux services and the native Docker Engine but leaves full VM boot, EC2 networking, actual SSM and public certificate issuance for their respective environments.

The bounded classic builder is deprecated in Docker. Keep the validated Engine release pinned until a security-patched replacement has passed the Linux fixture, including build cgroups and bridge isolation. Measure image and cache disk use during builds. The data volume is shared by the database, image store, and certificate storage, so keep enough free space for both deploy candidates and retained rollback images.
