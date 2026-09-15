import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Allocating an ECO number.
 *
 * The number used to be the tenant's row count plus one. That is only unique
 * while the numbers run 1..count with no gaps, and nothing guarantees that: a
 * row hard-deleted before soft delete existed leaves a gap, and so does a
 * number skipped by a concurrent create. Once count + 1 names an existing row,
 * the insert hits ecos_tenantId_ecoNumber_key, and the 23505 handler — which
 * assumed every unique violation was the idempotency key — rethrew it as a
 * 500. On every create, until someone fixed the data by hand.
 *
 * The fake `ecos` table below enforces both unique indexes the way Postgres
 * reports them, so the route has to tell them apart from the real error shape.
 */

type Row = {
  id: string;
  tenantId: string;
  ecoNumber: string;
  clientRequestKey: string | null;
  deletedAt: string | null;
  title?: string;
};

const state = vi.hoisted(() => ({
  ecos: [] as Row[],
  /** Runs inside each insert, before the unique checks — a competing create. */
  beforeInsert: null as ((row: Row) => void) | null,
  insertAttempts: 0,
}));

vi.mock("@/lib/db", () => {
  function uniqueViolation(constraint: string, columns: string, values: string) {
    return {
      code: "23505",
      message: `duplicate key value violates unique constraint "${constraint}"`,
      details: `Key (${columns})=(${values}) already exists.`,
      hint: null,
    };
  }

  function ecosTable() {
    const filters: Record<string, unknown> = {};
    let range: [number, number] | null = null;
    let head = false;
    let pendingInsert: Row | null = null;

    const matching = () =>
      state.ecos.filter((r) =>
        Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v)
      );

    const insert = (row: Row) => {
      state.insertAttempts++;
      state.beforeInsert?.(row);
      // Postgres checks indexes in creation order: migration 001's ecoNumber
      // index predates migration 034's idempotency index.
      if (state.ecos.some((r) => r.tenantId === row.tenantId && r.ecoNumber === row.ecoNumber)) {
        return {
          data: null,
          error: uniqueViolation(
            "ecos_tenantId_ecoNumber_key",
            '"tenantId", "ecoNumber"',
            `${row.tenantId}, ${row.ecoNumber}`
          ),
        };
      }
      if (
        row.clientRequestKey &&
        state.ecos.some(
          (r) => r.tenantId === row.tenantId && r.clientRequestKey === row.clientRequestKey
        )
      ) {
        return {
          data: null,
          error: uniqueViolation(
            "ecos_tenant_idempotency_key",
            '"tenantId", "clientRequestKey"',
            `${row.tenantId}, ${row.clientRequestKey}`
          ),
        };
      }
      state.ecos.push(row);
      return { data: row, error: null };
    };

    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        head = opts?.head === true;
        return chain;
      },
      eq: (k: string, v: unknown) => {
        filters[k] = v;
        return chain;
      },
      // Honoured so a filter that hid soft-deleted rows would show up here.
      is: (k: string, v: unknown) => {
        filters[k] = v;
        return chain;
      },
      order: () => chain,
      range: (from: number, to: number) => {
        range = [from, to];
        return chain;
      },
      insert: (row: Row) => {
        pendingInsert = row;
        return chain;
      },
      single: () => Promise.resolve(pendingInsert ? insert(pendingInsert) : { data: null }),
      maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        const rows = matching();
        if (head) return resolve({ data: null, count: rows.length, error: null });
        return resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null });
      },
    };
    return chain;
  }

  function emptyTable() {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "order", "limit"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return chain;
  }

  return {
    getServiceClient: () => ({
      from: (table: string) => (table === "ecos" ? ecosTable() : emptyTable()),
    }),
  };
});

vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return {
    getApiTenantUser: () =>
      Promise.resolve({
        id: "user-1",
        tenantId: "tenant-1",
        fullName: "Alice",
        role: { permissions: ["eco.create"] },
      }),
    hasPermission: perms.hasPermission,
    PERMISSIONS: perms.PERMISSIONS,
  };
});
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/ecos", {
    method: "POST",
    body: JSON.stringify({ title: "Bracket change" }),
    headers: { "content-type": "application/json", ...headers },
  });
}

let nextId = 0;
function row(ecoNumber: string, extra: Partial<Row> = {}): Row {
  return {
    id: `eco-${++nextId}`,
    tenantId: "tenant-1",
    ecoNumber,
    clientRequestKey: null,
    deletedAt: null,
    ...extra,
  };
}

beforeEach(() => {
  state.ecos = [];
  state.beforeInsert = null;
  state.insertAttempts = 0;
});

describe("POST /api/ecos — ECO numbering", () => {
  it("numbers a tenant's first ECO ECO-0001", async () => {
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect((await res.json()).ecoNumber).toBe("ECO-0001");
  });

  it("numbers past the highest existing ECO when the numbers have a gap", async () => {
    // ECO-0002 is gone (hard-deleted before soft delete existed). Three rows,
    // so the old count + 1 was ECO-0004, which exists.
    state.ecos = [row("ECO-0001"), row("ECO-0003"), row("ECO-0004")];

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect((await res.json()).ecoNumber).toBe("ECO-0005");
  });

  it("never reuses the number of a soft-deleted ECO, even the highest one", async () => {
    state.ecos = [row("ECO-0001"), row("ECO-0002", { deletedAt: "2026-09-01T00:00:00.000Z" })];

    const res = await POST(req());

    expect((await res.json()).ecoNumber).toBe("ECO-0003");
    // First try, not rescued by the collision retry.
    expect(state.insertAttempts).toBe(1);
  });

  it("reads every page of numbers, not just the first thousand", async () => {
    state.ecos = Array.from({ length: 1200 }, (_, i) =>
      row(`ECO-${String(i + 1).padStart(4, "0")}`)
    );

    const res = await POST(req());

    expect((await res.json()).ecoNumber).toBe("ECO-1201");
    expect(state.insertAttempts).toBe(1);
  });

  it("keeps counting past ECO-9999 rather than sorting the numbers as text", async () => {
    state.ecos = [row("ECO-9999"), row("ECO-10000")];

    const res = await POST(req());

    expect((await res.json()).ecoNumber).toBe("ECO-10001");
  });

  it("moves to the next number when a concurrent create takes the same one", async () => {
    state.ecos = [row("ECO-0001")];
    // Another request read the same highest number and landed first.
    state.beforeInsert = (attempt) => {
      if (attempt.ecoNumber === "ECO-0002") {
        state.beforeInsert = null;
        state.ecos.push(row("ECO-0002"));
      }
    };

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect((await res.json()).ecoNumber).toBe("ECO-0003");
    expect(state.ecos.map((r) => r.ecoNumber)).toEqual(["ECO-0001", "ECO-0002", "ECO-0003"]);
  });

  it("gives up with a 409, not a 500, when every retry collides", async () => {
    state.ecos = [row("ECO-0001")];
    // A competitor claims whichever number this request is about to use.
    state.beforeInsert = (attempt) => {
      state.ecos.push(row(attempt.ecoNumber));
    };

    const res = await POST(req());

    expect(res.status).toBe(409);
    expect(state.insertAttempts).toBe(5);
  });

  it("still returns the winner when the idempotency key is what collided", async () => {
    // The same client retry landed between the pre-check and the insert.
    state.beforeInsert = (attempt) => {
      state.beforeInsert = null;
      state.ecos.push(
        row("ECO-0007", { id: "winner", clientRequestKey: attempt.clientRequestKey })
      );
    };

    const res = await POST(req({ "idempotency-key": "retry-1" }));

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("winner");
    expect(state.ecos).toHaveLength(1);
  });

  it("returns the winner when a same-key retry also took the same number", async () => {
    // Both unique indexes are violated; Postgres reports the ecoNumber one.
    // The route retries with the next number and then meets the key.
    state.ecos = [row("ECO-0001")];
    state.beforeInsert = (attempt) => {
      state.beforeInsert = null;
      state.ecos.push(
        row(attempt.ecoNumber, { id: "winner", clientRequestKey: attempt.clientRequestKey })
      );
    };

    const res = await POST(req({ "idempotency-key": "retry-2" }));

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("winner");
    expect(state.ecos).toHaveLength(2);
  });

  it("does not mistake an idempotency key that mentions ecoNumber for a number collision", async () => {
    const key = 'ecoNumber") ecos_tenantId_ecoNumber_key';
    state.beforeInsert = () => {
      state.beforeInsert = null;
      state.ecos.push(row("ECO-0042", { id: "winner", clientRequestKey: key }));
    };

    const res = await POST(req({ "idempotency-key": key }));

    expect((await res.json()).id).toBe("winner");
    expect(state.insertAttempts).toBe(1);
  });
});
