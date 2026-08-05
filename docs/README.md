# PACE PDM docs

Start here.

| You want                               | Read                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| How to run the app                     | [`../README.md`](../README.md)                        |
| The engineering tour (read this first) | [`ENGINEERING.md`](ENGINEERING.md)                    |
| The rules, concisely                   | [`../AGENTS.md`](../AGENTS.md)                        |
| The "why" behind a rule                | [`decisions/`](decisions/)                            |
| What to work on next                   | [`plans/`](plans/)                                    |
| What a PDM term means                  | [`GLOSSARY.md`](GLOSSARY.md)                          |
| Every UI primitive, previewed          | `/admin/kitchen-sink` (admin-gated, dev + admin only) |

## How these layers relate

- **`AGENTS.md`** is the rulebook: short, imperative, kept current. Both people and AI load it. If a rule is not in there, it is not enforced by convention.
- **`docs/decisions/`** holds one file per standing decision, with the context that made it necessary, the alternatives rejected, and the consequences for future work. When a rule in AGENTS.md makes you ask "why on earth", the answer is here.
- **`docs/plans/`** is forward-looking and disposable: what is half-done and what to pick up next. A plan is a dated snapshot, so trust the counters it points you at over the numbers printed in it. Delete a plan when it is finished — anything durable in it belongs in a decision doc.
- **`docs/ENGINEERING.md`** is the human tour that connects the two and walks a newcomer through one feature end to end.

When a decision doc and any other doc disagree, the decision doc wins. Fix the drift.

## Writing a new decision doc

Add one when you make a choice the next person must follow and would not guess. Use the existing files as the template: what was true before, what broke or would have broken, what we chose, what we rejected and why, and — the part that matters most — **the consequence for every future change**.

Name it after the rule, not the incident: `tenant-isolation.md`, not `fix-june-leak.md`.
