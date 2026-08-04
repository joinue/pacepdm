/**
 * Tenant-scoped Supabase client.
 *
 * Wraps the service-role client so that every query against a tenant-scoped
 * table carries the caller's tenant filter automatically:
 *
 *   db.from("boms").select("*")            → ... where "tenantId" = <caller>
 *   db.from("boms").update({ name })       → ... where "tenantId" = <caller>
 *   db.from("boms").delete()               → ... where "tenantId" = <caller>
 *   db.from("boms").insert({ name })       → inserts with tenantId = <caller>
 *
 * Why this exists: `getServiceClient()` authenticates with the service-role
 * key, which bypasses RLS entirely. A query that forgets `.eq("tenantId", …)`
 * therefore reads every customer's rows, and nothing in the type system, the
 * database, or the linter can see the omission. That class of bug has shipped
 * here before (commit fb6c1cc). Making the scoped client the only thing a
 * route handler can reach removes the decision instead of policing it.
 *
 * See docs/decisions/tenant-isolation.md.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/db";

/**
 * Tables carrying a `tenantId` column. Every one of these is filtered and
 * stamped automatically.
 *
 * Derived from the `create table` statements in supabase/migrations/. When you
 * add a table with a `tenantId` column, add it here in the same PR — a table
 * missing from this set is silently unscoped, which is the exact failure this
 * module exists to prevent.
 */
export const TENANT_SCOPED_TABLES = new Set([
  "approval_groups",
  "approval_requests",
  "approval_workflow_assignments",
  "approval_workflows",
  "audit_logs",
  "bom_snapshots",
  "boms",
  "ecos",
  "files",
  "folder_access",
  "folders",
  "lifecycles",
  "metadata_fields",
  "notifications",
  "parts",
  "releases",
  "roles",
  "saved_searches",
  "share_token_access",
  "share_tokens",
  "tenant_sso_domains",
  "tenant_users",
  "vendors",
]);

/**
 * Tables whose tenant is implied by a parent row rather than a column of
 * their own. There is nothing to filter on, so the scoped client passes these
 * through untouched.
 *
 * The rule for these: **load the parent through the scoped client first**, then
 * query the child by the parent's id. Querying a child directly by an id that
 * arrived from the request is a cross-tenant read.
 *
 *   const bom = await db.from("boms").select("id").eq("id", bomId).maybeSingle();
 *   if (!bom.data) throw notFound("BOM not found");        // scoped → safe
 *   await db.from("bom_items").select("*").eq("bomId", bom.data.id);
 */
export const TENANT_CHILD_TABLES: Record<string, string> = {
  approval_decisions: "approval_requests",
  approval_group_members: "approval_groups",
  approval_history: "approval_requests",
  approval_reminders: "approval_decisions",
  approval_workflow_steps: "approval_workflows",
  approvals: "approval_requests",
  bom_items: "boms",
  eco_items: "ecos",
  file_references: "files",
  file_versions: "files",
  folder_permissions: "folders",
  lifecycle_states: "lifecycles",
  lifecycle_transitions: "lifecycles",
  metadata_values: "metadata_fields",
  part_files: "parts",
  part_vendors: "parts",
  transition_approval_rules: "lifecycle_transitions",
};

/**
 * The column identifying the tenant, per table. Everything in
 * TENANT_SCOPED_TABLES uses "tenantId"; `tenants` itself is identified by its
 * own primary key, so scoping it means `id = <caller's tenant>`.
 */
function tenantColumn(table: string): string | null {
  if (table === "tenants") return "id";
  return TENANT_SCOPED_TABLES.has(table) ? "tenantId" : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- The Supabase client is
   constructed without generated database types, so its query builders are
   loosely typed by construction. Preserving the fluent chain means passing
   those builders through, which cannot be done more precisely than `any`
   without generating types for all 41 tables. The public surface below is
   typed; only the pass-through internals are not. */

type AnyBuilder = any;

/** A row being inserted or upserted. */
type Row = Record<string, unknown>;

function stampTenant(values: Row | Row[], column: string, tenantId: string) {
  const stamp = (row: Row) => {
    const existing = row[column];
    if (existing !== undefined && existing !== tenantId) {
      // A write that names a different tenant is always a bug, and if it were
      // ever reachable from user input it would be a cross-tenant write. Fail
      // loudly rather than silently overwriting.
      throw new Error(
        `Refusing to write ${column}=${String(existing)} while scoped to tenant ${tenantId}`
      );
    }
    return { ...row, [column]: tenantId };
  };
  return Array.isArray(values) ? values.map(stamp) : stamp(values);
}

/**
 * The subset of the Supabase query-builder surface the scoped client
 * intercepts. Everything downstream of these (`.eq`, `.order`, `.single`, …)
 * is the native builder.
 */
export interface ScopedQueryBuilder {
  select(columns?: string, options?: Record<string, unknown>): AnyBuilder;
  insert(values: Row | Row[], options?: Record<string, unknown>): AnyBuilder;
  upsert(values: Row | Row[], options?: Record<string, unknown>): AnyBuilder;
  update(values: Row, options?: Record<string, unknown>): AnyBuilder;
  delete(options?: Record<string, unknown>): AnyBuilder;
}

export interface ScopedDb {
  /** The caller's tenant. */
  readonly tenantId: string;

  /**
   * Query a table with the tenant filter applied automatically. Tables in
   * TENANT_CHILD_TABLES pass through unfiltered — scope them through their
   * parent.
   */
  from(table: string): ScopedQueryBuilder;

  /** Postgres RPC. Pass the tenant explicitly in `args` when the function needs it. */
  rpc(fn: string, args?: Record<string, unknown>): AnyBuilder;

  /** Supabase Storage. Not tenant-aware — key your paths by tenant. */
  readonly storage: SupabaseClient["storage"];

  /**
   * Escape hatch: the raw service-role client, with no tenant filter at all.
   *
   * Every call must pass a reason, so that `grep -rn "unscoped(" src/`
   * enumerates every deliberate cross-tenant access in the codebase. Legitimate
   * uses are narrow: resolving a share token before a tenant is known, the SSO
   * domain lookup, cron sweeps, and platform-admin tooling.
   */
  unscoped(reason: string): SupabaseClient;
}

/**
 * Build a tenant-scoped client. Called by the route wrapper; route handlers
 * receive the result as `db` and should not call this directly.
 */
export function createScopedDb(tenantId: string, client?: SupabaseClient): ScopedDb {
  const raw = client ?? getServiceClient();

  return {
    tenantId,

    from(table: string): ScopedQueryBuilder {
      const builder: AnyBuilder = raw.from(table);
      const column = tenantColumn(table);

      // No tenant column: a child table scoped through its parent, or genuinely
      // global lookup data. Nothing to filter on, so hand back the native
      // builder rather than pretending it is protected.
      if (!column) return builder as ScopedQueryBuilder;

      return {
        select: (columns?: string, options?: Record<string, unknown>) =>
          builder.select(columns, options).eq(column, tenantId),

        insert: (values: Row | Row[], options?: Record<string, unknown>) =>
          builder.insert(stampTenant(values, column, tenantId), options),

        upsert: (values: Row | Row[], options?: Record<string, unknown>) =>
          builder.upsert(stampTenant(values, column, tenantId), options),

        update: (values: Row, options?: Record<string, unknown>) => {
          if (values[column] !== undefined && values[column] !== tenantId) {
            throw new Error(
              `Refusing to move a row to ${column}=${String(values[column])} while scoped to tenant ${tenantId}`
            );
          }
          return builder.update(values, options).eq(column, tenantId);
        },

        delete: (options?: Record<string, unknown>) => builder.delete(options).eq(column, tenantId),
      };
    },

    rpc: (fn: string, args?: Record<string, unknown>) => raw.rpc(fn, args),

    storage: raw.storage,

    unscoped: (reason: string) => {
      if (!reason || reason.trim().length < 8) {
        throw new Error("unscoped() requires a reason describing why this access is cross-tenant");
      }
      return raw;
    },
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
