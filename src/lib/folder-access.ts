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
 * Fallback behavior:
 *   - If the RPC is missing (PGRST202) — pre-migration environment —
 *     we return a fully-open scope so a half-migrated dev/preview env
 *     stays usable. Once migration 012 lands the path is dead code.
 *   - For any other RPC error we fail closed: bypass-permission users
 *     still see everything, but regular users are denied access until
 *     the underlying problem is resolved. Better to lock the vault for
 *     30 seconds during a Supabase blip than to expose every restricted
 *     folder to every tenant member.
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
    if (isMissingFunctionError(err)) {
      console.warn(
        "[folder-access] get_folder_access_scope RPC missing — falling back to open scope. Run migration 012 to enable folder ACLs.",
        err
      );
      return openScope();
    }
    console.error(
      "[folder-access] get_folder_access_scope RPC failed — failing closed for non-bypass users.",
      err
    );
    return closedScope(bypass);
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

/**
 * Closed scope — nothing allowed unless the user holds bypass. Used as
 * the fail-closed default when the access-resolver RPC errors. With
 * `restrictedAny: true`, every predicate falls through to the empty
 * allowed/editable/admin sets and returns false for non-bypass users.
 */
export function closedScope(bypass: boolean): FolderAccessScope {
  return {
    bypass,
    restrictedAny: true,
    allowed: new Set(),
    editable: new Set(),
    admin: new Set(),
    denied: new Set(),
    restricted: new Set(),
  };
}

function isMissingFunctionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "PGRST202" || e.code === "42883") return true;
  return typeof e.message === "string" && /function .* does not exist/i.test(e.message);
}
