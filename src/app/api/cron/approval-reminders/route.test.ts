import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The overdue-approval sweep. It deduped per decision *row*, and an ALL or
 * MAJORITY step holds one row per seat — so a three-seat step sent its group
 * three identical reminders, and three emails each, in one run. It also
 * chased seats left PENDING on requests sent back for rework, which the
 * approvals page no longer shows.
 */

const state = vi.hoisted(() => ({
  decisions: [] as Array<Record<string, unknown>>,
  reminders: [] as Array<{ decisionId: string; kind: string }>,
  /** Insert failures to hand back, keyed by decisionId of the first row inserted. */
  failInsert: {} as Record<string, { code?: string; message: string }>,
  members: { "group-a": ["ann", "bob", "cat"], "group-b": ["dan"] } as Record<string, string[]>,
  decisionQuery: { filters: [] as Array<[string, ...unknown[]]> },
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({
    from(table: string) {
      if (table === "approval_decisions") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "lt", "order", "limit"]) {
          q[m] = (...args: unknown[]) => {
            state.decisionQuery.filters.push([m, ...args]);
            return q;
          };
        }
        q.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: state.decisions, error: null }).then(resolve);
        return q;
      }
      if (table === "approval_reminders") {
        return {
          select: () => ({
            in: (_c: string, ids: string[]) => ({
              eq: async () => ({
                data: state.reminders.filter((r) => ids.includes(r.decisionId)),
                error: null,
              }),
            }),
          }),
          insert: async (
            rows: { decisionId: string; kind: string } | Array<{ decisionId: string; kind: string }>
          ) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const fail = state.failInsert[list[0].decisionId];
            if (fail) return { data: null, error: fail };
            for (const row of list) {
              if (state.reminders.some((r) => r.decisionId === row.decisionId)) {
                return { data: null, error: { code: "23505", message: "duplicate" } };
              }
              state.reminders.push(row);
            }
            return { data: null, error: null };
          },
        };
      }
      if (table === "approval_group_members") {
        return {
          select: () => ({
            eq: async (_c: string, groupId: string) => ({
              data: (state.members[groupId] ?? []).map((userId) => ({ userId })),
              error: null,
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/notifications", () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

import { GET } from "./route";
import { notify } from "@/lib/notifications";

const request = (secret = "s3cret") =>
  GET(
    new NextRequest("http://localhost/api/cron/approval-reminders", {
      headers: { authorization: `Bearer ${secret}` },
    })
  );

const PAST = "2026-09-20T00:00:00.000Z";

function seat(id: string, requestId: string, stepId: string, groupId: string, extra = {}) {
  return {
    id,
    requestId,
    stepId,
    groupId,
    deadlineAt: PAST,
    signatureLabel: "Approved",
    request: { tenantId: "tenant-1", title: `Request ${requestId}`, status: "PENDING" },
    ...extra,
  };
}

const OLD_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  state.decisions = [];
  state.reminders = [];
  state.failInsert = {};
  state.decisionQuery.filters = [];
});

afterEach(() => {
  process.env.CRON_SECRET = OLD_SECRET;
});

describe("GET /api/cron/approval-reminders", () => {
  it("refuses without the cron secret", async () => {
    expect((await request("wrong")).status).toBe(401);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reminds a three-seat step's group once, not three times", async () => {
    state.decisions = [
      seat("d-3", "req-1", "step-1", "group-a"),
      seat("d-1", "req-1", "step-1", "group-a"),
      seat("d-2", "req-1", "step-1", "group-a"),
    ];

    const res = await request();

    expect(await res.json()).toMatchObject({ scanned: 3, reminded: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userIds: ["ann", "bob", "cat"],
        type: "approval",
        refId: "req-1",
        title: "Approval overdue",
      })
    );
    // Every seat is claimed, so the step is skipped by the next run too.
    expect(state.reminders.map((r) => r.decisionId).sort()).toEqual(["d-1", "d-2", "d-3"]);
  });

  it("reminds each overdue step separately", async () => {
    state.decisions = [
      seat("d-1", "req-1", "step-1", "group-a"),
      seat("d-2", "req-2", "step-1", "group-b"),
    ];

    await request();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ refId: "req-1" }));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ refId: "req-2", userIds: ["dan"] })
    );
  });

  it("skips a step any of whose seats was already reminded on", async () => {
    // A row claimed on its own, from before reminders were grouped per step.
    state.reminders = [{ decisionId: "d-2", kind: "overdue" }];
    state.decisions = [
      seat("d-1", "req-1", "step-1", "group-a"),
      seat("d-2", "req-1", "step-1", "group-a"),
    ];

    const res = await request();

    expect(await res.json()).toMatchObject({ scanned: 2, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends nothing when another run claimed the step first", async () => {
    state.decisions = [seat("d-1", "req-1", "step-1", "group-a")];
    state.failInsert["d-1"] = { code: "23505", message: "duplicate" };

    const body = await (await request()).json();

    expect(body).toMatchObject({ reminded: 0 });
    expect(body.errors).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a claim that failed for any other reason, and keeps going", async () => {
    state.decisions = [
      seat("d-1", "req-1", "step-1", "group-a"),
      seat("d-2", "req-2", "step-1", "group-b"),
    ];
    state.failInsert["d-1"] = { message: "disk full" };

    const body = await (await request()).json();

    expect(body.reminded).toBe(1);
    expect(body.errors).toEqual(["claim d-1: disk full"]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ refId: "req-2" }));
  });

  it("asks only for seats on requests that are still pending", async () => {
    await request();

    expect(state.decisionQuery.filters).toContainEqual(["eq", "status", "PENDING"]);
    expect(state.decisionQuery.filters).toContainEqual(["eq", "request.status", "PENDING"]);
    expect(state.decisionQuery.filters.find(([m]) => m === "select")?.[1] as string).toContain(
      "!inner("
    );
  });

  it("groups rows without a stepId by request and group", async () => {
    state.decisions = [
      seat("d-1", "req-1", null as unknown as string, "group-a"),
      seat("d-2", "req-1", null as unknown as string, "group-a"),
    ];

    await request();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
