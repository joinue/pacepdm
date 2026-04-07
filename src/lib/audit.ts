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
  await db.from("audit_logs").insert({
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
}
