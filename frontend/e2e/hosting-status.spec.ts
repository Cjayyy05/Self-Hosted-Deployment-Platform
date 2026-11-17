import { expect, test } from "@playwright/test";

import type { Project } from "../src/lib/api";

test("hosting polls distinguish DNS uncertainty from downtime and withdrawal", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("Expected a local dashboard base URL");
  const dashboardOrigin = new URL(baseURL).origin;
  const projectId = "11111111-1111-4111-8111-111111111111";
  const hostnameLabel = "app-11111111111141118111111111111111";
  const publicHostname = hostnameLabel + ".apps.example.test";
  const publicApplicationUrl = "https://" + publicHostname;
  const publicProbePath = "/.well-known/deployflow-health/test";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const user = { id: projectId, email: "operator@example.test", createdAt: timestamp, updatedAt: timestamp };
  const running = {
    id: projectId, name: "Public application", userId: user.id, hostnameLabel, localApplicationUrl: null,
    repositoryUrl: "https://github.com/example/app", branch: "main", containerPort: 8080, healthCheckPath: "/health",
    createdAt: timestamp, updatedAt: timestamp, activeDeployment: null, latestDeployment: null,
    publicHostingEnabled: true, publicHostname, publicApplicationUrl, publicProbePath,
    approvalStatus: "APPROVED", certificateStatus: "READY", hostingStatus: "AVAILABLE",
  } satisfies Project;
  let project: Project = running;
  let browserChecks = 0;
  await page.addInitScript(() => localStorage.setItem("deployflow.access-token", "local-test-token"));
  await page.route("**/backend-api/**", async (route) => {
    switch (new URL(route.request().url()).pathname) {
      case "/backend-api/auth/me": return route.fulfill({ json: { user } });
      case "/backend-api/auth/features": return route.fulfill({ json: { registrationEnabled: false } });
      case "/backend-api/projects": return route.fulfill({ json: { projects: [project] } });
      default: return route.abort();
    }
  });
  await page.route(publicApplicationUrl + publicProbePath, async (route) => {
    browserChecks += 1;
    await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": dashboardOrigin } });
  });

  await page.goto("/dashboard");
  const card = page.getByRole("article").filter({ hasText: running.name });
  const status = card.getByRole("status");
  const website = card.getByRole("link", { name: /Open website/ });
  await expect(status).toHaveText("Available");
  await expect(website).toBeVisible();

  project = { ...running, hostingStatus: "VERIFYING_DNS" };
  await expect(status).toHaveText("Rechecking public DNS");
  await expect(website).toHaveCount(0);
  const previousChecks = browserChecks;
  await expect.poll(() => browserChecks).toBeGreaterThan(previousChecks);

  project = { ...running, hostingStatus: "DNS_UNVERIFIED", publicProbePath: undefined };
  await expect(status).toHaveText("Public DNS unverified");
  await expect(website).toHaveCount(0);

  project = running;
  await expect(status).toHaveText("Available");
  await expect(website).toBeVisible();

  project = { ...running, hostingStatus: "RECOVERING", publicProbePath: undefined,
    hostingError: { code: "APPLICATION", message: "The application health check failed through Caddy" } };
  await expect(status).toHaveText("Recovering or requires attention");
  await expect(card.getByText("The application health check failed through Caddy")).toBeVisible();
  await expect(website).toHaveCount(0);

  project = { ...running, hostingStatus: "UNAVAILABLE", approvalStatus: "REVOKED",
    certificateStatus: "UNVERIFIED", publicApplicationUrl: undefined, publicProbePath: undefined };
  await expect(status).toHaveText("Unavailable");
  await expect(card.getByText("Hosting revoked")).toBeVisible();
  await expect(website).toHaveCount(0);
});
