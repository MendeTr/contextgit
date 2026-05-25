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
3. **Saves still duplicate git.** Third independent witness (GCC ablation, audit 1,
   this audit) that saves paraphrase commit messages. `02`'s save-rhythm rewrite was
   meant to fix this; the audit says saves are still doing it — so the rewrite did
   not fully land in the enforcement strings, or the strings are not being followed.

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
- `watch` notes that expire are archived with reason `watch-expired` (previously
  they "dropped silently" per `02` — make that an explicit archive so nothing is
  truly lost).

The `+N stale` hint line stays for *newly* stale threads between sweeps, but the
standing 108-deep backlog is gone after first run.

---

## Fix 2 — make closing a thread ergonomic

Closing must be a one-step action with information the agent already has in front
of it. Two changes:

- **Surface a short thread handle in the load.** Each thread in `project_memory_load`
  output gets a visible short ID (first 6 chars of the thread id is enough). The
  audit's exact complaint: IDs "aren't surfaced cleanly." Fix: surface them.
- **Close by handle or by subject.** `project_memory_threads --close <handle>` and
  `project_memory_threads --close-subject "<text>"` (normalized match, same
  normalization as dedupe-on-save). Closing moves the thread to `thread_archive`
  with reason `manual`.
- **Save-time close.** `project_memory_save` accepts `closesThreads: string[]`
  (handles or subjects) so a session-end save can close the threads it resolved in
  one call, instead of a separate step. This is the path that actually gets used —
  closing should ride along with the save the agent is already making.

---

## Fix 3 — verify the save-rhythm strings actually changed

The audit says saves still paraphrase git. Before adding anything, **confirm `02`'s
save-rhythm rewrite is actually present in the built strings:**

- Check `CLAUDE_MD_FRAGMENT`, `CONTEXT_COMMIT_SKILL`, and `CONTEXTGIT_HOOKS` in
  `init-helpers.ts`. Confirm the old "every git commit = context commit" text is
  gone and the `02` replacement text is present. If `02` was specced but the strings
  were not actually edited, that is the bug — fix it here.
- If the strings *are* correct, the problem is guidance-not-followed. Strengthen one
  point: the save-rhythm text gains an explicit negative example —

  > Bad save: "Implemented apiFetch wrapper" — this paraphrases the commit message;
  > git already has it. Good save: "Chose X-User-Id header over cookie auth because
  > the extension can't share Loqally's session cookie" — the decision, not the diff.

- No new mechanism. This is a content fix to existing strings. `init` regenerates
  them; the user re-runs `contextgit init` or the strings update on next version.

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
- `project_memory_save` — gains `closesThreads`. Surface unchanged otherwise.
- `project_memory_load` — output now shows a short handle per thread. No parameter
  change.

---

## NOT in this spec

- **Multi-agent claim system — untouched.** The audit called it dead weight for
  solo use. It is inert, not broken, and it is deliberate groundwork for the parked
  team layer. Removing it to re-add later is wasted work. Left as-is.
- **No auto-close on commit reference.** Still deferred (was `02` decay mechanism 3).
  Fix 2 makes *manual* close cheap; automatic close stays post-launch.
- **No new tier, no retrieval changes.** `02`'s trace tier and windowing ship as-is.

---

## Validation gate

`0.2.1` is complete when, on a fresh Claude Code session against the built package:

1. First run executes the sweep — the ~108 stale threads move to `thread_archive`;
   the default load shows only live threads, no large `+N stale` hint.
2. `project_memory_load` shows a short handle next to each live thread.
3. Closing a thread by handle, by subject, and via `closesThreads` on a save all
   work and move the thread to `thread_archive`.
4. `--restore` brings an archived thread back.
5. The save-rhythm strings in a freshly `init`-ed project contain the `02`
   replacement text plus the negative example; the old per-commit rule is absent.
6. Archived threads never appear in a normal load.

Then publish — once — as `0.2.1`. Pinned versions, dependency order
core → store → api → mcp → cli, restore `workspace:*`. Then clean-install and
re-audit: the graveyard complaint and the close-friction complaint should be gone.
