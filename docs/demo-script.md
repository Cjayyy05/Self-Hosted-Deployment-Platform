# Three-minute internship demo

| Time | On screen | Talking points |
| --- | --- | --- |
| 0:00–0:30 | Dashboard | “I built DeployFlow to deploy trusted GitHub projects from one dashboard. These two applications share one EC2 Docker host and have independent deployments and public routes.” |
| 0:30–1:05 | Public Hosting and architecture diagram | “I review and approve a full Git SHA. DeployFlow checks out that exact revision, builds it, checks the container, and verifies HTTPS through Caddy before promoting it. I reach the dashboard and API over an SSH tunnel.” |
| 1:05–1:40 | Deployment logs, runtime monitoring, and history | “The log socket is scoped to the deployment. Docker supplies live CPU, memory, and uptime. History records the difference between an active release and a failed attempt, and I can roll back to an approved revision.” |
| 1:40–2:10 | Hello World and Minimax Tic Tac Toe | “Each site has its own stable hostname and managed certificate. One app's lifecycle is independent of the other.” Play one move in Tic Tac Toe if the sites are online. |
| 2:10–2:40 | Diagram and tests | “I use health checks and a persisted routing operation to recover interrupted cutovers. A temporary DNS outage can produce a verifying state while Caddy and HTTPS still pass. The Linux integration test exercises DNS recovery without another image build.” |
| 2:40–3:00 | Delete Project confirmation in a disposable setup | “Deletion requires the exact project name. It removes the project's hosting route and deployment resources, and GitHub keeps the source repository.” |

Use the AWS views and checked-in captures for a read-only walkthrough. Show a new build or complete deletion only in a disposable local setup. If EC2 is stopped, use the [README gallery](../README.md#screenshots) and explain that the instance is started on demand.
