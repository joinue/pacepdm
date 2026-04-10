"use client";

import { useTenantUser } from "@/components/providers/tenant-provider";
import { hasPermission } from "@/lib/permissions";

/**
 * Client-side permission helper.
 *
 * Use to conditionally render action buttons based on the current user's
 * permissions. Server-side enforcement still happens in API routes — this
 * is purely for hiding controls the user can't actually use.
 *
 * Example:
 *   const { can } = usePermissions();
 *   {can("file.delete") && <DeleteButton />}
 */
export function usePermissions() {
  const user = useTenantUser();
  const permissions = user.permissions || [];

  return {
    permissions,
    can: (permission: string) => hasPermission(permissions, permission),
    canAny: (perms: string[]) => perms.some((p) => hasPermission(permissions, p)),
    canAll: (perms: string[]) => perms.every((p) => hasPermission(permissions, p)),
  };
}
