import { test as setup, expect } from "@playwright/test";
import path from "path";

const authFile = path.join(__dirname, ".auth", "user.json");

/**
 * Authenticates once and saves the browser storage state so all other
 * tests reuse the session without logging in again.
 *
 * Requires E2E_EMAIL and E2E_PASSWORD environment variables pointing
 * at a test account in your Supabase project.
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "E2E_EMAIL and E2E_PASSWORD env vars are required. " +
      "Create a test account in your Supabase project and set them."
    );
  }

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();

  // Wait for redirect to dashboard
  await expect(page).toHaveURL("/", { timeout: 15000 });
  await expect(page.getByText("Dashboard")).toBeVisible();

  await page.context().storageState({ path: authFile });
});
