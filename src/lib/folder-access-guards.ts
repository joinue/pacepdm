import { NextResponse } from "next/server";
import {
  canEditFolder,
  canViewFolder,
  getFolderAccessScope,
  type FolderAccessScope,
  type TenantUserForAccess,
} from "./folder-access";

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

type GuardResult =
  | { ok: true; scope: FolderAccessScope }
  | { ok: false; response: NextResponse };

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
