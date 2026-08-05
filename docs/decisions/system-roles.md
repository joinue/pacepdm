# System roles

**Status:** active
**Applies to:** `DEFAULT_ROLES` in [`src/lib/permissions.ts`](../../src/lib/permissions.ts), and anything that gates on a permission

## The ladder

Four roles are seeded into every tenant at signup, and marked `isSystem` so they cannot be edited or deleted:

| Role         | What it is for                                                        |
| ------------ | --------------------------------------------------------------------- |
| **Admin**    | Runs the tenant. Holds `*`.                                           |
| **Manager**  | Runs a team. Engineer, plus deletion, folder ACLs, and the audit log. |
| **Engineer** | Does the work. Files, folders, and ECOs.                              |
| **Viewer**   | Reads. `file.view` only.                                              |

## Why Manager exists

Until it did, the ladder was read → do → own the tenant, with nothing in between, and five declared permissions were reachable **only** through Admin's wildcard:

```
file.delete   folder.delete   folder.manage_access   audit.view   eco.approve
```

None of those is an act of tenant administration. Deleting a superseded drawing, setting up who can see the Manufacturing folder, and answering an auditor are all ordinary team-lead work — and all of them required a role that also grants role authoring, SSO configuration, workspace settings, and `folder.bypass_access`.

The practical result on a small team is that everyone senior becomes an Admin, which is how a permission system stops meaning anything. Manager is the rung that makes "not an Admin" a viable answer.

## What Manager must never get

These are the boundary, and they are the reason the role is worth having at all. A change that adds any of them to `DEFAULT_ROLES.Manager` has erased the distinction:

- **`admin.roles`** — role authoring is the lever every other permission is reachable through.
- **`admin.settings`, `admin.lifecycle`, `admin.metadata`** — these configure how the workspace itself behaves. A Manager runs the team; an Admin runs the tenant.
- **`folder.bypass_access`** — Manager can _grant_ folder access, which is auditable and per-folder. Seeing through every ACL at once is a support and debugging capability.
- **`*`** — obviously, but state it: the wildcard also silently confers every permission added in future releases.

`src/lib/permissions.test.ts` asserts each of these. They are not stylistic.

## Why `admin.users` is safe on a non-Admin role

It is the only inclusion that looks like a mistake, so here is why it is not.

Both role authoring and role _assignment_ run the same ceiling, `permissionsExceedingActor`:

- [`POST /api/roles`](../../src/app/api/roles/route.ts) — you cannot mint a role granting a permission you lack.
- [`PUT /api/users/[userId]`](../../src/app/api/users/[userId]/route.ts) — you cannot assign a role whose permissions exceed your own.

Without the second check, `admin.users` alone would be a privilege-escalation path: assign yourself the existing Admin role, done. With it, a Manager can invite, deactivate, and reassign people, but every role they can hand out is a subset of what they already hold. Manager cannot create an Admin, and cannot become one.

**If you ever add a route that changes a user's role, it must run that ceiling.** This is the check that makes the whole ladder hold.

## `eco.approve` is not what it sounds like

It does **not** gate approving. Approval authority comes from assignment — approval workflows, their steps, and approval groups produce `approval_decisions` rows, and only the assigned approver can sign one. The permission's only reader is [`POST /api/ecos`](../../src/app/api/ecos/route.ts), which uses it to decide who gets notified that a new ECO needs attention.

Granting it makes someone visible as an approver. Configuring who can actually sign is Admin → Approval Groups, which is gated on `admin.settings`.

## Adding a permission

New permissions default to nobody, because no role enumerates them and only `*` picks them up implicitly. That is the safe direction, but it means a new permission is invisible until it is placed:

1. Add it to `PERMISSIONS`.
2. Add copy to `PERMISSION_INFO` in the same edit — the roles admin screen renders the label and description, and a permission whose meaning is legible only to someone reading route code is one that gets granted by accident. A test fails if you skip this.
3. If it is dangerous enough to want a warning beside its checkbox, add it to `SENSITIVE_PERMISSIONS`.
4. Decide which of the four roles should hold it, and say so — including "none but Admin", which is a real answer.

## Changing a seeded role

`DEFAULT_ROLES` runs at tenant creation only ([`POST /api/tenants`](../../src/app/api/tenants/route.ts)). Editing the constant gives the change to workspaces created afterwards and to nobody who already exists, and system roles are frozen against `PUT`, so tenants cannot self-correct.

**A change to `DEFAULT_ROLES` needs a migration that backfills existing tenants in the same commit.** [`migration-047-manager-role.sql`](../../supabase/migrations/migration-047-manager-role.sql) is the reference: guarded by `NOT EXISTS` on `(tenantId, name)` so it is re-runnable, matching on name so a tenant that hand-rolled a role of the same name keeps theirs, and reassigning nobody — who holds which role is a decision a person makes.

## Admin pages gate per segment

`admin/layout.tsx` admits anyone holding _some_ `admin.*` permission. That is a coarse fence for the section, and it is not the gate.

While Admin was the only role with any `admin.*` permission, the coarse check was accidentally exact — it meant "is Admin". Manager is the first role to hold exactly one, and the approximation broke immediately: a Manager holding `admin.users` could reach the lifecycle editor, the workflow builder, the metadata screen, and the roles screen by typing the URL, each of which rendered fully and then 403-ed on save.

So every admin segment declares its own requirement in a `layout.tsx`:

```tsx
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AdminGate permission={PERMISSIONS.ADMIN_LIFECYCLE}>{children}</AdminGate>;
}
```

**A new admin page needs the same permission in three places**: the segment's `layout.tsx`, its route handlers, and its sidebar entry. They must agree — a page reachable but unusable is the bug this closes.

## Reads are gated like writes, unless something else needs them

An admin GET left open to any authenticated user is not harmless. `/api/workflows` returns who signs what at which step, and `/api/approval-groups` returns the membership of every approval group. Both now require `ADMIN_SETTINGS` to read, matching their writes.

Three endpoints deliberately stay readable by any tenant user, because non-admin surfaces depend on them. Check before gating one of these:

| Endpoint         | Non-admin consumer                                        |
| ---------------- | --------------------------------------------------------- |
| `/api/settings`  | the parts page, for part-numbering configuration          |
| `/api/lifecycle` | the upload dialog and the file-action menu                |
| `/api/roles`     | the folder access dialog, and the SSO default-role picker |

`/api/roles` splits by detail level instead: names and descriptions for anyone, the permission array and assigned-user count only for `ADMIN_ROLES` or `ADMIN_USERS`. Those consumers need to identify a role, not to know what it grants, and a Viewer enumerating every role's permissions has a map of the tenant's authorisation model for no product reason.

## Navigation follows permissions, not role names

Nothing in the UI branches on a role's _name_, and nothing should — tenants can create custom roles, so a name proves nothing about what its holder can do.

The sidebar previously approximated this by showing the Admin group to anyone holding some `admin.*` permission. That broke in both directions once roles were more than Admin/Engineer/Viewer: a role with `audit.view` and no `admin.*` permission could not reach the audit log at all, because its only link lived inside a group they never saw; and a role with one `admin.*` permission saw links to all eight admin pages, seven of which 403 on save.

Every nav item now declares the permission its own page and API require, and a group renders only if something in it survived. See [`sidebar.tsx`](../../src/components/layout/sidebar.tsx).
