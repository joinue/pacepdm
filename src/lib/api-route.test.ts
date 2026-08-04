/**
 * The route wrapper decides the authorization outcome for every endpoint in
 * the app, so these tests cover the paths a handler no longer writes: the 401,
 * the 403, validation, error mapping, and the shape of a successful response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";

const { mockTenantUser } = vi.hoisted(() => ({
  mockTenantUser: { current: null as unknown },
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: vi.fn(() => Promise.resolve(mockTenantUser.current)),
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {},
  }),
}));

import { withTenant, withPublicRoute, withCron, badRequest, notFound, conflict } from "./api-route";

const admin = {
  id: "user-a",
  tenantId: "tenant-a",
  authUserId: "auth-a",
  email: "a@test.dev",
  fullName: "Alice",
  roleId: "role-a",
  role: { id: "role-a", name: "Admin", permissions: ["*"] },
};

const viewer = {
  ...admin,
  id: "user-v",
  role: { id: "role-v", name: "Viewer", permissions: ["file.view"] },
};

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function req(url = "http://test.local/api/x", init?: NextRequestInit) {
  return new NextRequest(url, init);
}

function jsonReq(body: unknown, url = "http://test.local/api/x") {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockTenantUser.current = admin;
  vi.clearAllMocks();
});

describe("withTenant — authentication", () => {
  it("returns 401 when there is no tenant user", async () => {
    mockTenantUser.current = null;
    const route = withTenant({}, async () => ({ ok: true }));
    const res = await route(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("does not invoke the handler when unauthenticated", async () => {
    mockTenantUser.current = null;
    const handler = vi.fn(async () => ({ ok: true }));
    await withTenant({}, handler)(req());
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the tenant user to the handler", async () => {
    const route = withTenant({}, async ({ tenantUser }) => ({ id: tenantUser.id }));
    expect(await (await route(req())).json()).toEqual({ id: "user-a" });
  });
});

describe("withTenant — permissions", () => {
  it("returns 403 when the caller lacks the permission", async () => {
    mockTenantUser.current = viewer;
    const route = withTenant({ permission: "file.delete" }, async () => ({ ok: true }));
    const res = await route(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("file.delete");
  });

  it("allows a caller holding the permission", async () => {
    mockTenantUser.current = viewer;
    const route = withTenant({ permission: "file.view" }, async () => ({ ok: true }));
    expect((await route(req())).status).toBe(200);
  });

  it("treats the wildcard role as holding everything", async () => {
    const route = withTenant({ permission: "admin.settings" }, async () => ({ ok: true }));
    expect((await route(req())).status).toBe(200);
  });

  it("requires every permission when given an array", async () => {
    mockTenantUser.current = viewer;
    const route = withTenant({ permission: ["file.view", "file.delete"] }, async () => ({
      ok: true,
    }));
    expect((await route(req())).status).toBe(403);
  });

  it("allows any authenticated user when no permission is declared", async () => {
    mockTenantUser.current = viewer;
    const route = withTenant({}, async () => ({ ok: true }));
    expect((await route(req())).status).toBe(200);
  });

  it("treats a non-array permissions field as no permissions", async () => {
    // A malformed role row must fail closed, not throw or grant.
    mockTenantUser.current = { ...admin, role: { id: "r", name: "Broken", permissions: null } };
    const route = withTenant({ permission: "file.view" }, async () => ({ ok: true }));
    expect((await route(req())).status).toBe(403);
  });
});

describe("withTenant — body validation", () => {
  const Schema = z.object({ name: z.string().min(1) });

  it("passes a valid body through, typed", async () => {
    const route = withTenant({ body: Schema }, async ({ body }) => ({ got: body.name }));
    const res = await route(jsonReq({ name: "Frame" }));
    expect(await res.json()).toEqual({ got: "Frame" });
  });

  it("returns 400 with a field-level error map on a schema mismatch", async () => {
    const route = withTenant({ body: Schema }, async () => ({ ok: true }));
    const res = await route(jsonReq({ name: "" }));
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Validation failed");
    expect(payload.details).toHaveProperty("name");
  });

  it("returns 400 on a body that is not JSON", async () => {
    const route = withTenant({ body: Schema }, async () => ({ ok: true }));
    const res = await route(
      new NextRequest("http://test.local/api/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("checks permissions before reading the body", async () => {
    // A caller who may not perform the action should get 403, not a validation
    // error that tells them what the endpoint expects.
    mockTenantUser.current = viewer;
    const route = withTenant({ permission: "file.delete", body: Schema }, async () => ({
      ok: true,
    }));
    expect((await route(jsonReq({ bad: true }))).status).toBe(403);
  });

  it("leaves body undefined when no schema is declared", async () => {
    const route = withTenant({}, async ({ body }) => ({ body: body ?? "absent" }));
    expect(await (await route(req())).json()).toEqual({ body: "absent" });
  });
});

describe("withTenant — query validation", () => {
  const Query = z.object({ limit: z.coerce.number().max(100) });

  it("parses and coerces query params", async () => {
    const route = withTenant({ query: Query }, async ({ query }) => ({ limit: query.limit }));
    const res = await route(req("http://test.local/api/x?limit=25"));
    expect(await res.json()).toEqual({ limit: 25 });
  });

  it("returns 400 on an invalid query param", async () => {
    const route = withTenant({ query: Query }, async () => ({ ok: true }));
    const res = await route(req("http://test.local/api/x?limit=9999"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid query parameters");
  });
});

describe("withTenant — dynamic params", () => {
  it("awaits and hands over the route params untyped when no schema is declared", async () => {
    const route = withTenant({}, async ({ params }) => ({ bomId: params.bomId }));
    const res = await route(req(), { params: Promise.resolve({ bomId: "bom-1" }) });
    expect(await res.json()).toEqual({ bomId: "bom-1" });
  });

  it("gives an empty object for a static route", async () => {
    const route = withTenant({}, async ({ params }) => ({ keys: Object.keys(params) }));
    expect(await (await route(req())).json()).toEqual({ keys: [] });
  });

  it("validates params against a declared schema", async () => {
    const route = withTenant({ params: z.object({ bomId: z.uuid() }) }, async ({ params }) => ({
      bomId: params.bomId,
    }));
    const good = "11111111-1111-4111-8111-111111111111";
    const res = await route(req(), { params: Promise.resolve({ bomId: good }) });
    expect(await res.json()).toEqual({ bomId: good });
  });

  it("rejects a malformed id at the boundary rather than at the database", async () => {
    // Without this, a non-uuid segment reaches Postgres and surfaces as a
    // 500 "invalid input syntax for type uuid" instead of a 400.
    const handler = vi.fn(async () => ({ ok: true }));
    const route = withTenant({ params: z.object({ bomId: z.uuid() }) }, handler);
    const res = await route(req(), { params: Promise.resolve({ bomId: "not-a-uuid" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid route parameters");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withTenant — the database handed to the handler", () => {
  it("is scoped to the caller's tenant", async () => {
    const route = withTenant({}, async ({ db }) => ({ tenantId: db.tenantId }));
    expect(await (await route(req())).json()).toEqual({ tenantId: "tenant-a" });
  });
});

describe("withTenant — error mapping", () => {
  it("maps a thrown ApiFailure to its status", async () => {
    const route = withTenant({}, async () => {
      throw notFound("BOM not found");
    });
    const res = await route(req());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "BOM not found" });
  });

  it("includes details when the failure carries them", async () => {
    const route = withTenant({}, async () => {
      throw conflict("Part number already used", { partNumber: "PN-1042" });
    });
    const res = await route(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Part number already used",
      details: { partNumber: "PN-1042" },
    });
  });

  it("maps an unexpected throw to 500 while preserving the message", async () => {
    // A generic "Something went wrong" makes a production 500 unresolvable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = withTenant({}, async () => {
      throw new Error('relation "widgets" does not exist');
    });
    const res = await route(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("relation");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("maps badRequest thrown from inside the handler", async () => {
    const route = withTenant({}, async () => {
      throw badRequest("Cannot release a BOM in DRAFT");
    });
    expect((await route(req())).status).toBe(400);
  });
});

describe("withTenant — response shaping", () => {
  it("sends a plain value as JSON", async () => {
    const route = withTenant({}, async () => ({ id: "1" }));
    const res = await route(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("sends 204 for a handler that returns nothing", async () => {
    const route = withTenant({}, async () => undefined);
    expect((await route(req())).status).toBe(204);
  });

  it("passes a Response through untouched", async () => {
    const route = withTenant({}, async () => new Response("raw", { status: 202 }));
    const res = await route(req());
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("raw");
  });

  it("sends an array as JSON rather than treating it as empty", async () => {
    const route = withTenant({}, async () => [{ id: "1" }, { id: "2" }]);
    expect(await (await route(req())).json()).toHaveLength(2);
  });
});

describe("withPublicRoute", () => {
  it("runs without a session", async () => {
    mockTenantUser.current = null;
    const route = withPublicRoute({}, async () => ({ ok: true }));
    expect((await route(req())).status).toBe(200);
  });

  it("still validates the body", async () => {
    mockTenantUser.current = null;
    const route = withPublicRoute({ body: z.object({ email: z.string().email() }) }, async () => ({
      ok: true,
    }));
    expect((await route(jsonReq({ email: "nope" }))).status).toBe(400);
  });

  it("still maps thrown failures", async () => {
    const route = withPublicRoute({}, async () => {
      throw notFound("Share link not found");
    });
    expect((await route(req())).status).toBe(404);
  });
});

describe("withCron", () => {
  const OLD = process.env.CRON_SECRET;
  afterEach(() => {
    process.env.CRON_SECRET = OLD;
  });

  it("accepts a request carrying the configured secret", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const route = withCron({}, async () => ({ swept: 3 }));
    const res = await route(
      req("http://test.local/api/cron/x", {
        headers: { authorization: "Bearer s3cret-value" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const route = withCron({}, async () => ({ swept: 3 }));
    const res = await route(
      req("http://test.local/api/cron/x", { headers: { authorization: "Bearer wrong" } })
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing authorization header", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const route = withCron({}, async () => ({ swept: 3 }));
    expect((await route(req("http://test.local/api/cron/x"))).status).toBe(401);
  });

  it("fails closed when CRON_SECRET is not configured", async () => {
    // Otherwise a misconfigured environment turns the endpoint into a public
    // notification spammer.
    delete process.env.CRON_SECRET;
    const handler = vi.fn(async () => ({ swept: 3 }));
    const res = await withCron(
      {},
      handler
    )(req("http://test.local/api/cron/x", { headers: { authorization: "Bearer anything" } }));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
