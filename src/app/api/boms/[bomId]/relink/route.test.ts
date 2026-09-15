import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Relink rewrites BOM structure, so the tests that matter are the refusals:
 * it must never re-point a line that is already linked, never match two
 * genuinely different part numbers, and never close a cycle. The happy path
 * is one case; the guards are five.
 */

const { tables, updates, mockFrom } = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {};
  const updates: Array<{ table: string; data: Record<string, unknown>; id: unknown }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const rows = () => {
      let out = (tables[table] ?? []) as Record<string, unknown>[];
      for (const [k, v] of Object.entries(filters)) out = out.filter((r) => r[k] === v);
      for (const [k, vs] of Object.entries(inFilters)) out = out.filter((r) => vs.includes(r[k]));
      return out;
    };

    for (const m of ["select", "is", "not", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (...a: unknown[]) => {
      filters[a[0] as string] = a[1];
      return chain;
    };
    chain.in = (...a: unknown[]) => {
      inFilters[a[0] as string] = a[1] as unknown[];
      return chain;
    };
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.update = (data: unknown) => {
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = (...a: unknown[]) => {
        updates.push({ table, data: data as Record<string, unknown>, id: a[1] });
        return c;
      };
      c.then = ((resolve: (v: unknown) => void) => resolve({ data: null, error: null })) as never;
      return c;
    };
    chain.then = ((resolve: (v: unknown) => void) =>
      resolve({ data: rows(), error: null })) as never;
    return chain;
  }

  return { tables, updates, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as { id: string; tenantId: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

const CASTING = "11111111-1111-4111-8111-111111111111";
const TOP = "22222222-2222-4222-8222-222222222222";

const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };
const viewer = { id: "user-2", tenantId: "tenant-1", role: { permissions: ["file.view"] } };

function req() {
  return new NextRequest(`http://localhost/api/boms/${CASTING}/relink`, { method: "POST" });
}
const params = Promise.resolve({ bomId: CASTING });

/**
 * The real NANO-1000S situation, reduced to two BOMs.
 *
 * `tenantId` is on the BOM and part rows because `withTenant` hands the
 * handler a scoped client that applies `.eq("tenantId", caller)` to every
 * read — so omitting it silently makes every query return nothing, and the
 * cross-tenant test would pass whether or not the scoping existed.
 * `bom_items` has no tenantId, mirroring the real schema.
 */
function nanoState(itemOverrides: Record<string, unknown> = {}, tenantId = "tenant-1") {
  tables["boms"] = [
    {
      id: CASTING,
      tenantId,
      name: "NANO-1000S Casting-Components",
      revision: "A",
      deletedAt: null,
    },
    { id: TOP, tenantId, name: "NANO-1000S", revision: "A", deletedAt: null },
  ];
  tables["bom_items"] = [
    {
      id: "item-1",
      bomId: TOP,
      linkedBomId: null,
      itemNumber: "2",
      // The typo: missing hyphen.
      partNumber: "NANO1000S Casting-Components",
      name: "NANO1000S Casting-Components",
      quantity: 1,
      unit: "ea",
      unitCost: null,
      ...itemOverrides,
    },
  ];
  tables["parts"] = [
    {
      id: "part-correct",
      tenantId,
      partNumber: "NANO-1000S Casting-Components",
      deletedAt: null,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  updates.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("POST /api/boms/[bomId]/relink", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    nanoState();
    expect((await POST(req(), { params })).status).toBe(401);
  });

  it("returns 403 without FILE_EDIT", async () => {
    mockTenantUser.current = viewer;
    nanoState();
    expect((await POST(req(), { params })).status).toBe(403);
  });

  it("returns 404 for a BOM in another tenant", async () => {
    // The rows exist, but belong to tenant-OTHER. The scoped client's
    // tenantId filter is what makes this a 404 rather than a repair.
    nanoState({}, "tenant-OTHER");
    expect((await POST(req(), { params })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it("repairs the line, pointing it at the BOM and fixing the part number", async () => {
    nanoState();
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("bom_items");
    expect(updates[0].id).toBe("item-1");
    expect(updates[0].data).toMatchObject({
      linkedBomId: CASTING,
      partNumber: "NANO-1000S Casting-Components",
      partId: "part-correct",
    });

    const body = await res.json();
    expect(body.repaired).toEqual([
      {
        bomId: TOP,
        bomName: "NANO-1000S",
        itemId: "item-1",
        itemNumber: "2",
        wasPartNumber: "NANO1000S Casting-Components",
      },
    ]);
  });

  it("reports the part number left behind, without deleting it", async () => {
    nanoState();
    const body = await (await POST(req(), { params })).json();
    expect(body.orphanedParts).toEqual(["NANO1000S Casting-Components"]);
    // Nothing was written to `parts`.
    expect(updates.every((u) => u.table !== "parts")).toBe(true);
  });

  it("refuses to re-point a line that is already linked somewhere", async () => {
    nanoState({ linkedBomId: "some-other-bom" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("does not match a genuinely different part number", async () => {
    // Differs by a digit, not by punctuation — never a relink candidate.
    nanoState({ partNumber: "NANO-2000S Casting-Components" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing to relink/i);
    expect(updates).toHaveLength(0);
  });

  it("leaves a correctly-spelled but unlinked line alone", async () => {
    // An exact-name match that is unlinked is a different problem, and
    // guessing at it is not this route's job.
    nanoState({ partNumber: "NANO-1000S Casting-Components" });
    expect((await POST(req(), { params })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("refuses a relink that would create a cycle", async () => {
    // Casting already contains NANO-1000S, so linking casting *into*
    // NANO-1000S would close the loop.
    nanoState();
    (tables["bom_items"] as Record<string, unknown>[]).push({
      id: "item-2",
      bomId: CASTING,
      linkedBomId: TOP,
      itemNumber: "1",
      partNumber: "NANO-1000S",
      name: "NANO-1000S",
      quantity: 1,
      unit: "ea",
      unitCost: null,
    });

    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cycle/i);
    expect(updates).toHaveLength(0);
  });

  /**
   * A repair is still an edit to the parent's lines. A released or obsolete
   * parent is issued, and one on an in-flight ECO has to reach
   * implementation exactly as reviewed — so those lines are left alone.
   */
  describe("locked parent BOMs", () => {
    const OTHER_PARENT = "33333333-3333-4333-8333-333333333333";

    /** A second, editable parent with the same typo, so one line can land. */
    function withEditableSecondParent() {
      (tables["boms"] as Record<string, unknown>[]).push({
        id: OTHER_PARENT,
        tenantId: "tenant-1",
        name: "NANO-2000S",
        revision: "A",
        status: "DRAFT",
        deletedAt: null,
      });
      (tables["bom_items"] as Record<string, unknown>[]).push({
        id: "item-3",
        bomId: OTHER_PARENT,
        linkedBomId: null,
        itemNumber: "4",
        partNumber: "NANO1000S Casting-Components",
        name: "NANO1000S Casting-Components",
        quantity: 1,
        unit: "ea",
        unitCost: null,
      });
    }

    function topBom() {
      return (tables["boms"] as Record<string, unknown>[]).find((b) => b.id === TOP)!;
    }

    it.each(["RELEASED", "OBSOLETE"])(
      "skips the line on a %s parent and reports it, repairing the rest",
      async (status) => {
        nanoState();
        topBom().status = status;
        withEditableSecondParent();

        const res = await POST(req(), { params });
        expect(res.status).toBe(200);

        expect(updates.map((u) => u.id)).toEqual(["item-3"]);
        const body = await res.json();
        expect(body.repaired.map((r: { itemId: string }) => r.itemId)).toEqual(["item-3"]);
        expect(body.skipped).toEqual([
          expect.objectContaining({ bomId: TOP, bomName: "NANO-1000S", itemId: "item-1" }),
        ]);
        expect(body.skipped[0].reason).toMatch(new RegExp(status, "i"));
        // The skipped line still carries the misspelling, so it is not orphaned.
        expect(body.orphanedParts).toEqual([]);
      }
    );

    it("skips a parent carried by an approved ECO, naming the ECO", async () => {
      nanoState();
      topBom().status = "DRAFT";
      withEditableSecondParent();
      tables["eco_items"] = [{ ecoId: "eco-1", bomId: TOP }];
      tables["ecos"] = [
        {
          id: "eco-1",
          tenantId: "tenant-1",
          ecoNumber: "ECO-0042",
          status: "APPROVED",
          deletedAt: null,
        },
      ];

      const body = await (await POST(req(), { params })).json();
      expect(updates.map((u) => u.id)).toEqual(["item-3"]);
      expect(body.skipped[0].reason).toContain("ECO-0042");
    });

    it("refuses with 409 and writes nothing when every candidate is locked", async () => {
      nanoState();
      topBom().status = "RELEASED";

      const res = await POST(req(), { params });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/nothing was relinked/i);
      expect(body.details.skipped).toHaveLength(1);
      expect(updates).toHaveLength(0);
      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  it("logs the repair against the BOM that was relinked", async () => {
    nanoState();
    await POST(req(), { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bom.relink",
        entityType: "bom",
        entityId: CASTING,
        userId: "user-1",
      })
    );
  });
});
