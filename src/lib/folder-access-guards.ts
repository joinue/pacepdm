import { NextResponse } from "next/server";
import {
  canEditFolder,
  canViewFolder,
  getFolderAccessScope,
  type FolderAccessScope,
  type TenantUserForAccess,
} from "./folder-access";
import { forbidden, notFound } from "./api-route";
import type { ScopedDb } from "./tenant-db";

/**
 * Route-layer guards for folder ACLs. The pure predicates live in
 * `folder-access.ts` (unit-testable, no Next.js imports); this module
 * wraps them with the 404/403 response shape every file/folder route
 * uses, so each route is two lines instead of ten.
 *
 * Denial semantics are deliberate:
 *   - `view` denied → 404 "not found". Existence is hidden — a user who
 *     can't see the folder shouldn't learn it exists by probing ids.
 *   - `edit` denied but view OK → 403. The user already knows the thing
 *     exists (they can see it in listings), so a clear 403 is more
 *     useful than a misleading 404.
 *
 * Both guards return a discriminated union. Callers `if (!result.ok)
 * return result.response;` on denial, or use `result.scope` when the
 * route needs to make additional checks (e.g. file move validates both
 * source and destination folder from the same scope).
 */

type GuardResult = { ok: true; scope: FolderAccessScope } | { ok: false; response: NextResponse };

export async function requireFolderAccess(
  tenantUser: TenantUserForAccess,
  folderId: string,
  level: "view" | "edit"
): Promise<GuardResult> {
  const scope = await getFolderAccessScope(tenantUser);
  return gate(scope, folderId, level, "Folder not found");
}

/**
 * Gate by the containing folder of a file row. Callers pass the file
 * they've already loaded (tenant-checked) so we don't re-fetch it.
 */
export async function requireFileAccess(
  tenantUser: TenantUserForAccess,
  file: { folderId: string },
  level: "view" | "edit"
): Promise<GuardResult> {
  const scope = await getFolderAccessScope(tenantUser);
  return gate(scope, file.folderId, level, "File not found");
}

/**
 * Load a file by id, tenant-scoped, and gate it by folder ACL in one call.
 *
 * Nineteen file routes opened with the same ten lines: fetch by id, compare
 * `tenantId` in JavaScript, check `deletedAt`, then `requireFileAccess`. That
 * shape is why the tenant comparison was easy to forget, and why three routes
 * had drifted into checking it differently.
 *
 * Two gates apply and both are necessary: role permission (declared on the
 * route via `withTenant`) says what a user may do at all, and the folder ACL
 * says where they may do it. This helper covers the second.
 *
 * Throws instead of returning a response, so a handler reads:
 *
 *   const file = await loadFile(db, tenantUser, params.fileId, "edit");
 *
 * Pass `select` when the route needs joined columns.
 */
export async function loadFile(
  db: ScopedDb,
  tenantUser: TenantUserForAccess,
  fileId: string,
  level: "view" | "edit",
  select = "*"
) {
  const { data: file } = await db
    .from("files")
    .select(select)
    .eq("id", fileId)
    .is("deletedAt", null)
    .maybeSingle();

  if (!file) throw notFound("File not found");

  const scope = await getFolderAccessScope(tenantUser);
  if (!canViewFolder(scope, file.folderId)) throw notFound("File not found");
  if (level === "edit" && !canEditFolder(scope, file.folderId)) throw forbidden();

  return file;
}

/**
 * The mirror of `loadFile` for the trash: loads a file that IS soft-deleted.
 *
 * Deliberately a separate function rather than a flag on `loadFile`. Every
 * one of `loadFile`'s callers wants deleted rows excluded, and that exclusion
 * is the kind of default that should not be reachable by passing the wrong
 * boolean — a `loadFile(..., { includeDeleted: true })` typo'd into an
 * unrelated route is a silent correctness bug, whereas calling a function
 * named `loadDeletedFile` is never accidental.
 *
 * Requires edit on the containing folder: restoring a file puts content back
 * into a folder, so it is a write to that folder regardless of the fact that
 * only the file row changes.
 */
export async function loadDeletedFile(
  db: ScopedDb,
  tenantUser: TenantUserForAccess,
  fileId: string,
  select = "*"
) {
  const { data: file } = await db
    .from("files")
    .select(select)
    .eq("id", fileId)
    .not("deletedAt", "is", null)
    .maybeSingle();

  // Same message whether the id is unknown, belongs to another tenant, or
  // points at a file that is not actually deleted. A caller probing ids
  // learns nothing from the difference.
  if (!file) throw notFound("Deleted file not found");

  const scope = await getFolderAccessScope(tenantUser);
  if (!canViewFolder(scope, file.folderId)) throw notFound("Deleted file not found");
  if (!canEditFolder(scope, file.folderId)) throw forbidden();

  return file;
}

function gate(
  scope: FolderAccessScope,
  folderId: string,
  level: "view" | "edit",
  notFoundMessage: string
): GuardResult {
  if (!canViewFolder(scope, folderId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: notFoundMessage }, { status: 404 }),
    };
  }
  if (level === "edit" && !canEditFolder(scope, folderId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, scope };
}
