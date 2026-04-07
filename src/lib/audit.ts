import { prisma } from "@/lib/prisma";

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
  await prisma.auditLog.create({
    data: {
      tenantId,
      userId,
      action,
      entityType,
      entityId,
      details: details ?? undefined,
      ipAddress,
    },
  });
}
