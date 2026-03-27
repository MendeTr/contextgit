# TODOS

## TODO: Cold-start install validation

**What:** Manually test `npm pack && npm install -g` on the CLI package from a clean environment. Verify `contextgit-mcp` is in PATH and resolvable after install.

**Why:** The DLG plan explicitly says "the install experience is not validated." This is the most important DLG prerequisite — before posting anywhere, confirm a cold-start works.

**Pros:** Catches silent install failures before they affect real users. Validates the bundleDependencies fix.

**Cons:** Manual step; requires a clean npm environment or Docker.

**Context:** On macOS with npm v7+: `npm pack && npm install -g ./contextgit-*.tgz` in a temp dir. Then verify: `which contextgit-mcp` resolves, `contextgit init` produces `✅ MCP server registered`, and Claude Code sees the tools after restart.

**Depends on:** bundleDependencies fix (Issue 1) shipped first.

---

## TODO: Cursor compatibility check

**What:** Test the MCP server against Cursor (and optionally Windsurf) to confirm `project_memory_load` / `project_memory_save` work outside Claude Code.

**Why:** Design doc says "test MCP server against Cursor in week 1." If compatible: include in distribution posts — 2x the potential install base. If incompatible: post anyway with "Claude Code only" and schedule Cursor support.

**Pros:** Expands the addressable audience immediately if compatible. Clears the "Claude Code only" ambiguity.

**Cons:** Cursor's MCP config is different from Claude Code's. Manual test; can't automate easily.

**Context:** Cursor supports stdio MCP transport as of early 2025. Test: add `contextgit-mcp` to Cursor's `mcp.json`, open a project with a context DB, call `project_memory_load` in a Cursor agent session. Windsurf uses the same MCP protocol.

**Depends on:** Cold-start install validation done first.

---

## TODO: GitHub Actions npm publish on version bump (after 50 installs)

**What:** Add a GitHub Actions workflow that auto-publishes all 5 packages to npm when a version tag is pushed.

**Why:** Manual publish is error-prone. Design doc deferred this to "after 50 installs" — capture it now so it's ready when the milestone hits.

**Pros:** Removes the manual publish step; publish failures during high-engagement moments become automated recoveries.

**Cons:** Monorepo publish requires careful ordering: core → store → mcp, cli, api. Needs an npm token secret in GitHub Actions.

**Context:** Use `pnpm -r publish --access public` with `--filter` for ordering. Or use `changesets` for version management. The 5 packages are: `@contextgit/core`, `@contextgit/store`, `@contextgit/mcp`, `contextgit` (cli), `@contextgit/api`.

**Depends on:** 50 real installs milestone.
