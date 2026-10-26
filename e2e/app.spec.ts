import { expect, test } from "@playwright/test";

/**
 * Core user journey in a real browser against the production build:
 * register → create workflow → add steps in the visual editor → save →
 * test run → publish → see the execution, plus the template + public form path.
 */
const password = "correct horse battery staple";

test("register, build, test-run and publish a workflow", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), E2E/ })).toBeVisible();

  // Command palette navigation.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search" }).fill("Workflows");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/workflows$/);

  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByPlaceholder("e.g. Qualify inbound leads").fill("E2E greeting");
  await page.getByRole("button", { name: "Create and open editor" }).click();
  await expect(page).toHaveURL(/\/workflows\/wf_/);

  // Add a step from the palette (auto-connects to the selected trigger) and configure it.
  await page.locator(".flow-node", { hasText: "Manual trigger" }).click();
  await page.getByRole("textbox", { name: "Search apps and actions" }).fill("Set fields");
  await page.getByRole("button", { name: /Set fields/ }).first().click();
  await expect(page.locator(".flow-node", { hasText: "Set fields" })).toBeVisible();
  await page.getByRole("textbox", { name: "Step name" }).fill("Greeting");
  await page.getByRole("textbox", { name: "Key" }).first().fill("greeting");
  await page.getByRole("textbox", { name: /Value for greeting/ }).fill("Hello {{ trigger.name }}");

  // Undo / redo round trip on the rename.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await expect(page.getByRole("button", { name: /0 errors/ })).toBeVisible();

  // Test run with sample data.
  await page.getByRole("button", { name: "Test" }).click();
  await page.locator(".modal textarea").fill('{ "name": "Ada" }');
  await page.getByRole("button", { name: "Run draft" }).click();
  await expect(page.locator(".card", { hasText: "Test run" }).getByText("succeeded")).toBeVisible({ timeout: 30_000 });

  // Publish.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish & activate" }).click();
  await expect(page.getByText("v1 live")).toBeVisible();

  // Execution history shows the run with the mapped output.
  await page.goto("/executions");
  await page.getByRole("cell", { name: "E2E greeting" }).first().click();
  const step = page.locator("details.timeline-step", { hasText: "Greeting" });
  await step.locator("summary").click();
  await expect(step.getByText('"greeting": "Hello Ada"').last()).toBeVisible(); // last = the step's output panel
});

test("template + public form triggers a run that waits for approval", async ({ page, browser }) => {
  const email = `e2e-tpl-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await page.goto("/templates");
  await page.locator(".tpl-card", { hasText: "Lead intake" }).getByRole("button", { name: "Use template" }).click();
  const formLink = page.getByRole("link", { name: /\/f\// });
  const href = await formLink.getAttribute("href");
  await page.getByRole("button", { name: "Open in editor" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish & activate" }).click();
  await expect(page.getByText("v1 live")).toBeVisible();

  // An anonymous visitor submits the public form.
  const visitor = await browser.newPage();
  await visitor.goto(href!);
  await visitor.getByLabel("Your name *").fill("Grace Hopper");
  await visitor.getByLabel("Work email *").fill("grace@example.com");
  await visitor.getByLabel("How can we help?").fill("We have budget and need a demo next week");
  await visitor.getByRole("button", { name: "Submit" }).click();
  await expect(visitor.getByText(/response has been recorded/)).toBeVisible();

  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: /Send reply to grace@example.com/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.goto("/outbox");
  await expect(page.getByRole("cell", { name: "grace@example.com" })).toBeVisible({ timeout: 30_000 });
});

test("theme switch and sidebar collapse persist", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Email").fill(`e2e-theme-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".app")).toHaveClass(/collapsed/);
});
