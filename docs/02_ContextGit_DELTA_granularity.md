# ContextGit — Delta Spec: Context Granularity & Retrieval Windowing

**Date:** 2026-05-21
**Status:** Ready for implementation — connectivity patch ships first (see Prerequisite)
**Target version:** 0.2.0 (the connectivity patch ships first as 0.1.x)
**Scope:** `packages/core`, `packages/store`, `packages/mcp`, `packages/cli` (CLAUDE.md fragment + hooks)

> **Correction (2026-05-25):** the save-rhythm rule in this spec ("save ~3x per
> session, not per commit") was **wrong** and is **superseded by
> `03_ContextGit_DELTA_thread_lifecycle.md`, Fix 3**. A usage audit established that
> the save is *bound* to its commit and that binding is the value — saving per
> commit is correct; the save *body* must carry decisions/dead-ends, not paraphrase
> the diff. The affected sections below (Save Rhythm; the "Middle — Commits" tier)
> are annotated inline. Read `03` Fix 3 as the authoritative rule.

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

**Source 3 — a second Claude Code audit, run after `01` shipped.** With the save
loop reconnected, the verdict improved to "net-positive, worth keeping" — the
next-task pointer and decision rationale were genuinely useful. But it surfaced two
new, concrete problems this spec must now address head-on:

- The stored top-level summary (Project State / Architecture) was **stale and
  actively misleading** — "3 commits on master" while the project was 100+ commits
  deep on a feature branch. A stale summary is *worse than no summary* because it
  primes the wrong mental model.
- The open-thread list had grown to ~90 entries with **literal duplicates** (three
  copies of one thread) and months-old speculative "watch for X" notes that were
  never coming back. Signal-to-noise was poor enough that the agent scanned the
  whole list to find the ~5 entries that mattered.

This spec restratifies ContextGit's memory into three tiers, adds a context budget
to retrieval, and — per Source 3 — makes pruning structural and first-class rather
than an afterthought. It does **not** adopt GCC's plain-text-file store — see
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

The save-rhythm rule is defined authoritatively in `03` Fix 3 — see the Correction
notice at the top of this file.

---

## The three tiers

| Tier | Name | Resolution | Owns | Goes in default load? |
|------|------|------------|------|----------------------|
| Coarse | **Roadmap** | Intent, next-task pointer, decision rationale, curated threads | "Where are we, what's unresolved, why" | Yes — generated fresh each load |
| Middle | **Commits** | Per-commit milestone summary | "What changed" (git) + the intent bound to that commit (the save) | No — windowed |
| Fine | **Trace** | Step-level reasoning notes | "Why we did/didn't do X" | No — pull-only, windowed |

The reframe in one sentence: **git records what changed at each commit; the save
bound to that commit records the intent — together they let any future puller
reconstruct code and intent at any commit. ContextGit's job is the coarse and fine
tiers plus that commit-bound intent layer.**

### Coarse — Roadmap

Already partly exists as `SessionSnapshot.projectSummary` + `openThreads`. Source 3
exposed the core defect: it is a **stored blob written once and never refreshed**,
so it goes stale and actively misleads ("3 commits on master" on a 100+-commit
branch).

Two rules fix this:

1. **The Roadmap is generated fresh on every `project_memory_load`, never served
   from a stale store.** Volatile facts — current branch, commit count, HEAD — are
   read live from git at load time, not stored. A fact that git can answer is never
   cached in ContextGit; caching it is how it goes stale.

2. **Architecture prose is dropped, not maintained.** Source 3 was explicit: a
   prose "Architecture summary" describing the code is reconstructable from the
   code, and a stale one is harmful. The codebase is the source of truth for
   structure. ContextGit does not store an architecture description.

What the Roadmap *does* keep is the irreducible part Source 3 found valuable: the
**intent** (why this is being built), the **next concrete task** pointer, the
**decision rationale** that does not live in commit messages, and the curated
open-thread set. These exist nowhere else — see "Resolved decision" below. The
Roadmap is the first thing `project_memory_load` returns and the thing most worth
keeping small, current, and free of anything git can answer itself.

### Middle — Commits

> **Corrected per `03` Fix 3.** The original text here said agents should *stop*
> writing per-commit saves. That was wrong. A save is *bound* to a commit and the
> binding is the value: git holds the diff, the save holds the intent, and a future
> puller needs both at every commit. So a save is written **per commit** — the
> correction is to the *body*, not the frequency.

A `project_memory_save` is pinned to a git commit SHA (`gitCommitSha`) — that
pairing is its primary job. Its *body* must not paraphrase the diff (git has that);
it carries what the diff cannot show — the decision behind the change, an abandoned
approach, an open question the commit raises. Both jobs, one save, every commit.

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

## Thread decay and pruning

This is the **headline of `0.2.0`**, not a tail feature. Source 3 found a ~90-entry
open-thread list on the live install — duplicates, stale speculation, months-old
items — costing real scan-time every single session. The install is hurting *now*.
Build this before the trace tier.

`ThreadManager` today is pure-read: it returns every open thread, unfiltered. There
is no dedupe, no decay, no notion of staleness. Source 3 named three distinct
problems, and they need three distinct fixes.

### Problem A — duplicates (a save-path bug, not a decay problem)

Source 3 saw three literal copies of "Write Plan B Extension." That is not staleness
— it is a missing uniqueness check on write. **Fix: dedupe-on-save.** When
`project_memory_save` opens a thread, normalize its subject (trim, lowercase,
collapse whitespace) and compare against existing open threads on the same project;
if it matches, update the existing thread's `lastTouchedCommit` instead of inserting
a duplicate. This ships first in `0.2.0` because it is small and stops the list
growing today.

### Problem B — speculative notes are not open threads

The list mixed two things that should never have the same lifetime: genuine open
threads ("the `regenerate_ac` silent-empty-AC bug" — a real unresolved decision)
and speculative "watch for X" / "consider Y" notes that are reminders, not
commitments. The second category accumulates forever because nothing ever formally
"resolves" a vague watch-for.

**Fix: a `kind` field on `Thread` — `'open' | 'watch'`.** A `watch` note carries a
short TTL (default 3 sessions or 15 commits, whichever first) and is dropped silently
on expiry — it was never a commitment. An `open` thread never expires on a timer;
it decays to `stale` (below) but is preserved. The agent picks `kind` at save time;
the save-rhythm guidance says decisions and unresolved problems are `open`,
reminders are `watch`.

### Problem C — genuine threads still go stale

A real open thread for a feature that already shipped is stale but should not be
deleted. Two staleness signals, both ship with this spec:

1. **Age-based.** A thread untouched for N sessions (default 8) is flagged `stale`.
2. **Commit-distance.** Add `lastTouchedCommit` to `Thread` and the `threads` table.
   A thread more than N commits behind HEAD (default 30) is `stale`. Commit-distance
   is the better signal for bursty solo work.

`stale` is a read-time derived flag, not stored. Stale `open` threads are excluded
from the default load but retrievable via `project_memory_threads --stale`.

### Deferred — auto-close on reference (NOT this spec)

When a commit message references a thread's subject, propose closing it. Needs
matching heuristics and a review step; post-launch.

### What the load returns

The default `project_memory_load` returns: non-stale `open` threads + non-expired
`watch` notes + a single honest count line ("+12 stale, +7 expired-watch — call
project_memory_threads to view"). No 90-entry dump. The agent sees only what is
live; nothing is lost, everything off-list is one explicit call away.

---

## Save rhythm

> **This section is SUPERSEDED by `03_ContextGit_DELTA_thread_lifecycle.md`, Fix 3.**
> The rule below ("save ~3x per session, not per commit") was wrong. The correct
> rule: a save is written **per commit** because it is *bound* to that commit;
> the save body carries decisions / abandoned approaches / open questions, not a
> paraphrase of the diff. The `PostToolUse` hook removal still stands. `03` Fix 3
> is authoritative; the text below is kept only to record what changed and why.

~~Call `project_memory_save` at session end plus ~3x per session, not per commit.~~
Superseded — see `03` Fix 3.

What still stands from the original section: the `PostToolUse` hook with the
`Bash(git commit*)` condition is **removed** (it manufactured a hard MANDATORY
prompt on every commit). The `SessionStart` hook stays. `project_memory_branch`
before risky exploration is unchanged.

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
- `project_memory_threads` — list threads with `--stale` and `--expired-watch`
  filters. Gives the agent (and the human) a way to review stale `open` threads and
  expired `watch` notes without it being per-task friction.

### Unchanged

`project_memory_save`, `project_memory_branch`, merge, claim tools — surface
unchanged. Only the *guidance* on when to call `save` changes (see `03` Fix 3).

---

## Data model changes

`packages/core/src/types.ts`:

- `Thread` — add `kind: 'open' | 'watch'` (default `'open'`), `lastTouchedCommit?:
  string`, and a derived `stale` flag (computed at read time, not stored). `watch`
  threads also carry an expiry derived from `createdAt` / `lastTouchedCommit`.
- New `TraceEntry` interface: `id`, `projectId`, `branchId`, `note`,
  `gitCommitSha?`, `createdAt`.
- `SessionSnapshot` — `recentCommits` stays but is now sized by `commitWindow`; add
  `staleThreadCount` and `expiredWatchCount`; add `roadmap` as a structured field
  distinct from the free-text `projectSummary`. Volatile git facts (branch, HEAD,
  commit count) are populated live at load time, never persisted.

`packages/store` — new `trace` table; `threads` table gains `kind` and
`last_touched_commit` columns. A migration is required; follow the existing
migration pattern in the store package.

---

## Implementation order

Source 3 reprioritized this spec: the live install is hurting from list bloat
*today*, while the trace tier is net-new value with no active pain. Build in this
order:

1. **Types + schema/migration** — `Thread.kind`, `lastTouchedCommit`, `TraceEntry`,
   the `trace` table, the `threads` column additions. Foundational; touches no
   behavior. (This is the "Steps 1–2" scope.)
2. **Dedupe-on-save** — the uniqueness check in `project_memory_save`. Smallest
   behavioral fix, stops the list growing immediately.
3. **Decay + prune** — `stale` derivation, `watch` TTL expiry, the curated load
   output, `project_memory_threads`. This is the headline fix.
4. **Windowed retrieval** — `commitWindow` on `project_memory_load`,
   `project_memory_retrieve`.
5. **Trace tier** — `project_memory_trace` and the pull-only fine tier. Last: it is
   new capability, not active-pain relief, and it is the most likely to reintroduce
   noise if rushed.

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
- **Middle tier (commit-bound saves)** — git already syncs the diffs; the saves
  bound to those commits sync with them. This is the layer that lets a teammate
  pull at any commit and get both code and intent.
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
install:

1. `project_memory_load` returns a Roadmap whose volatile facts (branch, commit
   count, HEAD) are *correct* — generated live, not a stale stored blob. No
   "3 commits on master" while 100 commits deep.
2. The open-thread list in the load is curated: no duplicates, no expired `watch`
   notes, only non-stale `open` threads, plus an honest count of what was filtered.
   No ~90-entry dump.
3. Saving the same thread subject twice does not create a duplicate (dedupe-on-save).
4. A `watch` note expires on its TTL and silently drops from the load; an `open`
   thread in the same position goes `stale` but is still retrievable.
5. The session produces saves that the *next* session demonstrably reads.
6. The trace tier is used at least once for a real dead end, and retrieving it does
   not appear in the default load.
7. Asked the honest-answer question, Claude Code no longer reports stale top-level
   summaries or a noisy, duplicate-ridden thread list.

If 1–7 hold, the granularity restratification worked.

---

## Resolved decision — the core principle

This spec rests on a principle, confirmed by Mende: **ContextGit stores only what
exists nowhere else.**

Applied honestly:

- The diff itself is git's — never paraphrase it into a save.
- But the **intent bound to each commit** exists nowhere else: why the change was
  made, what was rejected, what question it raises. That is what the per-commit
  save carries (see `03` Fix 3).
- The **coarse roadmap** — intent, next-task pointer, open threads — exists nowhere
  else. (Milestone *status* is reconstructable from PRs and tags, so it is not
  stored; it is generated live.)
- The **fine trace** — dead ends and rejected approaches — is irreducible by
  definition.

So the product is not "a memory layer." It is **the memory of intent — bound to
each commit, surfaced as a roadmap, and traceable down to abandoned approaches —
the things git structurally cannot hold.**

Two independent sources support this: the Claude Code audits and the GCC ablation.
The decision is settled.
