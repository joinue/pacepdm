import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock setup ──────────────────────────────────────────────────────────

const { tableResults, insertCalls, updateCalls, mockFrom, mockStorage } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };

  const tableResults: Record<string, QueryResult> = {};
  const insertCalls: Array<{ table: string; data: unknown }> = [];
  const updateCalls: Array<{ table: string; data: unknown; filters: Record<string, unknown> }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = () => tableResults[table] || { data: null, error: null };

    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "match"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();

    chain.insert = (data: unknown) => {
      insertCalls.push({ table, data });
      return { select: () => ({ single: () => ({ data: null, error: null }) }), data: null, error: null };
    };

    chain.update = (data: unknown) => {
      const entry = { table, data, filters: { ...filters } };
      updateCalls.push(entry);
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) {
        updateChain[m] = () => updateChain;
      }
      updateChain.single = () => ({ data: null, error: null });
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (...args: unknown[]) => unknown;

    return chain;
  }

  const mockFrom = (table: string) => makeChain(table);

  const mockStorage = {
    from: () => ({
      upload: vi.fn().mockResolvedValue({ error: null }),
    }),
  };

  return { tableResults, insertCalls, updateCalls, mockFrom, mockStorage };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom, storage: mockStorage }),
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: { FILE_CHECKIN: "file.checkin" },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("@/lib/mentions", () => ({
  processMentions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/thumbnail", () => ({
  extractThumbnail: vi.fn().mockResolvedValue(null),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: vi.fn().mockResolvedValue({ ok: true }),
}));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

// ── Helpers ─────────────────────────────────────────────────────────────

function resetMockState() {
  vi.clearAllMocks();
  insertCalls.length = 0;
  updateCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
}

function makeCheckinRequest(file?: File, comment?: string): NextRequest {
  const formData = new FormData();
  if (file) formData.append("file", file);
  if (comment) formData.append("comment", comment);
  return new NextRequest("http://localhost/api/files/file-1/checkin", {
    method: "POST",
    body: formData,
  });
}

const params = Promise.resolve({ fileId: "file-1" });

const owner = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.checkin"] },
};

const otherUser = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["file.checkin"] },
};

const admin = {
  id: "admin-1",
  tenantId: "tenant-1",
  fullName: "Admin",
  role: { permissions: ["*"] },
};

const checkedOutFile = {
  id: "file-1",
  tenantId: "tenant-1",
  name: "bracket.sldprt",
  isFrozen: false,
  isCheckedOut: true,
  checkedOutById: "user-1",
  currentVersion: 2,
  revision: "A",
  folderId: "folder-1",
  thumbnailKey: null,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("POST /api/files/[fileId]/checkin", () => {
  beforeEach(resetMockState);

  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 without FILE_CHECKIN permission", async () => {
    mockTenantUser.current = { ...owner, role: { permissions: ["file.view"] } };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(403);
  });

  it("returns 409 if file is not checked out", async () => {
    mockTenantUser.current = owner;
    tableResults["files"] = {
      data: { ...checkedOutFile, isCheckedOut: false },
      error: null,
    };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not checked out/i);
  });

  it("returns 403 if checked out by another user (non-admin)", async () => {
    mockTenantUser.current = otherUser;
    tableResults["files"] = { data: { ...checkedOutFile }, error: null };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/another user/i);
  });

  it("allows admin to check in another user's file", async () => {
    mockTenantUser.current = { ...admin, role: { permissions: ["*", "admin.settings"] } };
    tableResults["files"] = { data: { ...checkedOutFile }, error: null };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(200);
  });

  it("undo checkout (no file) resets checkout fields and logs audit", async () => {
    mockTenantUser.current = owner;
    tableResults["files"] = { data: { ...checkedOutFile }, error: null };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(200);

    // Should update files table to clear checkout
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].data).toMatchObject({
      isCheckedOut: false,
      checkedOutById: null,
      checkedOutAt: null,
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.undo_checkout",
        entityId: "file-1",
      })
    );
  });

  it("returns 409 if file became frozen during checkout", async () => {
    mockTenantUser.current = owner;
    tableResults["files"] = {
      data: { ...checkedOutFile, isFrozen: true },
      error: null,
    };
    const res = await POST(makeCheckinRequest(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/frozen/i);
  });

  // File size validation (> 5 GB) is not testable in unit tests because
  // the File constructor's size property is derived from the Blob content
  // and cannot be overridden. The guard is tested implicitly via the
  // upload route's integration test.
});
