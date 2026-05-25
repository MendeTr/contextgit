# ContextGit — Delta Spec: Thread Lifecycle & Save-Rhythm Enforcement

**Date:** 2026-05-25
**Status:** Ready for implementation — folds into 0.2.0 before first publish
**Target version:** 0.2.1 (ships as the single 0.2.x release; 0.2.0 is not published)
**Scope:** `packages/core` (threads, save-rhythm strings), `packages/store` (archive table + migration), `packages/cli` (init-helpers)

---

## Why this spec exists

A Claude Code audit of the built (un-published) `0.2.0` confirmed the core loop
works — load is useful, the activity log and open-question surfacing are the
high-leverage parts, context survives session boundaries. But it found three
defects that should be fixed *before* the first npm publish, not after:

1. **Thread graveyard.** 17 live + 108 stale threads. Decay filters them from the
   default load (that part works) but nothing ever clears them. Filtering hides the
   graveyard; it does not empty it.
2. **Close friction.** Closing a thread needs an ID that the load does not surface
   cleanly, so threads are never closed by hand — they just accumulate. This is the
   same root cause flagged in the very first audit ("felt like friction").
3. **Save rhythm is wrong in `02`.** `02` said git owns "what changed," so stop
   saving per-commit. A follow-up audit disproved this: the save is *bound* to its
   commit, and that binding is the value. Saving only 3x per session leaves
   intermediate commits with empty bindings — blind history. The rule must change.

This is a patch, not a redesign. Three scoped fixes.

---

## Fix 1 — prune stale threads (archive, not hard-delete)

`02` added staleness *detection*. It never added staleness *disposal*. This adds it.

- New `thread_archive` table, same columns as `threads` plus `archivedAt` and
  `archivedReason` (`'stale-age' | 'stale-distance' | 'watch-expired' | 'manual'`).
- A thread that crosses a staleness threshold is **moved** to `thread_archive`, not
  left in `threads`. Archived rows never appear in any load.
- Archive is **recoverable, not destructive.** No hard `DELETE`. A
  `project_memory_threads --restore <id>` path moves a row back. The tool must not
  rely on the user having a DB backup.
- A one-time migration sweep on first `0.2.1` run: every currently-stale thread
  (the ~108) is moved to `thread_archive` with the appropriate `archivedReason`.
  After the sweep the default load shows only live threads, no `+108 stale` hint.
- Ongoing archival runs as a sweep inside every `project_memory_save` — archival is
  a write, so it rides the write path. `project_memory_load` stays a pure read with
  no side effects. (The one-time migration sweep above is separate and runs once.)
- `watch` notes that expire are archived with reason `watch-expired` (previously
  they "dropped silently" per `02` — make that an explicit archive so nothing is
  truly lost).

The `+N stale` hint line stays for *newly* stale threads between saves, but the
standing 108-deep backlog is gone after first run.

---

## Fix 2 — make closing a thread ergonomic

Closing must be a one-step action with information the agent already has in front
of it. Two changes:

- **Surface a short thread handle in the load.** Each thread in `project_memory_load`
  output gets a visible short ID — an exact 6-char prefix of the thread id. Fixed
  length, deterministic: the handle shown is exactly the handle typed. The audit's
  exact complaint: IDs "aren't surfaced cleanly." Fix: surface them.
- **Close by handle or by subject.** `project_memory_threads --close <handle>` and
  `project_memory_threads --close-subject "<text>"` (normalized match, same
  normalization as dedupe-on-save). Closing moves the thread to `thread_archive`
  with reason `manual`. If a 6-char handle ever collides with two thread ids,
  `--close` errors and lists both — never archives an arbitrary one.
- **Save-time close.** `project_memory_save` accepts `closesThreads: string[]`
  (handles or subjects) so a session-end save can close the threads it resolved in
  one call. Resolution is handle-first: try as a 6-char handle, then fall back to
  normalized subject; if **neither** matches, error loudly — never no-op silently.
  This is the path that actually gets used — closing rides along with the save the
  agent is already making.

---

## Fix 3 — correct the save-rhythm rule (commit-binding model)

**`02` got the save rhythm wrong.** It said: git owns "what changed," so stop
saving per-commit — save ~3x per session instead. A usage audit disproved this. The
correct model:

**A save is bound to a commit. The binding is the primary value.** Every git commit
is a snapshot of code; every save bound to that commit is a snapshot of *intent* at
that commit. Together they let any future puller — a teammate, or you in three
weeks — materialize "the world at commit X": both what was on disk and what was in
the head of whoever shipped it. If a save only exists every 3rd commit, the
intermediate commits have empty bindings and that history is blind forever.

So the rule is **save per commit** — but the save *body* is not a paraphrase of the
diff. The body carries what the diff cannot show: the decision behind the change,
the approach abandoned, the open question the commit raises. The commit pairing is
the binding key; the body is what makes the binding worth pulling. Both jobs, one
save.

This **supersedes** `02`'s save-rhythm section and the "3 saves per session" rule.
`02` is corrected to match.

Implementation — the save-rhythm strings in `init-helpers.ts`:

- `CLAUDE_MD_FRAGMENT`, `CONTEXT_COMMIT_SKILL`, `CONTEXTGIT_HOOKS`. Remove **both**
  the original "every git commit = context commit, do not batch" *and* `02`'s
  "save only 3x per session" text. Neither is right.
- The replacement rule: save once per commit; the save body states the decision /
  abandoned approach / open question, not a restatement of the diff. `replan:`
  prefix when an approach is abandoned — that is the one thing git cannot
  reconstruct and the save is its only persistence layer.
- Negative/positive example for the strings:

  > Bad save: "Implemented apiFetch wrapper" — paraphrases the commit; git has it.
  > Good save: "apiFetch wrapper — chose X-User-Id header over cookie auth because
  > the extension can't share the host session cookie. Open: needs 401 handling."

- No new mechanism. Content fix to existing strings. `init` regenerates them.

---

## Data model changes

`packages/store`:

- New `thread_archive` table — mirrors `threads`, adds `archived_at`,
  `archived_reason`. Migration v8.
- No change to `threads` schema. Archival is a row move between tables.

`packages/core/src/types.ts`:

- New `ArchivedThread` interface (`Thread` + `archivedAt`, `archivedReason`).
- `project_memory_save` input gains optional `closesThreads: string[]`.

---

## Tools

- `project_memory_threads` — gains `--close <handle>`, `--close-subject <text>`,
  `--restore <id>`, and `--archived` (list archived threads). Existing `--stale`
  filter stays for newly-stale-since-sweep.
- `project_memory_save` — gains `closesThreads`; runs the ongoing archival sweep.
  Surface otherwise unchanged.
- `project_memory_load` — output now shows a 6-char handle per thread. Pure read,
  no side effects. No parameter change.

---

## NOT in this spec

- **Multi-agent claim system — untouched.** It is inert for solo use but it is the
  coordination primitive for the parked team layer — in a multi-agent setup the
  thread index is a work queue, not a graveyard. Removing it to re-add later is
  wasted work. Left as-is.
- **No auto-close on commit reference.** Still deferred (was `02` decay mechanism 3).
  Fix 2 makes *manual* close cheap; automatic close stays post-launch.
- **No new tier, no retrieval changes.** `02`'s trace tier and windowing ship as-is.

---

## Validation gate

`0.2.1` is complete when, on a fresh Claude Code session against the built package:

1. First run executes the one-time sweep — the ~108 stale threads move to
   `thread_archive`; the default load shows only live threads, no large `+N stale`
   hint.
2. `project_memory_load` shows a 6-char handle next to each live thread and performs
   no writes.
3. Closing a thread by handle, by subject, and via `closesThreads` on a save all
   work and move the thread to `thread_archive`.
4. `--restore` brings an archived thread back.
5. The save-rhythm strings in a freshly `init`-ed project state save-per-commit with
   the binding model and the bad/good example; both the old "do not batch" rule and
   `02`'s "3 saves per session" rule are absent.
6. Archived threads never appear in a normal load; ongoing archival happens on save.

Then publish — once — as `0.2.1`. Pinned versions, dependency order
core → store → api → mcp → cli, restore `workspace:*`. Then clean-install and
re-audit: the graveyard complaint and the close-friction complaint should be gone.
