import { expect, test, type Page } from "@playwright/test";

const mode = process.env.DEPLOYFLOW_E2E_MODE;
const fixture = {
  email: process.env.DEPLOYFLOW_E2E_EMAIL ?? "",
  password: process.env.DEPLOYFLOW_E2E_PASSWORD ?? "",
  otherEmail: process.env.DEPLOYFLOW_E2E_OTHER_EMAIL ?? "",
  repositoryA: process.env.DEPLOYFLOW_E2E_REPOSITORY_A ?? "",
  repositoryB: process.env.DEPLOYFLOW_E2E_REPOSITORY_B ?? "",
  revisionA: process.env.DEPLOYFLOW_E2E_REVISION_A ?? "",
  revisionA2: process.env.DEPLOYFLOW_E2E_REVISION_A2 ?? "",
  revisionB: process.env.DEPLOYFLOW_E2E_REVISION_B ?? "",
  badRevision: process.env.DEPLOYFLOW_E2E_BAD_REVISION ?? "",
};

const firstName = "Northwind Status";
const secondName = "Harbor Notes";
const confirmation = (page: Page, accept = true) =>
  page.once("dialog", (dialog) => accept ? dialog.accept() : dialog.dismiss());

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible();
}

async function openProject(page: Page, name: string) {
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function createProject(page: Page, name: string, repository: string) {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Create Project", exact: true }).first().click();
  const form = page.getByRole("region", { name: "Connect a GitHub repository" });
  await form.getByLabel("Project name").fill(name);
  await form.getByLabel("Public GitHub repository URL").fill(repository);
  await form.getByLabel("Branch").fill("main");
  await form.getByLabel("Container port").fill("8080");
  await form.getByLabel("Health-check path").fill("/health");
  await form.getByRole("button", { name: "Create project" }).click();
  await openProject(page, name);
}

const revisionPicker = (page: Page) => page.getByLabel("Approved revisions");
const websiteLink = (page: Page) => page.getByRole("link", { name: "Open website" });
const activeDeployment = (page: Page) => page.getByText("Active deployment", { exact: true }).first().locator("xpath=..");

async function approveRevision(page: Page, sha: string) {
  await page.getByLabel("Reviewed Git commit SHA").fill(sha);
  await page.getByRole("button", { name: /Approve (another )?revision/ }).click();
  await expect(revisionPicker(page).locator(`option[value="${sha}"]`)).toHaveCount(1);
}

async function visitWebsite(page: Page, expectedContent: string) {
  await expect(websiteLink(page)).toBeVisible();
  const url = await websiteLink(page).getAttribute("href");
  if (!url) throw new Error("Public link is missing its URL");
  expect(url).toMatch(/^https:\/\/app-[a-f0-9]{32}\./);
  const headers = page.context().waitForEvent("request", {
    predicate: (request) => request.isNavigationRequest() && request.url() === new URL(url).href,
  });
  const [website] = await Promise.all([page.waitForEvent("popup"), websiteLink(page).click()]);
  const content = website.getByText(expectedContent, { exact: true });
  await expect(async () => {
    await website.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    if (!await content.isVisible()) {
      // Force revalidation when a browser has cached content for the stable hostname.
      await website.reload({ waitUntil: "domcontentloaded", timeout: 5_000 });
    }
    expect((await website.locator("body").innerText({ timeout: 5_000 })).trim()).toBe(expectedContent);
  }).toPass({ timeout: 20_000 });
  expect(await (await headers).headerValue("authorization")).toBeNull();
  expect(await (await headers).headerValue("referer")).toBeNull();
  await website.close();
  return url;
}

async function screenshot(page: Page, file: string, fullPage = false) {
  const directory = process.env.DEPLOYFLOW_E2E_SCREENSHOTS;
  if (directory) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${directory}/${file}.png`, fullPage });
  }
}

test("public dashboard operates two independent applications", async ({ page, context }) => {
  test.skip(mode !== "public", "Requires a disposable public-mode backend and reviewed Git fixtures");
  await test.step("authenticate the operator and deny unauthorized management", async () => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get("/backend-api/projects")).status()).toBe(401);
    const loginResult = await page.request.post("/backend-api/auth/login", {
      data: { email: fixture.otherEmail, password: fixture.password },
    });
    expect(loginResult.status()).toBe(403);
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Registration unavailable" })).toBeVisible();
    await signIn(page);
  });

  let firstUrl = "";
  let secondUrl = "";
  await test.step("create, approve and deploy Northwind with live logs and verified HTTPS", async () => {
    await createProject(page, firstName, fixture.repositoryA);
    await expect(page.getByRole("heading", { name: "Webhook configuration" })).toHaveCount(0);
    const deploy = page.getByRole("button", { name: "Deploy", exact: true });
    await expect(deploy).toBeDisabled();
    await page.getByLabel("Reviewed Git commit SHA").fill("a1b2c3");
    await page.getByRole("button", { name: "Approve revision" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "full 40-character Git commit SHA" })).toBeVisible();
    await approveRevision(page, fixture.revisionA);
    await expect(deploy).toBeDisabled();

    const token = await page.evaluate(() => localStorage.getItem("deployflow.access-token"));
    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    const rejection = await page.request.post(`/backend-api/projects/${projectId}/deploy`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { commitHash: fixture.revisionB },
    });
    expect(rejection.status()).toBe(403);

    const probe = page.waitForResponse((response) =>
      response.url().startsWith("https://app-") && response.status() === 204,
      { timeout: 90_000 },
    );
    await revisionPicker(page).selectOption(fixture.revisionA);
    await deploy.click();
    await expect(page.getByText(/Deployment is (queued|cloning|building|starting|health checking)\./)).toBeVisible();
    await expect(page.getByRole("log")).toContainText(/Step |Starting container|health check/i, { timeout: 75_000 });
    await expect(page.getByText("Deployment is running.", { exact: true })).toBeVisible({ timeout: 75_000 });
    const probeResponse = await probe;
    expect(await probeResponse.request().headerValue("authorization")).toBeNull();
    expect(await probeResponse.request().headerValue("cookie")).toBeNull();
    expect(await probeResponse.request().headerValue("referer")).toBeNull();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    firstUrl = await visitWebsite(page, "Northwind v1");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy public URL" }).click();
    await expect(page.getByText("Public URL copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstUrl);
    await screenshot(page, "phase3-public-project");
    await page.reload();
    await expect(page.getByRole("log")).toContainText(/Step |Starting container|health check/i);
  });

  await test.step("deploy Harbor to a second HTTPS hostname", async () => {
    await createProject(page, secondName, fixture.repositoryB);
    await approveRevision(page, fixture.revisionB);
    await revisionPicker(page).selectOption(fixture.revisionB);
    await page.getByRole("button", { name: "Deploy", exact: true }).click();
    secondUrl = await visitWebsite(page, "Harbor v1");
    expect(secondUrl).not.toBe(firstUrl);
    await page.goto("/dashboard");
    await expect(websiteLink(page)).toHaveCount(2);
    await screenshot(page, "phase3-two-applications");
  });

  await test.step("redeploy Northwind and preserve it after a failed replacement", async () => {
    await openProject(page, firstName);
    await approveRevision(page, fixture.revisionA2);
    await revisionPicker(page).selectOption(fixture.revisionA2);
    await page.getByRole("button", { name: "Redeploy", exact: true }).click();
    await expect(activeDeployment(page)).toContainText(fixture.revisionA2);
    expect(await visitWebsite(page, "Northwind v2")).toBe(firstUrl);
    await approveRevision(page, fixture.badRevision);
    await revisionPicker(page).selectOption(fixture.badRevision);
    await page.getByRole("button", { name: "Redeploy", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /^Docker image build failed$/ })).toBeVisible();
    await expect(activeDeployment(page)).toContainText(fixture.revisionA2);
    await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
    expect(await visitWebsite(page, "Northwind v2")).toBe(firstUrl);
    await screenshot(page, "phase3-failed-replacement", true);
  });

  await test.step("roll back, stop, and restart Northwind independently of Harbor", async () => {
    const source = page.getByRole("row").filter({ hasText: fixture.revisionA }).last();
    confirmation(page);
    await source.getByRole("button", { name: "Rollback", exact: true }).click();
    await expect(page.getByText(/Rollback completed/)).toBeVisible({ timeout: 60_000 });
    expect(await visitWebsite(page, "Northwind v1")).toBe(firstUrl);
    confirmation(page, false);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(websiteLink(page)).toBeVisible();
    confirmation(page);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Deployment stopped.")).toBeVisible({ timeout: 60_000 });
    await expect(websiteLink(page)).toHaveCount(0);
    await page.goto("/dashboard");
    await openProject(page, secondName);
    expect(await visitWebsite(page, "Harbor v1")).toBe(secondUrl);
    await page.goto("/dashboard");
    await openProject(page, firstName);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    expect(await visitWebsite(page, "Northwind v1")).toBe(firstUrl);
  });

  await test.step("verify revocation and public ingress withdrawal", async () => {
    confirmation(page);
    await page.getByRole("button", { name: "Revoke public hosting" }).click();
    await expect(page.getByText("Public hosting withdrawal verified.")).toBeVisible({ timeout: 60_000 });
    await expect(websiteLink(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Redeploy", exact: true })).toBeDisabled();
    // A withdrawn hostname either rejects TLS or returns Caddy's deny response.
    const response = await page.request.get(firstUrl, { timeout: 5000 }).catch(() => null);
    if (response) expect(response.status()).toBe(404);
    await screenshot(page, "phase3-withdrawal-verified");
    await page.goto("/dashboard");
    await openProject(page, secondName);
    expect(await visitWebsite(page, "Harbor v1")).toBe(secondUrl);
  });
});

test("private dashboard retains webhook management and Deploy without approval", async ({ page }) => {
  test.skip(mode !== "private", "Requires a disposable private-mode backend and Git fixture");
  await signIn(page);
  await createProject(page, "Private Harbor", fixture.repositoryB);
  await expect(page.getByRole("heading", { name: "Public Hosting" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Webhook configuration" })).toBeVisible();
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  const openApplication = page.getByRole("link", { name: "Open local Docker port" });
  await expect(openApplication).toBeVisible();
  const [website] = await Promise.all([page.waitForEvent("popup"), openApplication.click()]);
  await expect(website.getByText("Harbor v1", { exact: true })).toBeVisible();
  await website.close();
});

test("mocked dashboard handles unverified approval, conflicts and pending withdrawal", async ({ page }) => {
  test.skip(mode !== "mocked", "Uses intercepted API and browser probe responses");
  const id = "11111111-1111-4111-8111-111111111111";
  const commitHash = "a".repeat(40);
  const repositoryUrl = "https://github.com/deployflow-fixture/web";
  const publicHostname = "app-11111111111141118111111111111111.phase3.example.net";
  const publicApplicationUrl = `https://${publicHostname}`;
  const user = { id, email: "fixture@example.net" };
  const deployment = {
    id: "22222222-2222-4222-8222-222222222222", commitHash, status: "RUNNING",
    containerId: "fixture", hostPort: 80, publicAddressIndex: 1, applicationType: "DOCKERFILE",
    createdAt: "2026-01-01T00:00:00Z", startedAt: null, finishedAt: null,
    errorMessage: null, rollbackSourceDeploymentId: null,
  };
  let approvalReadable = false;
  let approvalStatus = "APPROVED";
  let probeStatus = 503;
  await page.addInitScript(() => localStorage.setItem("deployflow.access-token", "fixture-token"));
  await page.route(`${publicApplicationUrl}/**`, (route) => route.fulfill({
    status: probeStatus,
    headers: { "access-control-allow-origin": "*" },
  }));
  await page.route("**/backend-api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) return route.fulfill({ json: { user } });
    if (path.endsWith("/auth/features")) return route.fulfill({ json: { registrationEnabled: false } });
    if (path.endsWith("/public-approval")) {
      if (!approvalReadable) {
        return route.fulfill({ status: 503, json: { error: { message: "Unable to verify public hosting approval" } } });
      }
      let status = 200;
      if (route.request().method() === "DELETE") {
        approvalStatus = approvalStatus === "APPROVED" ? "WITHDRAWAL_PENDING" : "REVOKED";
        if (approvalStatus === "WITHDRAWAL_PENDING") status = 202;
      }
      return route.fulfill({
        status,
        json: { approval: { status: approvalStatus, commits: approvalStatus === "APPROVED" ? [commitHash] : [] } },
      });
    }
    if (path.endsWith("/redeploy")) {
      return route.fulfill({ status: 409, json: { error: { message: "Another project operation is in progress" } } });
    }
    if (path.endsWith("/deployments")) return route.fulfill({ json: { deployments: [deployment] } });
    if (path.endsWith(`/projects/${id}`)) {
      return route.fulfill({ json: { project: {
        id, name: "Mocked app", repositoryUrl, branch: "main", containerPort: 8080, healthCheckPath: "/",
        activeDeployment: deployment, latestDeployment: deployment,
        publicHostingEnabled: true, localApplicationUrl: null, publicHostname,
        publicApplicationUrl, publicProbePath: "/fixture-probe",
        approvalStatus, hostingStatus: "AVAILABLE", certificateStatus: "READY",
      } } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "Fixture route unavailable" } } });
  });

  await page.goto(`/projects/${id}`);
  await expect(page.getByText("Approval unverified")).toBeVisible();
  await expect(websiteLink(page)).toHaveCount(0);
  const redeploy = page.getByRole("button", { name: "Redeploy", exact: true });
  await expect(redeploy).toBeDisabled();

  approvalReadable = true;
  await page.getByRole("button", { name: "Refresh approval" }).click();
  await expect(page.getByText("Public HTTPS unverified")).toBeVisible();
  await expect(websiteLink(page)).toHaveCount(0);
  probeStatus = 204;
  await expect(websiteLink(page)).toBeVisible();
  await revisionPicker(page).selectOption(commitHash);
  await redeploy.click();
  await expect(page.getByText("Another project operation is in progress")).toBeVisible();

  confirmation(page);
  await page.getByRole("button", { name: "Revoke public hosting" }).click();
  await expect(page.getByText("Withdrawal pending", { exact: true })).toBeVisible();
  await expect(websiteLink(page)).toHaveCount(0);
  await expect(redeploy).toBeDisabled();
  await expect(page.getByText("Public hosting withdrawal verified.")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry withdrawal" }).click();
  await expect(page.getByText("Public hosting withdrawal verified.")).toBeVisible();
});
