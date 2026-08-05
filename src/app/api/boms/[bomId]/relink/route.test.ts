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
    let inSet: unknown[] | null = null;
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const rows = () => {
      let out = (tables[table] ?? []) as Record<string, unknown>[];
      for (const [k, v] of Object.entries(filters)) out = out.filter((r) => r[k] === v);
      if (inSet) out = out.filter((r) => inSet!.includes(r.bomId));
      return out;
    };

    for (const m of ["select", "is", "not", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (...a: unknown[]) => {
      filters[a[0] as string] = a[1];
      return chain;
    };
    chain.in = (...a: unknown[]) => {
      inSet = a[1] as unknown[];
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
