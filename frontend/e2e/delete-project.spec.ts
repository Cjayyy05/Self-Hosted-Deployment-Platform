import { expect, test } from "@playwright/test";

import type { Project } from "../src/lib/api";

test("project deletion requires exact confirmation, handles failure, and navigates after a 204", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const date = "2026-01-01T00:00:00.000Z";
  const project = {
    id, userId: id, name: "Delete Fixture", hostnameLabel: "app-11111111111141118111111111111111",
    repositoryUrl: "https://github.com/example/app", branch: "main", containerPort: 8080,
    healthCheckPath: "/", createdAt: date, updatedAt: date, localApplicationUrl: null,
    activeDeployment: null, latestDeployment: null, hostingStatus: "UNAVAILABLE",
    publicHostingEnabled: true, approvalStatus: "UNAPPROVED",
  } satisfies Project;
  let deleteRequests = 0;
  let deleted = false;
  let rejectFirstRequest = () => {};
  const firstRequest = new Promise<void>((resolve) => { rejectFirstRequest = resolve; });
  await page.addInitScript(() => localStorage.setItem("deployflow.access-token", "local-test-token"));
  await page.route("**/backend-api/**", async (route) => {
    const request = route.request();
    switch (new URL(request.url()).pathname) {
      case "/backend-api/auth/me":
        return route.fulfill({ json: { user: { id, email: "operator@example.test", createdAt: date, updatedAt: date } } });
      case "/backend-api/auth/features":
        return route.fulfill({ json: { registrationEnabled: false } });
      case "/backend-api/projects":
        return route.fulfill({ json: { projects: deleted ? [] : [project] } });
      case `/backend-api/projects/${id}/deployments`:
        return route.fulfill({ json: { deployments: [] } });
      case `/backend-api/projects/${id}/public-approval`:
        return route.fulfill({ json: { approval: { status: "UNAPPROVED" } } });
      case `/backend-api/projects/${id}`:
        if (request.method() !== "DELETE") return route.fulfill({ json: { project } });
        expect(await request.headerValue("authorization")).toBe("Bearer local-test-token");
        deleteRequests += 1;
        if (deleteRequests === 1) {
          await firstRequest;
          return route.fulfill({ status: 502, json: { error: { message: "Project resources could not be cleaned up." } } });
        }
        deleted = true;
        return route.fulfill({ status: 204 });
      default:
        return route.abort();
    }
  });

  await page.goto(`/projects/${id}`);
  const zone = page.getByRole("region", { name: "Danger Zone" });
  const open = zone.getByRole("button", { name: "Delete Project", exact: true });
  const confirm = zone.getByRole("button", { name: "Permanently Delete Project" });
  const name = zone.getByRole("textbox");
  const cancel = zone.getByRole("button", { name: "Cancel" });
  await expect(zone.getByText(/The original GitHub repository stays intact/)).toBeVisible();

  await open.click();
  await expect(name).toBeFocused();
  await name.fill(project.name.toLowerCase());
  await expect(confirm).toBeDisabled();
  await name.press("Enter");
  expect(deleteRequests).toBe(0);
  await name.fill(project.name);
  await expect(confirm).toBeEnabled();
  await cancel.click();
  await expect(name).toHaveCount(0);
  expect(deleteRequests).toBe(0);

  await open.click();
  await expect(name).toHaveValue("");
  await name.fill(project.name);
  await zone.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(zone.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(name).toBeDisabled();
  await expect.poll(() => deleteRequests).toBe(1);
  rejectFirstRequest();

  await expect(zone.getByRole("alert")).toHaveText("Project resources could not be cleaned up.");
  await expect(page).toHaveURL(`/projects/${id}`);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible();
  await expect(page.getByText(project.name, { exact: true })).toHaveCount(0);
  expect(deleteRequests).toBe(2);
});
