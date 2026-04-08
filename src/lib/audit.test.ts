import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@/lib/db", () => {
  const insertFn = vi.fn().mockResolvedValue({ data: null, error: null });
  const fromFn = vi.fn().mockReturnValue({ insert: insertFn });
  return {
    getServiceClient: vi.fn().mockReturnValue({ from: fromFn }),
    __mockFrom: fromFn,
    __mockInsert: insertFn,
  };
});

vi.mock("uuid", () => ({ v4: () => "test-uuid-1234" }));

import { logAudit } from "./audit";
import * as dbModule from "@/lib/db";

const mockFrom = (dbModule as unknown as { __mockFrom: ReturnType<typeof vi.fn> }).__mockFrom;
const mockInsert = (dbModule as unknown as { __mockInsert: ReturnType<typeof vi.fn> }).__mockInsert;

describe("logAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an audit log entry with all fields", async () => {
    await logAudit({
      tenantId: "tenant-1",
      userId: "user-1",
      action: "file.upload",
      entityType: "file",
      entityId: "file-1",
      details: { filename: "bracket.sldprt" },
      ipAddress: "192.168.1.1",
    });

    expect(mockFrom).toHaveBeenCalledWith("audit_logs");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-uuid-1234",
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.upload",
        entityType: "file",
        entityId: "file-1",
        details: { filename: "bracket.sldprt" },
        ipAddress: "192.168.1.1",
      })
    );
  });

  it("defaults userId to null when not provided", async () => {
    await logAudit({
      tenantId: "tenant-1",
      action: "system.startup",
      entityType: "system",
      entityId: "sys-1",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        details: null,
        ipAddress: null,
      })
    );
  });

  it("defaults details and ipAddress to null", async () => {
    await logAudit({
      tenantId: "t",
      userId: "u",
      action: "test",
      entityType: "test",
      entityId: "e",
    });

    const inserted = mockInsert.mock.calls[0][0];
    expect(inserted.details).toBeNull();
    expect(inserted.ipAddress).toBeNull();
  });

  it("includes a createdAt ISO timestamp", async () => {
    await logAudit({
      tenantId: "t",
      action: "test",
      entityType: "test",
      entityId: "e",
    });

    const inserted = mockInsert.mock.calls[0][0];
    // Should be a valid ISO date string
    expect(() => new Date(inserted.createdAt)).not.toThrow();
    expect(new Date(inserted.createdAt).toISOString()).toBe(inserted.createdAt);
  });
});
