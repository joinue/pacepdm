import { getServiceClient } from "@/lib/db";
import { v4 as uuid } from "uuid";

export async function logAudit({
  tenantId,
  userId,
  action,
  entityType,
  entityId,
  details,
  ipAddress,
}: {
  tenantId: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, string | number | boolean | null>;
  ipAddress?: string;
}) {
  const db = getServiceClient();
  const { error } = await db.from("audit_logs").insert({
    id: uuid(),
    tenantId,
    userId: userId ?? null,
    action,
    entityType,
    entityId,
    details: details ?? null,
    ipAddress: ipAddress ?? null,
    createdAt: new Date().toISOString(),
  });

  // Logged, deliberately not thrown. By the time this runs the mutation it
  // records has already happened, so throwing would fail a request that
  // succeeded and tell the caller to retry something they must not repeat.
  //
  // But silence is the wrong other extreme: the audit log is what the
  // compliance story rests on, and a trail that quietly stops recording looks
  // exactly like a period when nothing happened. This is the same shape as
  // finding 1 in docs/plans/functional-audit.md — a soft path needs something
  // that notices when it stops being rare.
  if (error) {
    console.error(
      `[audit] failed to record ${action} on ${entityType} ${entityId} for tenant ${tenantId}:`,
      error.message
    );
  }
}
