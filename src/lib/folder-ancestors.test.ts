import { describe, it, expect, vi } from "vitest";
import { getFolderAncestors, type FolderRow } from "./folder-ancestors";

const TENANT = "t1";

/**
 * A `folders` table as the walk queries it: by id, filtered by tenant. Records
 * every lookup so the tests can assert how many round trips a trail costs.
 */
function fakeDb(rows: FolderRow[]) {
  const lookups: string[] = [];
  const from = vi.fn(() => ({
    select: () => ({
      eq: (_col: string, id: string) => ({
        eq: (_tenantCol: string, tenantId: string) => ({
          single: async () => {
            lookups.push(id);
            const row = rows.find((r) => r.id === id && r.tenantId === tenantId) ?? null;
            return { data: row };
          },
        }),
      }),
    }),
  }));
  return { db: { from } as never, lookups };
}

function row(id: string, parentId: string | null, name = id, tenantId = TENANT): FolderRow {
  return { id, name, parentId, path: `/${name}`, tenantId };
}

describe("getFolderAncestors", () => {
  it("returns the trail from the root, naming the root Vault", async () => {
    const { db } = fakeDb([row("root", null, "Acme"), row("A", "root"), row("B", "A")]);

    const trail = await getFolderAncestors(db, TENANT, "B");

    expect(trail?.folder.id).toBe("B");
    expect(trail?.ancestors).toEqual([
      { id: "root", name: "Vault" },
      { id: "A", name: "A" },
      { id: "B", name: "B" },
    ]);
  });

  it("is one lookup per level", async () => {
    const { db, lookups } = fakeDb([row("root", null), row("A", "root"), row("B", "A")]);
    await getFolderAncestors(db, TENANT, "B");
    expect(lookups).toEqual(["B", "A", "root"]);
  });

  it("returns null for a folder outside the tenant", async () => {
    const { db } = fakeDb([row("X", null, "X", "other-tenant")]);
    expect(await getFolderAncestors(db, TENANT, "X")).toBeNull();
  });

  it("stops at a parent that is not in the tenant", async () => {
    const { db } = fakeDb([row("A", "foreign"), row("foreign", null, "foreign", "other-tenant")]);
    const trail = await getFolderAncestors(db, TENANT, "A");
    expect(trail?.ancestors).toEqual([{ id: "A", name: "A" }]);
  });

  it("ends a looping parent chain instead of hanging", async () => {
    const { db, lookups } = fakeDb([row("A", "B"), row("B", "A")]);
    const trail = await getFolderAncestors(db, TENANT, "A");
    expect(trail?.ancestors.map((a) => a.id)).toEqual(["B", "A"]);
    expect(lookups.length).toBeLessThanOrEqual(3);
  });
});
