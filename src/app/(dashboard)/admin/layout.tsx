import { getCurrentTenantUser } from "@/lib/auth";
import { AccessDenied } from "./admin-gate";

/**
 * Coarse fence for the admin section: you need *some* admin permission to be
 * here at all. This keeps Engineer and Viewer out of the whole tree in one
 * check.
 *
 * It is deliberately not the real gate. Each segment declares the specific
 * permission its own pages and routes require via `<AdminGate>` in its
 * `layout.tsx` — a user holding one `admin.*` permission passes this check
 * and is still refused every segment but their own. See `admin-gate.tsx`.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const tenantUser = await getCurrentTenantUser();
  const permissions = tenantUser.role.permissions as string[];

  const isAdmin =
    permissions.includes("*") || permissions.some((p: string) => p.startsWith("admin."));

  if (!isAdmin) return <AccessDenied />;

  return <>{children}</>;
}
