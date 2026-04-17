import { test, expect } from "@playwright/test";

test.describe("Golden path", () => {
  test("dashboard loads with getting-started checklist", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Dashboard")).toBeVisible();
    await expect(page.getByText("Welcome back")).toBeVisible();
  });

  test("create a part", async ({ page }) => {
    await page.goto("/parts");
    await expect(page.getByText("Parts Library")).toBeVisible();

    await page.getByRole("button", { name: "New Part" }).click();
    await expect(page.getByText("New Part")).toBeVisible();

    // Fill the form
    await page.getByLabel("Name").fill("E2E Test Housing");
    await page.getByLabel("Description").fill("Created by E2E test");

    await page.getByRole("button", { name: "Create Part" }).click();

    // Should see success toast and the part in the list
    await expect(page.getByText("Part created")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("E2E Test Housing")).toBeVisible();
  });

  test("upload a file to the vault", async ({ page }) => {
    await page.goto("/vault");

    // Wait for the vault to load
    await expect(page.locator('[data-testid="vault-toolbar"], h2')).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /upload/i }).click();
    await expect(page.getByText("Upload File")).toBeVisible();

    // Create a small test file in memory and upload it
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "e2e-test-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("E2E test file content"),
    });

    await expect(page.getByText("e2e-test-file.txt")).toBeVisible();
    await page.getByRole("button", { name: "Upload" }).click();

    await expect(page.getByText("uploaded")).toBeVisible({ timeout: 10000 });
  });

  test("create a BOM", async ({ page }) => {
    await page.goto("/boms");

    await page.getByRole("button", { name: /new bom/i }).click();
    await expect(page.getByText(/new bom|create bom/i)).toBeVisible();

    await page.getByLabel("Name").fill("E2E Test Assembly BOM");

    await page.getByRole("button", { name: /create/i }).click();

    await expect(page.getByText(/created|success/i)).toBeVisible({ timeout: 10000 });
  });

  test("create an ECO", async ({ page }) => {
    await page.goto("/ecos");

    await page.getByRole("button", { name: /new eco/i }).click();

    await page.getByLabel("Title").fill("E2E Test Change Order");
    await page.getByLabel("Description").fill("Created by Playwright E2E test");

    await page.getByRole("button", { name: /create/i }).click();

    await expect(page.getByText(/created|success/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("E2E Test Change Order")).toBeVisible();
  });

  test("navigate all main sections", async ({ page }) => {
    // Verify every sidebar link resolves without error
    const sections = [
      { path: "/", heading: "Dashboard" },
      { path: "/vault", heading: /vault/i },
      { path: "/parts", heading: "Parts Library" },
      { path: "/boms", heading: /bom/i },
      { path: "/ecos", heading: /eco|engineering change/i },
      { path: "/approvals", heading: /approval/i },
    ];

    for (const { path, heading } of sections) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 10000 });
      // No uncaught errors — if a page crashes, Playwright will fail
    }
  });
});
