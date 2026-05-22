# Changelog

## 0.1.10 — 2026-05-22

### Bug fixes

**`@CLAUDE.contextgit.md` include now wired automatically**
On projects with a pre-existing `CLAUDE.md`, every `project_memory_save` was writing context to `CLAUDE.contextgit.md` but never linking it into `CLAUDE.md`. The next session had no way to load it — saves were write-only. Fixed: `project_memory_save` now prepends `@CLAUDE.contextgit.md` to your `CLAUDE.md` automatically on first run (idempotent). No manual step required.

**Save-rhythm guidance corrected**
The `context-commit` skill and `CLAUDE.md` fragment previously instructed the agent to call `project_memory_save` after every git commit. This produced noise — most saves just paraphrased the commit message. Fixed: the guidance now says to save at session end (always) and mid-session only when something git doesn't capture happens — a decision made, an approach abandoned, scope changed. The `PostToolUse` hook that fired on every `git commit` is removed. The `SessionStart` hook (mandatory `project_memory_load`) remains.

Note: the corrected guidance applies to new installs and re-inits. Existing installs keep their current hooks until `contextgit init` is re-run.

---

## 0.1.9 — 2026-04-10

### Bug fixes

**Snapshot deduplication**
Open threads were appearing twice in the `agents-md` snapshot format. Fixed by deduplicating on thread `id` before rendering.

**SessionStart hook replaces UserPromptSubmit**
The Claude Code hook that triggers `project_memory_load` now fires on `SessionStart` (once per session) instead of `UserPromptSubmit` (every message). Quieter, correct.

**`@CLAUDE.contextgit.md` import guidance**
When a project has a manually-maintained `CLAUDE.md`, `init` now tells you to add `@CLAUDE.contextgit.md` as the first line (Claude Code's import directive) rather than renaming your file.
