# Standing decisions

One file per decision that constrains future work. Each explains the context, the choice, the alternatives rejected, and the consequence for every change that comes after.

| Decision                                                   | In one line                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`api-route-contract.md`](api-route-contract.md)           | Every route handler is wrapped in `withTenant`; auth, scoping, validation and error mapping are never hand-rolled.                     |
| [`tenant-isolation.md`](tenant-isolation.md)               | The tenant comes from the session and is applied by the data client, not by each query.                                                |
| [`rls-new-tables.md`](rls-new-tables.md)                   | Every new table gets RLS in the migration that creates it. Deny-all is the default.                                                    |
| [`hand-applied-migrations.md`](hand-applied-migrations.md) | Migrations are raw SQL pasted into the Supabase dashboard, must be idempotent, and are not a ledger of what is live.                   |
| [`data-fetching.md`](data-fetching.md)                     | Three sanctioned patterns (server component, `useFetch`, `fetchJson`). Raw `fetch` in a client component is a lint error.              |
| [`design-tokens.md`](design-tokens.md)                     | Semantic tokens only. No raw palette classes, no arbitrary pixel values. Enforced by a linter.                                         |
| [`testing-strategy.md`](testing-strategy.md)               | What must be tested, what must not, and why route handlers are tested with a mocked Supabase client rather than a live database.       |
| [`feature-folders.md`](feature-folders.md)                 | Feature code lives in `src/features/<feature>/` and owns its own components, hooks, and types.                                         |
| [`bom-structure.md`](bom-structure.md)                     | BOM hierarchy is derived from `linkedBomId` and never stored; "is this a product" is declared on `parts.isEndItem` and never inferred. |
| [`perceived-performance.md`](perceived-performance.md)     | Cache the session per request, mutate optimistically, suppress your own realtime echo, and shape skeletons like the page they replace. |
| [`system-roles.md`](system-roles.md)                       | Four seeded roles, what Manager must never hold, and why a change to `DEFAULT_ROLES` needs a backfill migration.                       |
| [`supplier-access.md`](supplier-access.md)                 | Part shares resolve live and default to released files; release shares are frozen. The two must never converge.                        |
| [`erp-ownership.md`](erp-ownership.md)                     | NetSuite owns part numbers and cost; PACE owns revision and approval. They join on `externalId`, never on part number.                 |
| [`self-approval.md`](self-approval.md)                     | An approver may approve their own request by default; a tenant admin can turn it off with one setting.                                 |
| [`retention-and-formats.md`](retention-and-formats.md)     | Nothing in the trash is destroyed on a timer, neutral-format exports are prompted not required, and production is the dev database.    |
