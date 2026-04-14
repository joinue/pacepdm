/**
 * Vercel Cron endpoint — sweeps for overdue approval decisions and
 * sends a reminder in-app notification (which fans out to email via
 * notify()).
 *
 * Schedule: every 30 min via vercel.json.
 * Auth: Vercel attaches `Authorization: Bearer ${CRON_SECRET}` when
 *       CRON_SECRET is set in project env. We reject anything else so
 *       the endpoint isn't a public notification spammer.
 * Dedup: `approval_reminders` (decisionId, kind='overdue') PK prevents
 *        a second reminder from ever being sent for the same decision.
 */

import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/db";
import { notify } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PendingDecision {
  id: string;
  requestId: string;
  groupId: string;
  deadlineAt: string;
  signatureLabel: string | null;
  request: {
    tenantId: string;
    title: string;
  } | null;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const db = getServiceClient();
  const now = new Date().toISOString();

  const { data: decisions, error } = await db
    .from("approval_decisions")
    .select(
      "id, requestId, groupId, deadlineAt, signatureLabel, request:approval_requests!approval_decisions_requestId_fkey(tenantId, title)"
    )
    .eq("status", "PENDING")
    .not("deadlineAt", "is", null)
    .lt("deadlineAt", now)
    .limit(500);

  if (error) {
    console.error("[cron/approval-reminders] query failed", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const pending = (decisions || []) as unknown as PendingDecision[];
  if (pending.length === 0) {
    return Response.json({ scanned: 0, reminded: 0 });
  }

  // Filter out decisions we've already reminded on.
  const ids = pending.map((d) => d.id);
  const { data: already } = await db
    .from("approval_reminders")
    .select("decisionId")
    .in("decisionId", ids)
    .eq("kind", "overdue");
  const alreadySet = new Set((already || []).map((r) => r.decisionId));

  let reminded = 0;
  const errors: string[] = [];

  for (const d of pending) {
    if (alreadySet.has(d.id)) continue;
    if (!d.request) continue;

    // Claim the reminder slot first so concurrent cron runs can't
    // double-send. Unique PK (decisionId, kind) means the second
    // insert fails harmlessly.
    const { error: claimErr } = await db
      .from("approval_reminders")
      .insert({ decisionId: d.id, kind: "overdue" });
    if (claimErr) {
      // 23505 = unique_violation — another worker already claimed it.
      if (!`${claimErr.code || ""}`.startsWith("235")) {
        errors.push(`claim ${d.id}: ${claimErr.message}`);
      }
      continue;
    }

    const { data: members } = await db
      .from("approval_group_members")
      .select("userId")
      .eq("groupId", d.groupId);
    const userIds = [...new Set((members || []).map((m) => m.userId))];
    if (userIds.length === 0) continue;

    const overdueBy = Math.max(
      0,
      Math.floor((Date.now() - new Date(d.deadlineAt).getTime()) / 3600000)
    );

    try {
      await notify({
        tenantId: d.request.tenantId,
        userIds,
        title: "Approval overdue",
        message: `"${d.request.title}" is past its deadline${overdueBy > 0 ? ` by ${overdueBy}h` : ""}. Please review.`,
        type: "approval",
        link: "/approvals",
        refId: d.requestId,
      });
      reminded += 1;
    } catch (err) {
      errors.push(`notify ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return Response.json({
    scanned: pending.length,
    reminded,
    errors: errors.length ? errors : undefined,
  });
}
