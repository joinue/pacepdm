import { test, expect } from "@playwright/test";

/**
 * ECO release smoke flow.
 *
 * Drives the ECO state machine as far as the test tenant's workflow
 * config allows. The full DRAFT → SUBMITTED → IN_REVIEW → APPROVED →
 * IMPLEMENTED chain depends on:
 *   - An approval workflow being configured (or not — DRAFT can submit
 *     to nothing if no workflow matches, but reviewers can't progress).
 *   - The current test user being a member of the right approval group.
 *   - At least one ECO item linked (the IMPLEMENTED transition is the
 *     one that actually freezes files; without items it's a no-op).
 *
 * Rather than seed all of that, this test exercises what we *can*
 * deterministically validate against any tenant configuration:
 *   1. Creating an ECO succeeds and the new ECO is selectable.
 *   2. The detail panel renders the correct status badge for DRAFT.
 *   3. The status-transition controls render at least one button
 *      (DRAFT always has "Submit for Review" per status-flows).
 *   4. Clicking submit either succeeds (status flips, toast) or surfaces
 *      a clear error toast — both are real code paths and neither
 *      should crash.
 *
 * Freeze enforcement is not directly verified here — it requires an
 * implemented ECO with linked files, which can't be built up in a
 * single test run without a pre-seeded workflow. The unit/API tests in
 * src/app/api/files/[fileId]/metadata/route.test.ts cover the actual
 * "frozen file rejects edits" branch.
 */
test.describe("ECO release flow", () => {
  test("create an ECO and attempt to submit for review", async ({ page }) => {
    const title = `E2E Release Test ${Date.now()}`;

    await page.goto("/ecos");
    await expect(
      page.getByRole("heading", { name: /eco|engineering change/i }).first()
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: /new eco/i }).click();
    await expect(page.getByRole("dialog").getByText(/new engineering change order/i)).toBeVisible({
      timeout: 5000,
    });

    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description").fill("E2E ECO release smoke test");

    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByText(/eco created/i)).toBeVisible({ timeout: 10000 });

    // After creation the ECOs view auto-selects the new ECO. The status
    // badge for a freshly-created ECO is "Draft".
    await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/draft/i).first()).toBeVisible({ timeout: 10000 });

    // The DRAFT state always offers "Submit for Review" per
    // VALID_TRANSITIONS in src/app/(dashboard)/ecos/constants.ts.
    const submit = page.getByRole("button", { name: /submit for review/i });
    await expect(submit).toBeVisible({ timeout: 5000 });
    await submit.click();

    // The ECO has zero items, which triggers the
    // "Submitting it will start an approval workflow with nothing
    // attached. Reviewers will have no items to assess. Continue anyway?"
    // confirmation dialog. Accept it.
    const continueButton = page.getByRole("button", { name: /continue/i }).last();
    if (await continueButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await continueButton.click();
    }

    // Either the status flips or we get an error toast (e.g.
    // "No matching approval workflow"). Both are real outcomes for
    // unconfigured tenants — we just need the test not to hang.
    await expect(async () => {
      const successCopy = page.getByText(/submitted for approval|status changed to submitted/i);
      const errorCopy = page.getByText(/no.*workflow|failed|error|workflow is required/i);
      const seen =
        (await successCopy
          .first()
          .isVisible()
          .catch(() => false)) ||
        (await errorCopy
          .first()
          .isVisible()
          .catch(() => false));
      expect(seen, "Submit either succeeds with a toast or surfaces an error").toBeTruthy();
    }).toPass({ timeout: 15000 });
  });
});
