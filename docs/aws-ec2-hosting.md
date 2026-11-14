# DeployFlow Phase 5C on AWS EC2

Phase 5C starts with a private DeployFlow dashboard, one trusted test application, and a fresh PostgreSQL 16 database. Phase 5B can be rehearsed on disposable Ubuntu without an AWS account. Launch requires separate authorization. Public exposure, DNS changes, additional AWS services, and plan upgrades need their own authorization.

## Launch settings and preflight

| Setting | Initial configuration |
| --- | --- |
| Account and region | Personal AWS Free Plan, Asia Pacific (Sydney), `ap-southeast-2` |
| AMI | Canonical Ubuntu Server 24.04 LTS (Noble), x86-64/amd64, HVM, EBS-backed, standard Ubuntu Server image |
| Instance | On-Demand `m7i-flex.large`, 2 vCPU and 8 GiB RAM. [M7i-flex specifications](https://aws.amazon.com/ec2/instance-types/m7i/) |
| Root volume | 24 GiB gp3, encrypted with AWS-managed `alias/aws/ebs`, delete on termination |
| Data volume | 40 GiB gp3 in the instance's Availability Zone, encrypted with AWS-managed `alias/aws/ebs`, retain on termination until explicitly cleaned up |
| gp3 performance | 3,000 IOPS and 125 MiB/s per volume |
| Network | Public IPv4 subnet with an internet gateway and one auto-assigned public IPv4. Initial setup uses no Elastic IP, IPv6 ingress, or public HTTP/HTTPS. |
| Inbound security group | TCP 22 from the operator's current public IPv4 as a single `/32`. Check all attached groups. Keep all other inbound ports closed. |
| AWS access from the host | No IAM instance profile, static AWS credentials, SSM enrollment, or S3 backup service. Require IMDSv2 with hop limit 1 and leave the IPv6 metadata endpoint disabled. |

Before an authorized launch, verify the following.

1. In Billing, confirm the Free Plan is active, record the remaining credit balance and plan expiry, and review the cost for the planned runtime and storage retention. If the account or launch wizard rejects the selected configuration, resolve the restriction before proceeding. Keep the Free Plan selected. [AWS Free Tier usage for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)
2. Confirm the chosen Sydney subnet's Availability Zone offers `m7i-flex.large` and the account has at least two available Standard On-Demand vCPUs in Sydney. Capacity can still vary at launch. In EC2, verify the AMI ID, Canonical owner ID `099720109477`, `x86_64` architecture, and Free Tier eligibility. Canonical's regional image lookup uses `/aws/service/canonical/ubuntu/server/noble/stable/current/amd64/hvm/ebs-gp3/ami-id`. An operator can resolve it from the workstation with their own AWS identity. [EC2 instance types by region](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-regions.html), [EC2 quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-quotas.html), [Canonical AMI selection](https://documentation.ubuntu.com/aws/aws-how-to/instances/find-ubuntu-images/)
3. Use a scoped AWS operator identity with MFA and keep AWS credentials on the workstation. Verify the operator can use the Sydney EC2 key pair and has its private key in protected local storage. Verify the public subnet's `0.0.0.0/0` route points to its internet gateway. Record the current SSH source `/32`, including any VPN egress address. Allow outbound DNS and package, registry, and public GitHub access. Confirm regional Systems Manager Default Host Management Configuration and any existing management automation won't enroll the instance. A host without an instance profile can still be enrolled by the regional default configuration. If it would apply, resolve that before launch. [Default Host Management Configuration](https://docs.aws.amazon.com/systems-manager/latest/userguide/fleet-manager-default-host-management-configuration.html)
4. Select the reviewed DeployFlow release and a single trusted public GitHub test repository. Record its branch, reviewed commit SHA, container port, health path, and expected response or version. Use a branch you control and confirm its head is the reviewed commit before each private-mode deployment. Rehearse the release, package versions, fresh database migrations, and fixture on disposable Ubuntu 24.04 x86-64. Treat a failed rehearsal as a launch blocker. [Disposable Linux verification](#disposable-linux-verification)
5. Review both block-device mappings for type, size, encryption key and deletion behavior. Explicitly choose `alias/aws/ebs` for both, especially if the region defaults to a customer-managed key. After launch, record the instance ID, Availability Zone, both volume IDs, and SSH host key fingerprint. Verify the volumes' actual encryption key in EC2. [EC2 launch parameters](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-launch-parameters.html), [EBS encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html)

## Cost and Free Plan expiry

- AWS lists `m7i-flex.large` and gp3 as eligible for accounts created on or after July 15, 2025. Estimate usage against the account's credits. The two volumes reserve 64 GiB combined. Budget their full capacity and verify any applicable credits and allowances in Billing. The plan ends at the earlier of six months after account creation or credit exhaustion. Export and verify recovery files before then, while the account is accessible. [EC2 Free Tier usage](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html), [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/)
- In AWS Pricing Calculator, choose Sydney, Linux, shared tenancy, On-Demand `m7i-flex.large`, and the intended running hours. Budget **running hours × the Sydney EC2 rate + 64 GiB × the Sydney gp3 monthly storage rate × the fraction of the month provisioned + public IPv4 hours × US$0.005**, before credits, tax, and variable usage. At 730 running hours the IPv4 line alone is US$3.65. Include applicable data transfer, KMS requests, and optional snapshot storage or S3 requests and storage. The AWS-managed key has no key storage charge. Check Billing after the first session and stop the instance between sessions. [AWS Pricing Calculator](https://calculator.aws/#/createCalculator/ec2), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [VPC pricing](https://aws.amazon.com/vpc/pricing/), [KMS pricing](https://aws.amazon.com/kms/pricing/)
- A normal EC2 stop ends running compute use and releases the auto-assigned public IP. Both EBS volumes and any snapshots continue to use credits or incur charges. Check the new IP after each start and check for retained resources after teardown. [EC2 stop and start behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html)

## Prepare the Ubuntu host

1. Verify the SSH host key fingerprint against EC2 console output on first connection. Connect as `ubuntu` with `ssh -o IdentitiesOnly=yes -i "<path-to-private-key>" ubuntu@<instance-public-ipv4>`. Restrict the private key's filesystem permissions to the operator. Verify key-only SSH, disabled password and keyboard-interactive authentication, and disabled root login with `sudo sshd -T`. Use `sudo sshd -t` before reloading SSH after a config change. Keep the original session open while testing a second login. [EC2 SSH connection prerequisites](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connection-prereqs-general.html)
2. Confirm `x86_64` with `uname -m` and Ubuntu 24.04 in `/etc/os-release`. Install Ubuntu security updates and the host packages. Reboot if `/var/run/reboot-required` exists and recheck SSH.

   ```sh
   sudo apt-get update
   sudo apt-get upgrade -y
   sudo apt-get install -y ca-certificates curl git jq openssl iptables postgresql-16
   ```

3. Match the **new, empty** 40 GiB data volume's EC2 volume ID to the NVMe serial (shown without the hyphen) with `lsblk -o NAME,SIZE,TYPE,SERIAL,FSTYPE,MOUNTPOINTS`. Verify the root device with `findmnt /` and check the selected disk for partitions or signatures with `sudo wipefs --no-act /dev/<verified-device>`. Format only the verified empty data device with `sudo mkfs.ext4 /dev/<verified-empty-device>`. Create `/srv/deployflow`, get the new filesystem UUID with `sudo blkid`, and add `UUID=<uuid> /srv/deployflow ext4 defaults,nofail 0 2` to `/etc/fstab`. Run `sudo systemctl daemon-reload` and `sudo mount /srv/deployflow`, then verify the expected source and UUID with `findmnt --mountpoint /srv/deployflow -o SOURCE,UUID,FSTYPE`. Stop setup if the expected filesystem is missing. On recovery, mount the restored filesystem by UUID and preserve it. [EBS NVMe volume identification](https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html)
4. Install a security-patched Docker Engine release that passes the classic build API, classic image store, iptables, and systemd cgroup v2 checks. Install a security-patched stock Caddy release compatible with the repository's Caddy 2.11.9 fixture. Stop and disable the stock `caddy.service` before starting the dedicated instance. Install Node.js 22.23.5 or a later tested, security-patched Node 22 release. Verify the signed checksum manifest and Linux x64 tarball, then extract it into `/opt/deployflow/node` using `--strip-components=1`. Record the AMI and the tested Caddy, Docker and Node versions. [Docker's Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/), [Caddy installation](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), [Node.js releases](https://nodejs.org/dist/)
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

   Expect Docker to report `/srv/deployflow/docker systemd 2` and PostgreSQL to report `/srv/deployflow/postgresql`.

   Keep local peer access for PostgreSQL administration. In `pg_hba.conf`, permit TCP access to the deployment database only for the designated migration and application roles at `127.0.0.1/32` using `scram-sha-256`. Place these rules above general host rules and remove the default broad host rules on this dedicated cluster. Use an owner/migrator role and an application role with no schema DDL permission.

   ```text
   host deployflow deployflow_migrator,deployflow_app 127.0.0.1/32 scram-sha-256
   ```

   Reload PostgreSQL after editing `pg_hba.conf`. Run the following in `sudo -u postgres psql -v ON_ERROR_STOP=1`.

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

7. Copy the reviewed release under `/opt/deployflow/releases/<release>`. Build as an unprivileged release user with `/opt/deployflow/node/bin` on `PATH`. In `backend`, load `DATABASE_URL` securely before `npm ci` because it runs Prisma generation. Point it to the fresh database on `127.0.0.1:5432` as the migrator, with URL-encoded credentials. Run `npm ci`, `npm run prisma:validate`, and `npm run prisma:migrate:deploy`. Unset the migration URL, then run `npm run build`. As PostgreSQL administrator, connect to `deployflow` and run `REVOKE ALL ON TABLE public._prisma_migrations FROM deployflow_app;`. Build the frontend with `npm ci` and the following build-time variables.

   ```sh
   BACKEND_API_URL=http://127.0.0.1:4000 \
   NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:4000 \
   NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack
   ```

   Give root ownership of the built release and point `/opt/deployflow/current` at it. Keep build and migration secrets out of the release directory.

## Private startup and operator access

Store `/etc/deployflow/backend.env` under root ownership with mode `0600`. Set `NODE_ENV=production`, `BIND_HOST=127.0.0.1`, `PORT=4000`, the application role's `DATABASE_URL`, a randomly generated `JWT_SECRET`, `REGISTRATION_ENABLED=false`, and `CADDY_ADMIN_SOCKET=/run/deployflow-caddy/admin.sock`. Set `PUBLIC_BASE_URL=http://127.0.0.1:4000`, `APP_HOSTING_ORIGIN=http://localhost:8080`, and `APP_HOSTNAME_SUFFIX=localhost`. Leave `APP_PUBLIC_*`, `GITHUB_WEBHOOK_SECRET_KEY`, and `DOCKER_HOST` unset. Keep the S3 backup timer disabled.

Install `infra/caddy/bootstrap.json` as `/etc/deployflow/caddy.json` with mode `0644`. Start Caddy and both Node services.

```sh
sudo systemctl enable --now deployflow-caddy deployflow-backend deployflow-frontend
sudo systemctl is-active deployflow-caddy deployflow-backend deployflow-frontend
sudo stat -c '%a %U %G %n' /run/deployflow-caddy /run/deployflow-caddy/admin.sock
sudo -u nobody curl --max-time 2 --unix-socket /run/deployflow-caddy/admin.sock http://localhost/config/
sudo ss -lntup
```

The directory should be `2750 caddy deployflow-caddy` and the socket `660 caddy deployflow-caddy`. The `nobody` request should fail. Verify loopback listeners for the dashboard (3000), API (4000), PostgreSQL (5432), and Caddy (8080). Docker and Caddy administration use Unix sockets. Verify there are no public HTTP/HTTPS listeners or public container bindings.

From the operator's workstation, open both local forwards in one SSH connection. Use the verified instance address and key. This command works in PowerShell and POSIX shells.

```sh
ssh -N -T -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -i "<path-to-private-key>" -L 127.0.0.1:3000:127.0.0.1:3000 -L 127.0.0.1:4000:127.0.0.1:4000 "ubuntu@<instance-public-ipv4>"
```

Keep the SSH session open and visit `http://127.0.0.1:3000`. Check `http://127.0.0.1:3000/backend-api/health` and `http://127.0.0.1:4000/api/health`. The browser uses local port 4000 for the WebSocket connection. If either port is busy locally, free that port and reconnect.

Temporarily set `REGISTRATION_ENABLED=true` and restart the backend. Register the operator through the tunnel, restore `false`, and restart the backend before running workloads. Sign in and create the single reviewed project. Deploy it and verify the live log subscription, `RUNNING` status, private route, and expected application response. Record the project UUID, hostname label, and deployed SHA.

For a direct Caddy route check, run `curl --fail --resolve '<label>.localhost:8080:127.0.0.1' 'http://<label>.localhost:8080<health-path>'` on the host, substituting the label and the path including its leading slash. To check the same URL from the workstation, add `-L 127.0.0.1:8080:127.0.0.1:8080` to the SSH command. Test stop and restart through the dashboard. If testing redeploy and rollback, use two reviewed revisions of the same project and verify the served version. From outside the SSH source IP, confirm the instance rejects SSH, and verify HTTP/HTTPS and management ports are closed from an external network.

### Optional transition to Session Manager

Continue using SSH until separately authorized Systems Manager configuration is working. Verify Free Plan availability, a current SSM Agent on the host, and HTTPS access to the required regional endpoints. Confirm an approved EC2 instance profile with `AmazonSSMManagedInstanceCore` or equivalent scoped permissions and check that Systems Manager reports the instance online in Sydney. Verify the operator's `ssm:StartSession` permission for the exact target and the `AWS-StartPortForwardingSession` document, plus the session lifecycle permissions they need. Use an authorized workstation identity and the AWS CLI with the Session Manager plugin. Test separate forwards for ports 3000 and 4000 and repeat dashboard sign-in and log streaming before considering any removal of SSH ingress. [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html), [Instance profile permissions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-instance-profile.html), [Session documents and IAM](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-specify-session-document.html), [Starting port forwarding sessions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)

Close the SSH forwards before testing SSM on the same local ports. Run these in separate terminals.

```sh
aws ssm start-session --target "<instance-id>" --region ap-southeast-2 --profile "<profile>" --document-name AWS-StartPortForwardingSession --parameters 'portNumber=3000,localPortNumber=3000'
aws ssm start-session --target "<instance-id>" --region ap-southeast-2 --profile "<profile>" --document-name AWS-StartPortForwardingSession --parameters 'portNumber=4000,localPortNumber=4000'
```

## Public cutover after separate approvals

1. After public exposure, DNS, and the Elastic IP are authorized, associate the Elastic IP and reconnect SSH at the new address. Publish an exact A record for the project hostname in a zone you control. Verify its public answers and check CAA, if present. Open inbound TCP 80 and 443 and preserve the existing SSH `/32` rule while SSH is the operator access path.
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
4. Deploy through the private dashboard. Confirm the browser reports **Available** and an external network resolves the hostname, receives the HTTP redirect and validates the TLS chain. Fetch the application and its expected version, then check the same URL across successful redeploy, failed redeploy, rollback, restart, and EC2 stop/start. From outside the SSH allowlist, connections to 22, 2019, 2375, 2376, 3000, 4000, 5432, 8080, and the inspected application host port should fail. Confirm that public requests do not reach the management API or webhook handlers. Repeat the socket checks after Caddy reload or restart.

## Backup, restore and shutdown

1. **Export a backup over SSH.** Pause deployment changes and run the following from an operator SSH shell on the host. The dump works while PostgreSQL is running. Export Caddy storage only if it contains material you need for recovery. Save the reviewed release ID, mount configuration, Caddy config, and service settings. Preserve secrets separately in encrypted operator-controlled storage.

   ```sh
   umask 077
   backup_dir=$(mktemp -d "$HOME/deployflow-backup.XXXXXXXX") &&
     sudo -u postgres pg_dump --format=custom --dbname=deployflow > "$backup_dir/database.dump" &&
     (cd "$backup_dir" && sha256sum database.dump > SHA256SUMS) &&
     printf '%s\n' "$backup_dir"
   ```

   If needed, add `sudo tar -C /srv/deployflow -czf - caddy > "$backup_dir/caddy.tar.gz"` and regenerate `SHA256SUMS` for both files. Use `scp -r -o StrictHostKeyChecking=yes -i "<path-to-private-key>" "ubuntu@<instance-public-ipv4>:<printed-backup-directory>" "<encrypted-local-destination>"` from the workstation. Verify `sha256sum -c SHA256SUMS` in the downloaded directory, or compare SHA-256 values with `Get-FileHash -Algorithm SHA256` in PowerShell. Remove host staging files after verifying the copy. Export before credits run out or the Free Plan expires.
2. **Drill a logical restore.** Verify the backup checksums and restore into a new disposable database on a PostgreSQL 16 cluster. Re-create the roles, database ownership, default grants, and database-specific `pg_hba.conf` rule from host setup using the restore database name. Load credentials securely and restore as the migration role with `pg_restore --exit-on-error --no-owner --no-acl --host=127.0.0.1 --username=deployflow_migrator --dbname="<restore-database>" database.dump`. Revoke application access to `public._prisma_migrations` after restoring. Check the migration ledger, project and active deployment rows, and verify access with the application role. For live recovery, redeploy the recorded reviewed commit to recreate containers and routing if Docker state was lost.
3. **Recover from a volume or host failure.** If an EBS snapshot is authorized, take it after a clean shutdown for consistent on-disk PostgreSQL, Docker and Caddy state. For replacement, provision a clean host with the recorded release and compatible package versions. Attach the retained data volume in the same Availability Zone or create an encrypted gp3 volume from the snapshot in the replacement host's Availability Zone. Snapshots encrypted with `aws/ebs` are for same-account recovery. Mount the existing filesystem by UUID before starting services. Use only one copy of a given filesystem UUID on the replacement host. Skip fresh-cluster initialization on restored data, restore root-volume configuration separately, and recheck ownership, migrations, routing, and SSH smoke tests. If restoring Caddy from an archive, recover `caddy:caddy` ownership and restricted permissions. [Restore an EBS volume from a snapshot](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-restoring-volume.html), [EBS snapshot sharing rules](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modifying-snapshot-permissions.html)
4. **Recover SSH access.** Check EC2 status checks, current public IPv4, the subnet route, and the operator's current `/32`. Verify any new host key against EC2 console output. If the key is lost and there is no working session, recover through an authorized same-AZ rescue instance or rebuild using a new key pair and the retained data volume or backup. [EC2 connection troubleshooting](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/TroubleshootingInstancesConnecting.html)
5. **Roll back.** Roll back to the previous successful deployment from the private dashboard and verify the served version. Keep its image until acceptance. For platform rollback, stop the Node services, repoint the release symlink to a prior schema-compatible release, and restart. If the older release requires an older schema, restore a matching backup into a separate database and verify it before switching. Restore the previous Caddy config with a controlled restart so the backend can reconcile the committed route.
6. **Stop or tear down.** Let builds and route changes settle. Stop the application explicitly if it should remain offline. Stop the frontend and backend, then Caddy, Docker including its socket, and PostgreSQL. Stop EC2 normally. On restart, verify the new IP, data mount, service states, and private route. For authorized teardown, verify the off-instance backup, terminate EC2, and check for retained volumes and snapshots in Sydney. Delete approved leftovers after recovery checks. If public cutover or S3 was enabled later, also check for a stale DNS record, allocated Elastic IP, and retained S3 objects. Review Billing after cleanup.

S3 automation is optional after a separate approval. Confirm the private bucket, Block Public Access, default encryption and a 14-day lifecycle for current and retained noncurrent backup objects. Give the host only the required write access to its backup prefix. Use an operator identity for restores and deletion. Set `DEPLOYFLOW_BACKUP_BUCKET` and `AWS_REGION=ap-southeast-2` in the root-only `/etc/deployflow/backup.env` after installing AWS CLI v2. Run `deployflow-backup.service` once, verify an uploaded backup, then enable `deployflow-backup.timer`. Keep an off-account copy if the data is needed after Free Plan expiry.

## Disposable Linux verification

Run the normal lint, tests, type checks and builds on the target Linux version. The [Linux CI fixture](../.github/workflows/ci.yml) shows how to create a disposable PostgreSQL database on port 55437, install Caddy, and run `infra/ubuntu/prepare-linux-smoke` on an Ubuntu VM with its own Docker daemon. It uses a local test certificate, a synthetic repository fixture and a loopback-only listener. Check the firewall from an ordinary bridge workload and from a classic image build, including attempts to connect to a private host fixture and a simulated metadata endpoint. Confirm the test service is reachable from the host so a negative check has a positive control. Exercise a Docker restart with one running and one explicitly stopped workload. An Ubuntu WSL2 distro with systemd exercises Linux services and the native Docker Engine but leaves full VM boot, EC2 networking, actual SSM and public certificate issuance for their respective environments.

The app's Linux build path uses Docker's deprecated classic builder and the `deployflow-build.slice` limit of one CPU and 1.5 GiB. The instance's 8 GiB RAM does not raise that build limit. Verify the exact Docker release uses the classic image store and iptables, and that the fixture builds inside the slice with the host firewall active. Keep the validated Engine release pinned until a security-patched replacement passes those checks. Measure root and data volume free space and Docker image and cache use during the fixture build. Leave room for a redeploy alongside the previous image. If a security-patched Docker release or the chosen fixture fails these checks, resolve it before launch and obtain approval before making application code changes. [Docker Engine deprecations](https://docs.docker.com/engine/deprecated/), [Docker Engine image store](https://docs.docker.com/engine/storage/containerd/)
