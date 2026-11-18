# From GitHub to public HTTPS

DeployFlow's AWS mode runs the dashboard, API, PostgreSQL, Docker Engine, and Caddy on one Ubuntu EC2 host. Operators reach the dashboard and API through SSH forwarding. Public visitors reach Caddy through a stable hostname for each approved application.

## Prepare the host once

Use the [EC2 runbook](aws-ec2-hosting.md) for the guarded release, database migrations, host firewall, private operator access, Caddy bootstrap, persistent certificate storage, DNS, and first public admission. In the demonstrated setup, dynv6 wildcard records under the application suffix point to a shared IPv4 DNS target. Caddy serves individual certificates for approved hosts and starts with a deny-by-default configuration.

## Review and deploy an application

1. Review a trusted public GitHub repository and record the full commit SHA. Confirm that its root Dockerfile or supported application layout starts an HTTP server on the intended container port. Confirm the health-check path is an application-relative path such as `/health` or `/`.
2. Open the private dashboard as the configured operator. Select **Create Project** and enter the repository, branch, and container port. Set the health-check path on the project page.
3. Under **Public Hosting**, enter the reviewed full SHA and select **Approve revision**. DeployFlow stores the approval against the project's repository and branch. Select the SHA under **Approved revisions** and choose **Deploy**.
4. The backend creates a deployment record, fetches the exact Git revision, verifies the checkout, and builds with the repository's Dockerfile or a generated one in the temporary checkout. The deployment panel streams progress and build output.
5. Docker starts the image with the public workload policy and a deployment-specific loopback binding. DeployFlow probes the configured HTTP path and requires a response in the 200–399 range.
6. DeployFlow validates public DNS against the shared IPv4 reference and makes up to six checks for transient errors or missing answers. Inconsistent IPv4 answers and unexpected IPv6 fail verification immediately. It installs an exact-host route through Caddy's private admin socket. With working DNS and ACME reachability, Caddy manages the certificate and redirects HTTP to HTTPS. Caddy checks current ingress authorization through a private socket before proxying traffic.
7. DeployFlow verifies trusted HTTPS and the candidate's response through Caddy, records the active deployment, and retires the previous container. The dashboard probes from the operator's browser before enabling **Open website** and **Copy public URL**.
8. Open the site from another network using normal DNS and certificate validation. Check the expected content and HTTP redirect. Repeat with a different project and verify both hostnames serve their own application. An unknown hostname should serve no application.

## Replace or withdraw a deployment

- **Redeploy** uses a selected approved SHA. **Restart** and **Rollback** use the revision saved on the selected deployment. Keep the previous revision approved if it is needed for rollback.
- If a replacement fails a build, health, DNS, or HTTPS check, inspect the failed attempt in history and the deployment logs. When the previous target remains healthy, DeployFlow keeps or restores its route and leaves it active.
- **Stop** takes the active deployment offline. **Revoke public hosting** withdraws the project's public service and revokes its approved revisions. Use the [withdrawal procedure](aws-ec2-hosting.md#revocation-and-emergency-containment) to verify completion.
- **Delete Project** in **Danger Zone** requires typing the exact project name and selecting **Permanently Delete Project**. On success, the dashboard returns to the project list. The API withdraws the route and cleans up the project's Docker resources before deleting its record and deployment history. An unresolved withdrawal or cleanup error can block deletion. The GitHub repository remains available.
- Public mode uses operator approval and selection for releases. [Signed GitHub push webhooks](github-auto-deploy.md) are available in local/private mode.

For an already running deployment, the dashboard retries a transient resolver failure separately from deployment. A recent successful check, continued route verification, and a passing HTTPS probe allow a brief **Verifying DNS** state. If resolver errors persist, **DNS unverified** means public reachability is unknown. Website actions are withheld until DNS and browser-side HTTPS verification succeed again.

If EC2 is stopped, the public sites can be offline. On restart, follow the [recovery checklist](aws-ec2-hosting.md#ec2-stopstart-recovery-checklist) to verify services, refresh the shared DNS record if the address changed, and confirm both HTTPS routes.
