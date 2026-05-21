# ContextGit — Delta Spec: Context Granularity & Retrieval Windowing

**Date:** 2026-05-21
**Status:** Ready for implementation — connectivity patch ships first (see Prerequisite)
**Target version:** 0.2.0 (the connectivity patch ships first as 0.1.x)
**Scope:** `packages/core`, `packages/store`, `packages/mcp`, `packages/cli` (CLAUDE.md fragment + hooks)

---

## Why this spec exists

Two independent sources, arrived at separately, point to the same defect.

**Source 1 — a Claude Code usage audit.** Asked directly whether ContextGit was
helpful in a real session, the agent said: the load was the most valuable call of
the session; the saves were "mostly write-only theater." Its sharpest specific
point: *"most of what I wrote into saves duplicated git log + commit messages. The
unique signal in the save was open_threads."*

**Source 2 — the GCC paper (Wu et al., Oxford, arXiv:2508.00031v2).** Its ablation
on SWE-Bench Verified: RoadMap + COMMIT alone moves a raw model from 67.2% to only
69.1%. Adding the fine-grained trace tier (Detailed Logs) plus windowed retrieval
jumps it to 75.3% — the single largest jump in the table.

Both are saying the same thing. ContextGit stores context almost entirely at one
resolution: the per-commit milestone summary. That is the *middle* tier, and it is
the **least valuable** tier — because git already stores it. The value is at the
edges: a coarse always-current roadmap, and a fine-grained reasoning trace that is
retrievable but never bloats the load.

This spec restratifies ContextGit's memory into three tiers and adds a context
budget to retrieval. It does **not** adopt GCC's plain-text-file store — see
Non-Goals.

---

## Prerequisite — ship the connectivity patch first

This PRD addresses two of the five Claude Code complaints (save/git redundancy;
thread accumulation). The other three are bugs covered by a separate, smaller spec:
**`01_ContextGit_DELTA_connectivity_fixes.md`** (target `0.1.x`).

That patch must ship and be re-audited against a connected install **before** this
spec begins — until the `@CLAUDE.contextgit.md` include is wired, the save half of
the loop is physically disconnected and no measurement of this work is meaningful.
The connectivity patch's audit result is the baseline this spec is measured against.

The save-rhythm replacement text in the "Save Rhythm" section below is shared
verbatim with the connectivity spec — keep the two identical.

---

## The three tiers

| Tier | Name | Resolution | Owns | Goes in default load? |
|------|------|------------|------|----------------------|
| Coarse | **Roadmap** | Project intent, milestones, open threads | "Where are we, what's unresolved" | Yes — always |
| Middle | **Commits** | Per-commit milestone summary | "What changed, when" | No — git owns this |
| Fine | **Trace** | Step-level reasoning notes | "Why we did/didn't do X" | No — pull-only, windowed |

The reframe in one sentence: **git is the system of record for the middle tier;
ContextGit's job is the coarse tier and the fine tier, and to make them both
retrievable without bloating context.**

### Coarse — Roadmap

Already partly exists as `SessionSnapshot.projectSummary` + `openThreads`. The gap
is that it is not *deliberately maintained* — it is a blob that gets rewritten
wholesale on save. This spec gives it structure: a persistent project-level record
of intent, current milestones, and the live open-thread set. It is the first thing
`project_memory_load` returns and the thing most worth keeping small and current.

### Middle — Commits

No change to what is stored. The change is editorial: agents stop being told to
write commit-summary saves that paraphrase the git commit message. A
`project_memory_save` is still pinned to a git commit SHA (`gitCommitSha`) but its
*body* should carry roadmap deltas and trace notes — not a restatement of what
`git log` already says.

### Fine — Trace (new)

A new, optional, append-only tier of step-level notes: decisions considered and
rejected, dead ends, "tried X, abandoned because Y." This is the ContextGit analog
of GCC's `log.md`.

**Hard constraint — the trace is pull-only.** It is NEVER included in
`project_memory_load`. It is retrieved on demand, windowed, via a dedicated tool.
A trace that auto-loads is just the "noisy fire-and-forget saves" Claude Code
already complained about, relocated. The trace earns its place only as cold storage
with an index.

---

## Retrieval windowing — the context budget `K`

GCC's `CONTEXT` returns a *bounded* window `Vₖ = {Mᵢ}` of records and lets the agent
scroll. ContextGit's `SessionSnapshot` hardcodes `recentCommits: Commit[] // last 3`.

This spec replaces the hardcoded 3 with an explicit budget:

- `project_memory_load` accepts an optional `commitWindow` (default 5) — how many
  recent commit records to include.
- A new retrieval tool (see Tools) accepts a `window` + `offset` so an agent can
  scroll back through commit history or trace history without exceeding its own
  context capacity.
- Windowing is also the mechanism that bounds the open-thread set — see Thread
  Decay.

This is small and high-value, and it is load-bearing for the decay work below.

---

## Thread decay

Claude Code's report: ~50 open threads on load, many stale (e.g. a thread for a
feature that already shipped), no decay mechanism, and closing threads by hand "felt
like friction" so it never happened. `ThreadManager` today is pure-read: it returns
every open thread, unfiltered.

Decay must be **structural, not behavioral** — telling agents to close threads does
not work; this session proved it. Three mechanisms, in order of build cost:

1. **Age-based staleness flag (cheap — ships with this spec).** `Thread` already has
   `createdAt`. A thread untouched for N sessions (default 8) is marked `stale` in
   the load — not deleted, just visually de-prioritized and excluded from the
   default window. Agent can still retrieve stale threads explicitly.

2. **Commit-distance decay (needs a schema field — ships with this spec).** Add
   `lastTouchedCommit` to the `Thread` type and `threads` table. A thread whose
   `lastTouchedCommit` is more than N commits behind HEAD (default 30) is treated as
   stale. Commit-distance is a better staleness signal than wall-clock age for
   bursty solo work.

3. **Auto-close on reference (post-launch — NOT this spec).** When a git commit
   message or context save references the subject of an open thread, propose closing
   it. This needs matching heuristics and a review step; deferred.

The default `project_memory_load` returns: all non-stale open threads + a count of
stale threads ("+12 stale threads — call project_memory_threads --stale to view").
That keeps the load clean without losing data.

---

## Save rhythm — shared with the prerequisite patch

This is the exact replacement framing for `CLAUDE_MD_FRAGMENT`,
`CONTEXT_COMMIT_SKILL`, and the `CONTEXTGIT_HOOKS` `additionalContext` strings.
Wording is deliberate and should not be softened further or re-hardened.

**Old rule (remove):** "Every git commit = immediate context commit. Do not batch.
Do not proceed until both are done."

**New rule:**

- Call `project_memory_save` at **session end**, always — a focused summary plus
  the 3–5 genuinely open threads for the next session.
- Call `project_memory_save` mid-session **only when project state changes in a way
  git does not capture**: a decision made, an approach abandoned, a thread opened or
  closed, scope changed (`replan:` prefix), an architectural choice.
- Do **not** save merely because a git commit happened. Git is the record of what
  changed. A context save that only paraphrases a commit message is noise.
- `project_memory_branch` before risky exploration — unchanged, still encouraged.

The `PostToolUse` hook with the `Bash(git commit*)` condition is **removed**, not
softened. It is the mechanism that manufactures per-commit noise; a gentler message
on the same trigger still fires on every commit. The `SessionStart` hook stays.

---

## Tools

### Changed

- `project_memory_load` — gains optional `commitWindow` (default 5). Returns the
  Roadmap (coarse), the commit window (middle), non-stale open threads, a stale
  count. Never returns trace entries.

### New

- `project_memory_trace` — append a step-level trace note. Optional `gitCommitSha`.
  Never auto-called; the agent uses it when recording a decision or dead end worth
  preserving below milestone granularity.
- `project_memory_retrieve` — windowed scroll-back. Params: `tier`
  (`commits` | `trace`), `window` (default 10), `offset` (default 0). This is the
  ContextGit analog of GCC's `CONTEXT --branch` / `CONTEXT --log` sliding window.
- `project_memory_threads` — list threads with a `--stale` filter. Gives the agent
  (and the human) a way to review and bulk-close stale threads without it being
  per-task friction.

### Unchanged

`project_memory_save`, `project_memory_branch`, merge, claim tools — surface
unchanged. Only the *guidance* on when to call `save` changes (see Save Rhythm).

---

## Data model changes

`packages/core/src/types.ts`:

- `Thread` — add `lastTouchedCommit?: string` and a derived `stale` flag (computed
  at read time, not stored).
- New `TraceEntry` interface: `id`, `projectId`, `branchId`, `note`,
  `gitCommitSha?`, `createdAt`.
- `SessionSnapshot` — `recentCommits` stays but is now sized by `commitWindow`; add
  `staleThreadCount: number`; add `roadmap` as a structured field distinct from the
  free-text `projectSummary`.

`packages/store` — new `trace` table; `threads` table gains `last_touched_commit`.
A migration is required; follow the existing migration pattern in the store package.

---

## Interaction with the team layer (backburner — not committed)

A team collaboration layer is sketched in `ContextGit_DELTA_team_layer.md` (shared
Supabase, RLS, contributor review-gate, GitHub Issues, contributor messaging). It is
**not on the active roadmap** — the current and primary user of ContextGit is a
solo developer, and this section exists only so that if teams are ever built, the
seam is already clean rather than a surprise.

This spec does not require the team layer and does not block on it. But the
three-tier split it introduces happens to make a future team layer *simpler*, so the
seam is worth recording now:

- **Coarse tier (roadmap intent + open threads)** — this is the natural shared
  object. One team, one roadmap, one open-thread set. If teams are built, this is
  the tier that syncs to Supabase and the tier the contributor review-gate guards.
- **Middle tier (commit summaries)** — git already syncs this; a team is on the same
  repo. Nothing to sync. This is a direct benefit of the granularity reframe: shared
  context no longer means shipping a second copy of git history.
- **Fine tier (trace)** — almost certainly **local-first with explicit promotion**,
  not auto-synced. A teammate's minute-by-minute dead-end log is noise to everyone
  else. A dead end worth sharing gets *promoted* into a shared open thread or
  roadmap note; the rest stays local. The local/promote boundary is an **open design
  question** deferred to whenever the team layer is actually picked up.

Note for future-you: `ContextGit_DELTA_team_layer.md` predates this tier split. If
teams are ever implemented, that spec needs a realignment pass — in particular the
`context_proposals` review-gate table should hold **coarse-tier proposals only**,
since that is the only tier a contributor write needs gating for.

---

## Non-Goals — explicitly NOT doing

- **Not adopting GCC's `.GCC/` plain-text-file store.** ContextGit's SQLite + git
  backbone with generated CLAUDE.md artifacts is the better architecture: it has a
  query layer, semantic search, and a path to RLS/team sync that a pile of `.md`
  files does not. Borrow GCC's *tiering and windowing*, not its storage model.
- **Not auto-loading the trace tier.** Pull-only, always. See the hard constraint
  above.
- **Not auto-closing threads on reference.** Deferred (decay mechanism 3).
- **Not claiming SWE-Bench numbers.** GCC's 80.2% is a controlled benchmark of an
  agent solving fresh issues. It is supporting evidence that structured memory
  helps; it is NOT a measurement of ContextGit's cross-session persistence claim,
  and must not appear in the README as a ContextGit metric.

---

## Validation gate

This spec is complete when, on a fresh Claude Code audit run against a connected
install (prerequisite patch already shipped):

1. `project_memory_load` returns a clean roadmap + a bounded commit window + only
   non-stale threads + an honest stale count. No 50-thread dump.
2. The session produces saves that the *next* session demonstrably reads (the `@`
   include is wired — verified by the prerequisite patch).
3. Asked the same question that started this — "is ContextGit helpful, honest
   answer" — Claude Code's answer no longer contains "write-only theater" and no
   longer says the saves duplicate git log.
4. The trace tier is used at least once for a real dead end, and retrieving it does
   not appear in the default load.

If 1–4 hold, the granularity restratification worked.

---

## Resolved decision — the core principle

This spec rests on a principle, confirmed by Mende: **ContextGit stores only what
exists nowhere else.**

Applied honestly, this cuts sharper than "keep coarse, drop middle":

- The **middle tier** (commit summaries) is dropped — git holds it.
- Even within the **coarse tier**, milestone *status* is partly reconstructable from
  merged PRs and tags. The genuinely irreducible part is **intent and unresolved
  state** — why this is being built, what was decided against, what is still open.
- The **fine tier** (trace) is irreducible by definition — dead ends and rejected
  approaches exist in no other system.

So the product is not "a memory layer." It is **the memory of intent and unresolved
state — the things git structurally cannot hold.** Roadmap status that git can
reconstruct is the least important thing the roadmap carries; intent and open
threads are the point.

Two independent sources support this: the Claude Code audit ("the unique signal was
open_threads") and the GCC ablation (the milestone-summary tier is the weakest).
The decision is settled — this is no longer an open question.
