# DeployFlow frontend

Next.js App Router frontend for DeployFlow, built with strict TypeScript and Tailwind CSS.

## Local setup

1. Copy `.env.example` to `.env.local` if the backend is not running at `http://localhost:4000`.
2. Start the backend.
3. Run `npm run dev` and open `http://localhost:3000`.

Browser requests to `/backend-api/*` are proxied to the Express API using `BACKEND_API_URL`, avoiding a cross-origin dependency in local development.
The live deployment event connection uses `NEXT_PUBLIC_SOCKET_URL` from the browser and defaults to `http://localhost:4000`.

## Commands

- `npm run dev` — start the development server
- `npm run lint` — run ESLint
- `npm run typecheck` — run strict TypeScript checks
- `npm run build` — create a production build
- `npm run test:e2e` — run the Playwright dashboard scenarios

## Dashboard acceptance tests

Run `npx playwright install chromium` and serve the frontend at `http://127.0.0.1:3000`.
Set `DEPLOYFLOW_E2E_MODE=mocked` to exercise approval, operation conflicts, the
browser HTTPS check, and pending withdrawal using intercepted API responses.

Use fresh disposable databases and workloads for the live scenarios. Use
`DEPLOYFLOW_E2E_MODE=public` for a public-mode backend or
`DEPLOYFLOW_E2E_MODE=private` for a private-mode backend with registration and
webhook configuration enabled. For public mode, use a hostname suffix that
resolves inside the lab and install the lab CA in the browser and backend trust stores.
The browser probe expects the dashboard origin `http://127.0.0.1:3000`.

Provide the following fixture settings as environment variables.

| Variable | Value |
| --- | --- |
| `DEPLOYFLOW_E2E_EMAIL`, `DEPLOYFLOW_E2E_PASSWORD` | Existing disposable operator credentials |
| `DEPLOYFLOW_E2E_OTHER_EMAIL` | Second public-mode fixture user with the same disposable password |
| `DEPLOYFLOW_E2E_REPOSITORY_A`, `DEPLOYFLOW_E2E_REPOSITORY_B` | GitHub URLs for two reviewed fixture repositories, with a local Git URL rewrite if needed |
| `DEPLOYFLOW_E2E_REVISION_A`, `DEPLOYFLOW_E2E_REVISION_A2` | Full SHAs for the two successful Northwind revisions |
| `DEPLOYFLOW_E2E_REVISION_B`, `DEPLOYFLOW_E2E_BAD_REVISION` | Full SHAs for Harbor and the Northwind revision whose Docker build fails |
| `DEPLOYFLOW_E2E_SCREENSHOTS` | Optional directory for public workflow screenshots |

The fixtures listen on port 8080 and serve `/health`. Their homepages display
`Northwind v1`, `Northwind v2`, and `Harbor v1` as asserted in the browser tests.
