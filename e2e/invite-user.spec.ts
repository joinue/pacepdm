import { test, expect } from "@playwright/test";

/**
 * Invite-acceptance flow.
 *
 * Scope: drives the *admin-side* of the invite — opening the dialog,
 * filling email/name/role, submitting, and verifying the success toast
 * + the new row in the user table. The acceptance side (clicking the
 * email link, setting a password, landing in the dashboard) requires
 * intercepting the email Resend sends, which the current test rig
 * doesn't have. That half is documented in the report.
 *
 * The email is a unique alias-style address per run so the test is
 * idempotent — the API rejects re-inviting the same address.
 */
test.describe("Invite user", () => {
  test("admin can invite a teammate", async ({ page }) => {
    // Use a unique alias on every run so the test is rerunnable. Most
    // mailbox providers ignore +suffixes, so this routes to the same
    // inbox in real usage but the API treats them as distinct addresses.
    const baseEmail = process.env.E2E_INVITE_EMAIL_BASE || "qa+invite@example.com";
    const [local, domain] = baseEmail.split("@");
    const uniq = `${local}-${Date.now()}@${domain || "example.com"}`;

    await page.goto("/admin/users");

    // The page may render an access-denied state for non-admin test
    // accounts — treat that as a configuration problem and surface it
    // clearly rather than silently passing.
    const heading = page.getByRole("heading", { name: /users/i }).first();
    await expect(heading, "test account must have admin.users permission").toBeVisible({
      timeout: 10000,
    });

    // Capture the existing row count so we can assert one was added.
    // `tr` count is robust — the table always has one header row.
    const rowsBefore = await page.locator("tbody tr").count();

    await page.getByRole("button", { name: /invite user/i }).click();
    await expect(page.getByText(/invite user/i).first()).toBeVisible();

    await page.getByLabel("Full Name").fill("E2E Invitee");
    await page.getByLabel("Email").fill(uniq);

    // Pick the first role in the dropdown — every tenant ships with at
    // least Admin + Member, so this never finds an empty list.
    await page.getByLabel("Role").click();
    await page.locator('[role="option"]').first().click();

    await page.getByRole("button", { name: /^invite$/i }).click();

    // The success toast text varies depending on whether the email was
    // already in auth — accept either copy.
    await expect(
      page.getByText(/invitation email sent|added to workspace/i)
    ).toBeVisible({ timeout: 15000 });

    // New row should appear in the table for the invited address.
    await expect(page.getByText(uniq)).toBeVisible();
    const rowsAfter = await page.locator("tbody tr").count();
    expect(rowsAfter).toBe(rowsBefore + 1);
  });
});
