# ContextGit — Delta Spec: Planning Hierarchy

**Date:** 2026-05-25
**Status:** Ready for implementation — part of the locked 0.2.0 scope
**Target version:** 0.2.0 (ships in the single 0.2.0 release; not published yet)
**Scope:** `packages/core` (types, planning manager), `packages/store` (plan tables + migration), `packages/mcp` (planning tools), load formatter

---

## Why this spec exists

ContextGit has been storing two fundamentally different things in one `threads`
table, and a usage incident exposed it: planning items ("next step: build the
archive table", "Slice 3: component primitives") were swept into `thread_archive`
by the decay logic — because the system cannot tell a **task you intend to do**
from an **unresolved question that legitimately goes stale**.

They have opposite lifecycles:

- A **planning task** is resolved by being **done**. It is checked off. It must
  **never decay** — a planned step does not become irrelevant because 30 commits
  passed; it is either done or still pending.
- An **open thread / watch note** is an unresolved question. It legitimately
  decays — see `02`/`03`.

`02` introduced `kind: 'open' | 'watch'` on threads. This spec recognises a third
thing that is not a thread at all: a **task**. It has a checkbox, not a decay
timer, and it belongs in its own structure.

The user's real work is already hierarchical — "Plan 1D-α" contains "Slice 3"
contains individual tasks. So planning is modelled as a three-level hierarchy, not
a flat list.

---

## The model — plan → step → task

Three levels, one self-referential table (not three tables — see Data Model):

- **Plan** — a unit of intended work. e.g. "Plan 1D-α: webapp foundation."
- **Step** — a phase within a plan. e.g. "Slice 3: new component primitives."
- **Task** — a single checkable item. e.g. "Build StatusDot component."

Each node has a `status`: `pending | in_progress | done`. A node is **checked off
as work proceeds** — the agent (or the user) marks it `done`. A plan/step is
derived-complete when all its children are `done`; this is computed at read time,
not stored, to avoid drift.

**Planning nodes never decay and are never archived by the staleness sweep.** They
are removed from the active view only by being marked `done`, or explicitly
deleted. This is the hard rule that the incident was caused by violating.

---

## Lifecycle

- A node is created `pending`.
- Marked `in_progress` when work starts (optional — agents may skip straight to
  `done` for small tasks).
- Marked `done` when complete.
- A `done` plan (all children done) drops out of the default load — but is NOT
  archived to a staleness table. It moves to a `completed` state, retrievable via
  `project_memory_plans --completed`. Completed plans are the project's delivery
  record; keep them, do not decay them.

The distinction from threads: a thread's end state is *stale* (time killed it); a
plan's end state is *done* (work completed it). Different verbs, different tables,
different load treatment.

---

## Data model

`packages/store` — **one new table**, `plan_nodes`, self-referential:

```
plan_nodes
  id            text primary key
  project_id    text not null
  parent_id     text null            -- null = top-level plan; else step/task
  level         text not null        -- 'plan' | 'step' | 'task'
  title         text not null
  status        text not null        -- 'pending' | 'in_progress' | 'done'
  position      integer not null     -- ordering among siblings
  git_commit_sha text null           -- commit that completed this node, if any
  created_at    text not null
  completed_at  text null
```

One table, not three — `level` + `parent_id` gives the hierarchy. Simpler
migration, simpler queries, and depth is naturally capped at 3 by the `level`
enum. Migration v9 (v8 is `03`'s `thread_archive`).

`packages/core/src/types.ts`:

- New `PlanNode` interface mirroring the table.
- Derived (read-time, not stored): `progress` on plan/step nodes —
  `{ done: n, total: m }` from children.

No change to `threads` / `thread_archive`. Planning is a separate structure;
threads remain for unresolved questions, exactly as `02`/`03` define them.

---

## Tools

Minimal surface — three tools, kept small so this fits the 0.2.0 window:

- `project_memory_plan` — create or update plan nodes. Can create a whole
  plan→step→task tree in one call (nested input), or update one node's `status` /
  `title`. This is the write path for both "lay out a plan" and "check off a task."
- `project_memory_plans` — read. Returns the active plan tree (non-`done` nodes,
  with `done` children shown checked for context). `--completed` returns finished
  plans. `--plan <handle>` drills into one.
- Checking off rides along with `project_memory_save` too: `save` gains
  `completesTasks: string[]` (6-char handles or titles, same resolver rule as
  `03`'s `closesThreads` — handle-first, then title, error loud if neither). A
  session-end save can mark its finished tasks done in the same call.

`project_memory_load` — the active plan tree appears as a new `## Plan` section,
near the top, **above** `## Open Threads`. The next-actionable `pending` task is
the single most useful line in the load (the audits said so repeatedly); surface
it clearly — e.g. a `→ next:` marker on the first pending task.

Handles: plan nodes get the same 6-char handle treatment as threads in `03`, with
the same collision-error rule.

---

## Load formatting

```
## Plan
▸ Plan 1D-α: webapp foundation        [3/5 done]
  ✓ Slice 1: scaffold
  ✓ Slice 2: state card variants
  ▸ Slice 3: component primitives     [1/7 done]
    ✓ StatusDot
    → ProgressBar          ← next
      AISuggestionCard
      ... (4 more pending)
  ○ Slice 4: per-screen polish
  ○ Slice 5: filled-CTA button
```

Done nodes shown checked (context, not noise) but collapsed; the cursor is the
first `pending` task. Completed plans are not shown — `--completed` to see them.

---

## NOT in this spec

- **No decay, no staleness, no archive sweep for plan nodes.** This is the whole
  point. Planning nodes leave the active view by being `done`, never by aging out.
- **No dependencies / blocking between tasks.** A task is `pending` or not; it does
  not declare "blocked by task X." Dependency graphs are a real feature but they
  are 0.3.x, not this — they would blow the 0.2.0 window.
- **No auto-generation of plans from delta specs.** Tempting (the specs are already
  plan→step→task shaped) but it is a separate parsing feature. Out.
- **No more than 3 levels.** The `level` enum caps it. If a task needs sub-tasks,
  it is really a step — restructure, do not deepen.

---

## Interaction with the rest of 0.2.0

- **Threads vs plans, clear split:** threads = unresolved questions (decay, archive
  per `03`); plans = intended work (check off, complete, never decay). The decay
  sweep in `03` must explicitly exclude `plan_nodes` — it only ever touches
  `threads`. State this in the `03` sweep implementation.
- **Migration order:** v9, after `03`'s v8.
- **The one-time thread sweep (`03` Fix 1)** should NOT have touched planning items
  — but it did, because they were threads. After this spec, anything that is really
  a plan/step/task is created as a `plan_node` and is structurally immune. Existing
  planning-shaped threads wrongly archived by the sweep can be `--restore`d (per
  `03`) and, if desired, manually re-created as plan nodes. No automatic migration
  of old threads into plans — too lossy to guess; leave it manual.

---

## Validation gate

Part of the 0.2.0 gate. Complete when:

1. A plan→step→task tree can be created in one `project_memory_plan` call and
   appears as `## Plan` in the load, above `## Open Threads`.
2. Marking a task `done` — via `project_memory_plan` or `completesTasks` on a save
   — updates it; parent progress (`[n/m done]`) recomputes correctly.
3. A plan with all children `done` drops out of the default load and appears under
   `project_memory_plans --completed`. It is NOT in any staleness/archive table.
4. The `03` decay sweep, run against a project with plan nodes, archives zero plan
   nodes — planning is structurally exempt.
5. The load marks the first `pending` task as `→ next`.
6. Plan nodes get 6-char handles; closing/completing by handle and by title both
   work, with loud errors on no-match.

---

## Why this fits the month

It is one table, three tools, one load section. The hierarchy is real but it is a
single self-referential table, not a graph. No decay logic (planning is exempt),
no dependency resolution (out of scope), no spec-parsing (out of scope). It reuses
`03`'s handle and resolver patterns rather than inventing new ones. That is a
bounded, finishable feature — it belongs in 0.2.0 without blowing the cadence.
