/**
 * The scoped client is the control that makes tenant isolation correct by
 * construction, so these tests assert on the filters and payloads it produces
 * rather than on any database behaviour.
 *
 * The fake Supabase client records every call. That is the property under test:
 * that `.eq("tenantId", …)` was applied, and that an insert carried the stamp.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createScopedDb, TENANT_SCOPED_TABLES, TENANT_CHILD_TABLES } from "./tenant-db";

const TENANT = "tenant-a";

interface Recorded {
  table: string;
  op: string;
  values?: unknown;
  filters: Array<[string, unknown]>;
}

/** A fake Supabase client that records the chain instead of executing it. */
function fakeClient() {
  const calls: Recorded[] = [];

  function filterBuilder(record: Recorded) {
    const builder = {
      eq(column: string, value: unknown) {
        record.filters.push([column, value]);
        return builder;
      },
      is() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      select() {
        return builder;
      },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select: () => {
          const r: Recorded = { table, op: "select", filters: [] };
          calls.push(r);
          return filterBuilder(r);
        },
        insert: (values: unknown) => {
          const r: Recorded = { table, op: "insert", values, filters: [] };
          calls.push(r);
          return filterBuilder(r);
        },
        upsert: (values: unknown) => {
          const r: Recorded = { table, op: "upsert", values, filters: [] };
          calls.push(r);
          return filterBuilder(r);
        },
        update: (values: unknown) => {
          const r: Recorded = { table, op: "update", values, filters: [] };
          calls.push(r);
          return filterBuilder(r);
        },
        delete: () => {
          const r: Recorded = { table, op: "delete", filters: [] };
          calls.push(r);
          return filterBuilder(r);
        },
      };
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    storage: { from: vi.fn() },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

function scoped() {
  const { client, calls } = fakeClient();
  return { db: createScopedDb(TENANT, client), calls };
}

describe("createScopedDb — tenant-scoped tables", () => {
  it("applies the tenant filter to a select", () => {
    const { db, calls } = scoped();
    db.from("boms").select("*");
    expect(calls[0].filters).toContainEqual(["tenantId", TENANT]);
  });

  it("keeps the tenant filter alongside the caller's own filters", () => {
    const { db, calls } = scoped();
    db.from("ecos").select("*").eq("id", "eco-1").is("deletedAt", null);
    expect(calls[0].filters).toContainEqual(["tenantId", TENANT]);
    expect(calls[0].filters).toContainEqual(["id", "eco-1"]);
  });

  it("applies the tenant filter to update and delete", () => {
    const { db, calls } = scoped();
    db.from("parts").update({ name: "x" }).eq("id", "p1");
    db.from("parts").delete().eq("id", "p1");
    expect(calls[0].filters).toContainEqual(["tenantId", TENANT]);
    expect(calls[1].filters).toContainEqual(["tenantId", TENANT]);
  });

  it("stamps the tenant on a single-row insert", () => {
    const { db, calls } = scoped();
    db.from("boms").insert({ name: "Frame" });
    expect(calls[0].values).toEqual({ name: "Frame", tenantId: TENANT });
  });

  it("stamps the tenant on every row of a bulk insert", () => {
    const { db, calls } = scoped();
    db.from("boms").insert([{ name: "A" }, { name: "B" }]);
    expect(calls[0].values).toEqual([
      { name: "A", tenantId: TENANT },
      { name: "B", tenantId: TENANT },
    ]);
  });

  it("stamps the tenant on upsert", () => {
    const { db, calls } = scoped();
    db.from("vendors").upsert({ id: "v1", name: "Acme" });
    expect(calls[0].values).toEqual({ id: "v1", name: "Acme", tenantId: TENANT });
  });

  it("allows an insert that names the caller's own tenant", () => {
    const { db, calls } = scoped();
    db.from("boms").insert({ name: "A", tenantId: TENANT });
    expect(calls[0].values).toEqual({ name: "A", tenantId: TENANT });
  });

  it("refuses an insert that names a different tenant", () => {
    const { db } = scoped();
    expect(() => db.from("boms").insert({ name: "A", tenantId: "tenant-b" })).toThrow(
      /Refusing to write/
    );
  });

  it("refuses an update that would move a row to another tenant", () => {
    const { db } = scoped();
    expect(() => db.from("boms").update({ tenantId: "tenant-b" })).toThrow(/Refusing to move/);
  });

  it("scopes the tenants table by its primary key", () => {
    const { db, calls } = scoped();
    db.from("tenants").select("*");
    expect(calls[0].filters).toContainEqual(["id", TENANT]);
  });
});

describe("createScopedDb — child tables", () => {
  it("passes child tables through without a filter", () => {
    // bom_items has no tenantId column, so there is nothing to filter on. The
    // handler is responsible for loading the parent BOM through the scoped
    // client first. Asserting this explicitly keeps the behaviour honest: the
    // wrapper does not pretend these are protected.
    const { db, calls } = scoped();
    // lint-conventions-allow: child-table-direct-query — this test exists to assert
    // the unfiltered passthrough; suppressing it here is the point of the test.
    db.from("bom_items").select("*").eq("bomId", "bom-1");
    expect(calls[0].filters).not.toContainEqual(["tenantId", TENANT]);
    expect(calls[0].filters).toContainEqual(["bomId", "bom-1"]);
  });

  it("does not stamp a tenant on a child insert", () => {
    const { db, calls } = scoped();
    // lint-conventions-allow: child-table-direct-query — asserts that a child insert
    // is not stamped with a tenant, which is the behaviour under test.
    db.from("bom_items").insert({ bomId: "bom-1", quantity: 2 });
    expect(calls[0].values).toEqual({ bomId: "bom-1", quantity: 2 });
  });
});

describe("createScopedDb — unscoped escape hatch", () => {
  it("returns the raw client when given a reason", () => {
    const { db } = scoped();
    expect(db.unscoped("resolving a share token before the tenant is known")).toBeDefined();
  });

  it("refuses an empty or throwaway reason", () => {
    const { db } = scoped();
    expect(() => db.unscoped("")).toThrow(/requires a reason/);
    expect(() => db.unscoped("why")).toThrow(/requires a reason/);
  });
});

describe("table registry", () => {
  it("does not classify a table as both tenant-scoped and child", () => {
    const overlap = Object.keys(TENANT_CHILD_TABLES).filter((t) => TENANT_SCOPED_TABLES.has(t));
    expect(overlap).toEqual([]);
  });

  it("names a real parent for every child table", () => {
    // A child's parent must itself be scoped, or the chain never reaches a
    // tenant filter. `transition_approval_rules` → `lifecycle_transitions` is
    // two levels deep, so a parent may also be a child.
    for (const [child, parent] of Object.entries(TENANT_CHILD_TABLES)) {
      const parentIsScoped = TENANT_SCOPED_TABLES.has(parent) || parent in TENANT_CHILD_TABLES;
      expect(parentIsScoped, `${child} → ${parent}`).toBe(true);
    }
  });
});
