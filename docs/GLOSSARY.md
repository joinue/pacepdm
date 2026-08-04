# Glossary

PDM vocabulary, and where each concept lives in the code. Domain terms mean specific things to manufacturing customers, so use them precisely.

## Domain terms

**PDM** — Product Data Management. Managing the engineering data that describes a physical product: CAD files, drawings, part numbers, bills of materials, and the change process around them. PLM (Product Lifecycle Management) is the larger category that also covers manufacturing, quality, and service. This product is deliberately PDM.

**Part** — a distinct physical item with a part number. Table `parts`. A part may have CAD files attached, may appear in many BOMs, and may be sourced from one or more vendors.

**BOM (Bill of Materials)** — the structured list of parts making up an assembly, with quantities. Multi-level: a BOM item can itself be a BOM, which is what makes rollup nontrivial. Tables `boms` and `bom_items`. Rollup logic in [`bom-rollup.ts`](../src/lib/bom-rollup.ts).

**Rollup** — computing an assembly's total quantity and cost by walking down through its sub-assemblies. A change three levels down changes the top-level cost.

**Where-used** — the inverse of a BOM: given a part, which assemblies contain it. The question you ask before changing anything. [`where-used.ts`](../src/lib/where-used.ts).

**Revision** — a released iteration of a file or BOM, labelled `A`, `B`, `C`. Distinct from **version**, which is every saved change including drafts. A part goes through many versions between revisions.

**ECO (Engineering Change Order)** — the controlled process for changing released data. Someone proposes a change, affected parties approve it, and only then does the released data move. Table `ecos`. Status flow in [`status-flows.ts`](../src/lib/status-flows.ts): `DRAFT → SUBMITTED → IN_REVIEW → APPROVED → IMPLEMENTED → CLOSED`, with `REJECTED` looping back to `DRAFT`.

**Lifecycle state** — where a file sits in its maturity progression (for example In Work → In Review → Released → Obsolete). Configurable per tenant under Admin → Lifecycle, unlike the BOM and ECO flows which are fixed.

**Release** — a frozen, named snapshot of a set of data at a point in time, for handing to manufacturing. Table `releases`, logic in [`releases.ts`](../src/lib/releases.ts).

**Check-out / check-in** — the pessimistic lock that keeps two engineers from editing the same CAD file simultaneously. Checking out marks the file as yours and blocks others; checking in uploads a new version and releases the lock. Non-negotiable in CAD, where files are binary and cannot be merged.

**Frozen** — a file that cannot be modified because it is part of a release or an approved ECO.

**Vault** — the file store: folders, files, versions, thumbnails, and per-folder access control. The app's largest feature.

**Approval workflow** — the configured sequence of approval steps an ECO passes through. Tables `workflows` and `approvals`, engine in [`approval-engine.ts`](../src/lib/approval-engine.ts).

**Approval group** — a named set of users who can satisfy an approval step. Any member can approve, or the step can require all, depending on configuration.

**Rework** — a rejection that sends an ECO back to its author with comments rather than killing it outright.

## Code and platform terms

**Tenant** — one customer organization. Table `tenants`; membership in `tenant_users`. A user belongs to exactly one tenant. → [`decisions/tenant-isolation.md`](decisions/tenant-isolation.md)

**Tenant user** — the join of an auth identity to a tenant and a role. `getApiTenantUser()` resolves it; it is what routes mean by "the caller".

**Service client** — `getServiceClient()`, a Supabase client on the service-role key. Bypasses RLS completely. Only reachable inside the route wrapper.

**Scoped client** — what `withTenant` hands a route handler. Wraps the service client and applies the tenant filter automatically. → [`decisions/api-route-contract.md`](decisions/api-route-contract.md)

**RLS (Row-Level Security)** — Postgres policies restricting which rows a role can see. Here it is a backstop against direct PostgREST access, not the app's authorization. → [`decisions/rls-new-tables.md`](decisions/rls-new-tables.md)

**Folder access scope** — the resolved per-user sets of allowed / editable / admin folders, from the `get_folder_access_scope` RPC. A second authorization gate independent of role permissions. [`folder-access.ts`](../src/lib/folder-access.ts).

**Bypass** — `FOLDER_ACCESS_BYPASS`, a permission that skips folder ACLs entirely. For support and debug roles.

**JIT provisioning** — creating a tenant user on first SSO login by matching the email domain against `tenant_sso_domains`. An existing row always wins; users are never migrated between tenants. [`sso-jit.ts`](../src/lib/sso-jit.ts).

**Share token** — a bearer credential in a URL granting anonymous access to a file, BOM, or release. Table `share_tokens`; the highest-sensitivity table in the schema. [`share-tokens.ts`](../src/lib/share-tokens.ts).

**Idempotency key** — a client-supplied header persisted as `clientRequestKey`, so a retried create does not produce a duplicate.

**Side effect** — post-mutation async work (notifications, mentions, thumbnails) wrapped in `sideEffect()` so its failure is logged rather than failing the request.
