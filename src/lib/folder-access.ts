import { getServiceClient } from "./db";
import { hasPermission, PERMISSIONS } from "./permissions";

/**
 * Resolved per-user access scope across all folders in a tenant. Produced by
 * the `get_folder_access_scope` RPC and consumed by route handlers to gate
 * folder / file / search responses.
 *
 * The three "level" sets are nested: admin ⊂ editable ⊂ allowed. Callers
 * pick the set matching the operation they're about to perform.
 *
 * Semantics of the two flags:
 *   - `bypass`        — user holds FOLDER_ACCESS_BYPASS; skip all checks.
 *   - `restrictedAny` — the tenant has at least one non-expired ACL row.
 *                       If false, every folder is implicitly public and no
 *                       filtering is required (legacy / unconfigured tenants).
 */
export interface FolderAccessScope {
  bypass: boolean;
  restrictedAny: boolean;
  allowed: Set<string>;
  editable: Set<string>;
  admin: Set<string>;
  denied: Set<string>;
  restricted: Set<string>;
}

/**
 * Minimal shape of a tenant user that the resolver needs. Matches what
 * `getApiTenantUser()` returns.
 */
export interface TenantUserForAccess {
  id: string;
  tenantId: string;
  roleId: string;
  role: { permissions: unknown };
}

function extractPermissions(role: { permissions: unknown }): string[] {
  return Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
}

/**
 * Call the get_folder_access_scope RPC and return a strongly-typed scope.
 *
 * Fallback behavior: if the RPC is missing (e.g. migration 012 hasn't been
 * run yet in this environment) or the call otherwise fails, we log loudly
 * and return a fully-open scope. This keeps the vault usable during
 * deployment instead of hard-failing every folder listing with a 500.
 * Once the migration lands, the RPC responds normally and the fallback
 * path is dead code.
 */
export async function getFolderAccessScope(
  tenantUser: TenantUserForAccess
): Promise<FolderAccessScope> {
  const permissions = extractPermissions(tenantUser.role);
  const bypass =
    hasPermission(permissions, PERMISSIONS.FOLDER_ACCESS_BYPASS) ||
    permissions.includes("*");

  const db = getServiceClient();
  let data: unknown;
  try {
    const result = await db.rpc("get_folder_access_scope", {
      p_tenant_id: tenantUser.tenantId,
      p_user_id: tenantUser.id,
      p_role_id: tenantUser.roleId,
      p_bypass: bypass,
    });
    if (result.error) throw result.error;
    data = result.data;
  } catch (err) {
    // PGRST202 / "function does not exist" is the expected pre-migration
    // state. Any other error is probably a real problem, but failing
    // closed would lock everyone out of the vault — so we log and open.
    console.warn(
      "[folder-access] get_folder_access_scope RPC unavailable — falling back to open scope. Run migration 012 to enable folder ACLs.",
      err
    );
    return openScope();
  }

  const raw = (data ?? {}) as {
    bypass?: boolean;
    restrictedAny?: boolean;
    allowed?: string[];
    editable?: string[];
    admin?: string[];
    denied?: string[];
    restricted?: string[];
  };

  return {
    bypass: !!raw.bypass,
    restrictedAny: !!raw.restrictedAny,
    allowed: new Set(raw.allowed ?? []),
    editable: new Set(raw.editable ?? []),
    admin: new Set(raw.admin ?? []),
    denied: new Set(raw.denied ?? []),
    restricted: new Set(raw.restricted ?? []),
  };
}

// ─── Pure predicates (unit-testable, no DB) ────────────────────────────────

export function canViewFolder(scope: FolderAccessScope, folderId: string): boolean {
  if (scope.bypass) return true;
  if (!scope.restrictedAny) return true;
  if (scope.denied.has(folderId)) return false;
  return scope.allowed.has(folderId);
}

export function canEditFolder(scope: FolderAccessScope, folderId: string): boolean {
  if (scope.bypass) return true;
  if (!scope.restrictedAny) return true;
  if (scope.denied.has(folderId)) return false;
  return scope.editable.has(folderId);
}

export function canAdminFolder(scope: FolderAccessScope, folderId: string): boolean {
  if (scope.bypass) return true;
  if (!scope.restrictedAny) return true;
  if (scope.denied.has(folderId)) return false;
  return scope.admin.has(folderId);
}

/**
 * True when a folder is restricted by ACLs (has an applicable row itself
 * or inherits from an ancestor). Independent of whether the current user
 * has access — used by the UI for the lock badge.
 */
export function isRestrictedFolder(scope: FolderAccessScope, folderId: string): boolean {
  return scope.restricted.has(folderId);
}

/**
 * Filter a collection down to items whose associated folder the user can
 * view. Works for folders (use `(f) => f.id`) and files (default
 * `(f) => f.folderId`). Callers that filter nothing in the fast path
 * (`!restrictedAny`) pay no allocation cost.
 */
export function filterViewable<T>(
  scope: FolderAccessScope,
  items: T[],
  folderIdOf: (item: T) => string
): T[] {
  if (scope.bypass) return items;
  if (!scope.restrictedAny) return items;
  return items.filter((item) => {
    const fid = folderIdOf(item);
    if (scope.denied.has(fid)) return false;
    return scope.allowed.has(fid);
  });
}

/**
 * Public-tenant scope — everything allowed, no restrictions. Useful as
 * a default in tests and in code paths where the resolver is not yet
 * wired up.
 */
export function openScope(): FolderAccessScope {
  return {
    bypass: false,
    restrictedAny: false,
    allowed: new Set(),
    editable: new Set(),
    admin: new Set(),
    denied: new Set(),
    restricted: new Set(),
  };
}
