# Plans

Forward-looking work, one file per effort. Distinct from [`../decisions/`](../decisions/), which records choices already made and is kept current forever.

When a plan is finished, delete it — the durable part belongs in a decision doc or in `AGENTS.md`, not here.

## The rule: work updates its plan, in the same commit

A stale plan is worse than no plan. It reads as current, so the next person trusts it — and either re-does something already finished or skips something that isn't.

So: **if your change alters what a plan describes, update that plan in the same commit.** Move the item, strike the finished part, and write down anything you learned that would have saved you an hour.

This is enforced rather than hoped for. Every plan declares the numbers it asserts in a machine-readable block:

```markdown
<!-- plan-metrics
routes-wrapped: 28
raw-fetch: 112
-->
```

`npm run lint:plans` (part of `npm run check`, and run in CI) recomputes each of those from the codebase. If a number has drifted, the build fails and prints the new value. Once the prose is fixed:

```bash
npm run lint:plans -- --update    # syncs the metrics block
```

A plan with no `plan-metrics` block fails too — if a plan genuinely makes no numeric claims, say so in an empty block rather than omitting it, so the omission is a decision rather than an oversight.

Available metrics live in `METRICS` at the top of [`../../scripts/lint-plans.mjs`](../../scripts/lint-plans.mjs). Add one there when a plan needs to assert something new; an undeclared metric name is an error, not a silent pass.

| Plan                                               | Status                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| [`codebase-hardening.md`](codebase-hardening.md)   | In progress — the route wrapper, primitive adoption, and debt burn-down   |
| [`cad-erp-integration.md`](cad-erp-integration.md) | In progress — importer built; the item-master import gates the rest       |
| [`change-control.md`](change-control.md)           | In progress — workflow review shipped; ECO-implements-BOM is the top item |
