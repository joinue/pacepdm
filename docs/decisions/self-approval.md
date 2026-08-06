# Self-approval is permitted, and the tenant may turn it off

**Status:** active
**Decided:** 2026-08-06
**Applies to:** `src/lib/approval-engine.ts`, `/api/ecos/[ecoId]`, `/api/approvals/[decisionId]`, tenant settings

## The rule

An approver may approve a request they authored. This is the **default**, and it
stays the default.

A tenant admin can turn it off with a single setting — `blockSelfApproval` — at
which point the requester is refused on their own request even though they hold
the permission and sit in the group.

Enforced in [`src/lib/self-approval.ts`](../../src/lib/self-approval.ts), which
both decision paths call. There are two, and that is the whole reason the check
lives in its own file rather than inside the approval engine:

1. **The approval engine** (`processDecision`, `rejectForRework`), when a
   workflow is assigned to the trigger.
2. **A direct status update** on `PUT /api/ecos/[ecoId]`, which is what runs
   when no workflow is assigned — and no tenant is seeded with an ECO workflow,
   so in practice this is the path almost every ECO takes.

Gating only the engine would leave the setting looking enforced while doing
nothing on the path everyone uses. That is finding 2 of the functional audit
exactly. **A third decision path means a third call to `blocksSelfApproval`.**

## Why permitted by default

The obvious rule — "never approve your own work" — deadlocks a small team.

PACE runs with a handful of engineers and two admins. An Engineer authors an ECO
and a Manager approves it, which is fine. But an Admin who authors an ECO is
frequently the only person holding `eco.approve` who is at their desk, and a
hard block means the change order waits for someone who may be on a plane. The
system then gets worked around — the author asks a colleague to click approve
on something they have not read, which is worse than self-approval because it
launders it.

The honest framing is that separation of duties is a **policy** an organisation
adopts when it has the staffing to sustain it, not a property software should
assert on everyone's behalf. What software owes is that the choice is explicit
and the record is truthful: the audit trail already names who approved what, and
self-approval is visible in it either way.

## Why it is a setting rather than a role permission

It is a property of the **tenant's process**, not of a person. Modelling it as a
permission would mean a role that can approve others' work but not its own,
which sounds sensible and immediately produces the question "who holds it?" —
and the answer is "everyone or no one", which is a setting.

It also has to be able to change without touching roles. A team that grows to
the point of wanting the control should get it with one toggle, not a role
migration.

## What it does not relax

Self-approval being allowed does **not** mean an approval is unguarded. All of
these still apply and are unaffected by the setting:

- Entering `APPROVED` or `REJECTED` on an ECO requires `eco.approve`.
- `RELEASED` and `OBSOLETE` on a BOM require `eco.approve`.
- The decider must be a member of the step's approval group.
- One vote per person per step, enforced by a compare-and-swap on the decision
  row. An ALL step still needs as many distinct deciders as the group has
  members — self-approval buys the author exactly one of those seats, not the
  step.

That last point is worth keeping in view: on an `ALL` or `MAJORITY` step,
allowing self-approval does not let an author approve alone. The mode already
requires other people. The setting matters most on `ANY` steps, which is where
a single click completes the request.

## Why the check fails open

A failed read of the tenant settings permits the approval.

The reflex for anything that looks like a governance check is to fail closed,
and it is wrong here. This is a **process preference**, not a security control.
Every real gate around an approval is enforced separately and is untouched by
a settings read: the `eco.approve` permission, approval-group membership, and
the one-vote-per-person compare-and-swap. A Supabase blip should not stop a
legitimate approver doing their job on the strength of a setting the tenant has
most likely not turned on.

Two ordering rules follow, both pinned by tests:

- **Membership and permission refusals win.** Someone outside the group, or
  without `eco.approve`, is told that — not told about a policy setting they
  could not have satisfied anyway.
- **The refusal lands before the compare-and-swap.** A refused attempt must not
  claim the decision row, or it would burn a seat and leave an `ALL` step one
  approval short forever.

## Related

- [`system-roles.md`](system-roles.md) — why nothing branches on a role's name, which is also why this is not a role
- [`../plans/functional-audit.md`](../plans/functional-audit.md) — finding 2, where an unenforced `eco.approve` made this reachable in a way nobody intended
