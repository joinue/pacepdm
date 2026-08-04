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
 * Postgres error codes meaning "this function does not exist" — the
 * expected state when migration 012 hasn't been applied in an environment
 * yet. PGRST202 is PostgREST's schema-cache miss; 42883 is Postgres's own
 * undefined_function.
 */
const MISSING_RPC_CODES = new Set(["PGRST202", "42883"]);

/**
 * Call the get_folder_access_scope RPC and return a strongly-typed scope.
 *
 * Fallback behavior is deliberately narrow. If the RPC is *missing* (i.e.
 * migration 012 hasn't run here), we return a fully-open scope so the
 * vault stays usable during a deploy — folder ACLs don't exist yet in that
 * environment, so opening up doesn't bypass anything.
 *
 * Any other failure — a timeout, a dropped connection, pool exhaustion —
 * fails CLOSED by throwing. This used to catch everything and open up,
 * which meant a transient DB blip silently disabled folder access control
 * tenant-wide, handing every restricted folder to every user with nothing
 * but a console.warn to show for it. A 500 on the folder listing is a much
 * better outcome than quietly serving restricted CAD files.
 */
export async function getFolderAccessScope(
  tenantUser: TenantUserForAccess
): Promise<FolderAccessScope> {
  const permissions = extractPermissions(tenantUser.role);
  const bypass =
    hasPermission(permissions, PERMISSIONS.FOLDER_ACCESS_BYPASS) || permissions.includes("*");

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
    const code = (err as { code?: string } | null)?.code;
    if (code && MISSING_RPC_CODES.has(code)) {
      console.warn(
        "[folder-access] get_folder_access_scope RPC does not exist — falling back to open scope. Run migration 012 to enable folder ACLs.",
        err
      );
      return openScope();
    }
    // Anything else is a real failure. Fail closed rather than silently
    // dropping every folder ACL in the tenant.
    console.error(
      "[folder-access] get_folder_access_scope failed — refusing to resolve access.",
      err
    );
    throw err;
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
