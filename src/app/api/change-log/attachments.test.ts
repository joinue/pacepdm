import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Files on a post.
 *
 * What is pinned: the file type is judged by its extension, not the type the
 * browser reports (Windows calls a .csv an Excel sheet), and stored under the
 * type the table names; a post carries at most five files.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./[postId]/attachments/route";

const TENANT = "tenant-1";
const POST_ID = "11111111-1111-4111-8111-111111111111";

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  role: { permissions: ["changelog.post"] },
};

function upload(name: string, type = "") {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(64)], name, { type }));
  return POST(
    new NextRequest(`http://localhost/api/change-log/${POST_ID}/attachments`, {
      method: "POST",
      body: form,
    }),
    { params: Promise.resolve({ postId: POST_ID }) }
  );
}

function seed(fileCount = 0) {
  state.fake = createFakeSupabase({
    change_log_posts: [
      { id: POST_ID, tenantId: TENANT, authorId: "user-1", body: "New supplier", deletedAt: null },
    ],
    change_log_files: Array.from({ length: fileCount }, (_, i) => ({
      id: `file-${i}`,
      tenantId: TENANT,
      postId: POST_ID,
      fileName: `sheet-${i}.pdf`,
    })),
  });
}

beforeEach(() => {
  state.user = engineer;
  seed();
});

describe("POST /api/change-log/[postId]/attachments", () => {
  it("takes a .csv that Windows reports as an Excel sheet, and stores it as CSV", async () => {
    const res = await upload("price-sheet.csv", "application/vnd.ms-excel");
    expect(res.status).toBe(200);
    const [row] = state.fake.rows("change_log_files");
    expect(row).toMatchObject({ fileName: "price-sheet.csv", contentType: "text/csv" });
    expect([...state.fake.objects.values()][0].contentType).toBe("text/csv");
  });

  it("takes an old .xls that arrives with no type at all", async () => {
    const res = await upload("BOM rev C.XLS");
    expect(res.status).toBe(200);
    expect(state.fake.rows("change_log_files")[0].contentType).toBe("application/vnd.ms-excel");
  });

  it("takes PowerPoint", async () => {
    expect((await upload("review.pptx")).status).toBe(200);
  });

  it("refuses a type that belongs in the vault, whatever the browser says", async () => {
    const res = await upload("bracket.step", "application/pdf");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/cannot be attached/);
    expect(state.fake.rows("change_log_files")).toHaveLength(0);
  });

  it("takes a fifth file and refuses a sixth", async () => {
    seed(4);
    expect((await upload("fifth.pdf")).status).toBe(200);

    const res = await upload("sixth.pdf");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/5 files/);
    expect(state.fake.rows("change_log_files")).toHaveLength(5);
    expect(state.fake.objects.size).toBe(1);
  });
});
