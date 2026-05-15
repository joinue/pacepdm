import { test, expect, type Page } from "@playwright/test";

/**
 * Share-link end-to-end.
 *
 * Validates the share-token flow added in commits 30 (storage) and 37
 * (access logging). The test:
 *
 *   1. Uploads a small text file.
 *   2. Opens the file's Share dialog and creates a link
 *      (label set, no password, downloads allowed, never expires).
 *   3. Captures the share URL from the link list (it's rendered in a
 *      <code> element).
 *   4. Opens that URL in a fresh anonymous browser context (no cookies,
 *      no storageState) — this is the "anonymous visitor" scenario the
 *      share API must support.
 *   5. Asserts the file name is rendered on the share page.
 *   6. Returns to the share dialog and asserts the activity panel logs
 *      at least one access (the resolve + view-content from step 4).
 *
 * What this does NOT cover:
 *   - Password-gated links (the unlock form is rendered conditionally;
 *     would need a separate test with `password: "..."` on creation).
 *   - The 401 "wrong_password" failure log row.
 *   - Expired/revoked links (the activity panel renders these but they
 *     require time travel or a second create-then-revoke cycle that
 *     would double the runtime — covered by API-level tests if needed).
 */
test.describe("Share link", () => {
  test("anonymous visitor can open a share link and access is logged", async ({
    page,
    browser,
  }) => {
    const fileName = `e2e-share-${Date.now()}.txt`;
    const fileBody = `Share test content ${Date.now()}`;

    await uploadTextFile(page, fileName, fileBody);

    // Open the file's detail panel and the Share dialog.
    await page.getByText(fileName).first().click();
    await expect(page.getByRole("tab", { name: /properties/i })).toBeVisible({
      timeout: 10000,
    });

    // Open the more-actions menu in the detail panel header.
    const moreButton = page.locator('button:has(svg.lucide-more-horizontal), button[aria-haspopup="menu"]').first();
    await moreButton.click();
    await page.getByRole("menuitem", { name: /share link/i }).click();

    // Share dialog opens. Click "Create link" with default options
    // (no password, never expires, downloads allowed).
    await expect(page.getByRole("dialog").getByText(/create a new link/i)).toBeVisible({
      timeout: 5000,
    });
    await page.getByRole("button", { name: /create link/i }).click();
    await expect(page.getByText(/share link created/i)).toBeVisible({
      timeout: 10000,
    });

    // Pull the URL out of the active-links list. It's rendered in a
    // <code> element inside the dialog.
    const code = page.locator('[role="dialog"] code').first();
    await expect(code).toBeVisible({ timeout: 5000 });
    const shareUrl = (await code.textContent())?.trim();
    expect(shareUrl, "share URL must render in the link list").toBeTruthy();
    expect(shareUrl).toMatch(/\/share\//);

    // Open the link in a fresh, unauthenticated context. NOT using the
    // saved storageState — this is the "anonymous public visitor" path.
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    try {
      await anonPage.goto(shareUrl!);
      // The share viewer renders the file name as the page heading.
      await expect(anonPage.getByText(fileName)).toBeVisible({ timeout: 15000 });
      // Text files render with TextPreview component (a <pre>). Loose
      // assertion: confirm something file-content-y rendered.
      await expect(anonPage.locator("pre, object, img").first()).toBeVisible({
        timeout: 15000,
      });
    } finally {
      await anonPage.close();
      await anon.close();
    }

    // Back in the original tab — open the activity panel for our link.
    // The "0 views" / "1 views" button toggles the panel.
    const viewsToggle = page
      .locator('[role="dialog"] button[title="View access activity"]')
      .first();
    await viewsToggle.click();

    // The panel either shows rows or "No accesses yet." Logging is
    // best-effort (it's wrapped in side-effect helpers in the API), so
    // we accept either: the meaningful assertion is the *count* on the
    // toggle, which the API increments synchronously.
    // Re-fetch the toggle text after a brief settle for the API to flush.
    await expect(async () => {
      const t = await viewsToggle.textContent();
      // Match "1 view" / "2 views" / etc. — anything > 0.
      expect(t).toMatch(/\b[1-9]\d*\s+view/i);
    }).toPass({ timeout: 15000 });
  });
});

async function uploadTextFile(page: Page, name: string, body: string) {
  await page.goto("/vault");
  await expect(page.locator('[data-testid="vault-toolbar"], h2').first()).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: /upload/i }).click();
  await expect(page.getByText(/upload file/i).first()).toBeVisible();
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(body),
  });
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText(/uploaded/i)).toBeVisible({ timeout: 15000 });
}
