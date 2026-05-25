# Formatter + Init Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three independent bugs: snapshot formatter duplication, incorrect hooks format in init, and misleading CLAUDE.md warning message.

**Architecture:** Three independent changes across three files — each can be committed separately. No new files needed. All have existing tests to update.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo

---

## File Map

| File | Change |
|------|--------|
| `packages/core/src/snapshot.ts` | Remove duplicate `## Current Branch` section from `agents-md`; deduplicate threads |
| `packages/core/src/snapshot.test.ts` | Update tests to match new section structure; add deduplication test |
| `packages/cli/src/lib/init-helpers.ts` | Replace `UserPromptSubmit` with `SessionStart`; replace jq shell script with native `if` condition |
| `packages/cli/src/lib/init-helpers.test.ts` | Update assertions for `SessionStart` and `if` field |
| `packages/core/src/claude-md-generator.ts` | Change warning to `@CLAUDE.contextgit.md` instruction |
| `packages/core/src/claude-md-generator.test.ts` | Update assertion to match new warning text |

---

## Task 1: Fix SnapshotFormatter — remove duplicate section and deduplicate threads

**Files:**
- Modify: `packages/core/src/snapshot.ts`
- Modify: `packages/core/src/snapshot.test.ts`

### Context

The `agents-md` format currently renders both `## Project State` (with `projectSummary`) and `## Current Branch: <name>` (with `branchSummary`). In practice both fields hold the same text, causing the snapshot to repeat everything twice. Additionally, `openThreads` can contain duplicate entries by the time they reach the formatter.

The fix: remove the `## Current Branch` section from `agents-md` entirely. Deduplicate threads by `id` before rendering. Reorder sections to: Project State → Open Threads → Recent Activity → Active Claims.

- [ ] **Step 1: Write failing tests for the new format**

Open `packages/core/src/snapshot.test.ts`. Add these test cases inside the existing `describe` block:

```typescript
it('agents-md does not contain ## Current Branch section', () => {
  const snapshot = makeSnapshot({ branchSummary: 'branch summary' })
  const out = formatter.format(snapshot, 'agents-md')
  expect(out).not.toContain('## Current Branch')
})

it('agents-md contains ## Project State before ## Open Threads', () => {
  const snapshot = makeSnapshot({
    openThreads: [
      {
        id: 't1',
        projectId: 'p',
        branchId: 'b',
        description: 'thread one',
        status: 'open',
        openedInCommit: 'c1',
        createdAt: new Date(),
      },
    ],
  })
  const out = formatter.format(snapshot, 'agents-md')
  expect(out.indexOf('## Project State')).toBeLessThan(out.indexOf('## Open Threads'))
})

it('agents-md deduplicates open threads by id', () => {
  const thread = {
    id: 'dup-1',
    projectId: 'p',
    branchId: 'b',
    description: 'duplicated thread',
    status: 'open' as const,
    openedInCommit: 'c1',
    createdAt: new Date(),
  }
  const snapshot = makeSnapshot({ openThreads: [thread, thread] })
  const out = formatter.format(snapshot, 'agents-md')
  const count = (out.match(/duplicated thread/g) ?? []).length
  expect(count).toBe(1)
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/core test -- --reporter=verbose 2>&1 | grep -A3 'Current Branch\|deduplicat\|Project State before'
```

Expected: 3 new tests fail (`## Current Branch` present, section order wrong or dedup not done).

- [ ] **Step 3: Update the formatter**

Replace the `agents-md` branch in `packages/core/src/snapshot.ts` (lines 23–58) with:

```typescript
if (fmt === 'agents-md') {
  const uniqueThreads = [...new Map(openThreads.map((t) => [t.id, t])).values()]
  const commits = recentCommits
    .map(
      (c) =>
        `- [${c.createdAt.toISOString()}] "${c.message}" by ${c.agentRole} via ${c.tool} (${c.workflowType})`,
    )
    .join('\n')
  const threads = uniqueThreads
    .map(
      (t) =>
        `- ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
    )
    .join('\n')
  return [
    `## Project State`,
    projectSummary || '(no summary yet)',
    ``,
    `## Open Threads`,
    threads || '(none)',
    ``,
    `## Recent Activity`,
    commits || '(no commits yet)',
    ``,
    `## Active Claims`,
    activeClaims.length
      ? activeClaims
          .map(
            (cl) =>
              `- [CLAIMED by ${cl.agentId}] ${cl.task} (claimed ${cl.claimedAt.toISOString()})`,
          )
          .join('\n')
      : '(none)',
  ].join('\n')
}
```

- [ ] **Step 4: Run the full core test suite**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/core test
```

Expected: all tests pass (including the 3 new ones). If `## Current Branch` appears in any existing test assertion, update that assertion to not expect it.

- [ ] **Step 5: Commit**

```bash
cd /Users/mendetrajovski/contexthub
git add packages/core/src/snapshot.ts packages/core/src/snapshot.test.ts
git commit -m "fix(core): remove duplicate Current Branch section from agents-md; deduplicate threads"
```

---

## Task 2: Fix hooks format in init-helpers — SessionStart + native if condition

**Files:**
- Modify: `packages/cli/src/lib/init-helpers.ts`
- Modify: `packages/cli/src/lib/init-helpers.test.ts`

### Context

`CONTEXTGIT_HOOKS` currently uses:
1. `UserPromptSubmit` — fires on every user message. Should be `SessionStart` (fires once per session).
2. PostToolUse uses a shell script with `jq -r` + `grep` to detect `git commit`. Claude Code supports a native `if` field (`"if": "Bash(git commit*)"`) that's cleaner and doesn't run jq on every bash command.

- [ ] **Step 1: Write failing tests for the new hook format**

Open `packages/cli/src/lib/init-helpers.test.ts`. The `patchClaudeSettings` describe block has three tests. Rewrite the first two assertions:

```typescript
it('creates .claude/settings.json with both hooks when file does not exist', () => {
  const result = patchClaudeSettings(tmpDir)
  expect(result.status).toBe('patched')
  const settingsPath = join(tmpDir, '.claude', 'settings.json')
  expect(existsSync(settingsPath)).toBe(true)
  const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  // SessionStart (not UserPromptSubmit)
  expect(json.hooks.SessionStart).toHaveLength(1)
  expect(json.hooks.SessionStart[0].hooks[0].command).toContain('project_memory_load')
  // PostToolUse with native if condition
  expect(json.hooks.PostToolUse).toHaveLength(1)
  expect(json.hooks.PostToolUse[0].matcher).toBe('Bash')
  expect(json.hooks.PostToolUse[0].if).toBe('Bash(git commit*)')
  expect(json.hooks.PostToolUse[0].hooks[0].command).toContain('project_memory_save')
  // No UserPromptSubmit
  expect(json.hooks.UserPromptSubmit).toBeUndefined()
})

it('merges hooks into existing settings.json without overwriting other keys', () => {
  const settingsPath = join(tmpDir, '.claude', 'settings.json')
  require('fs').mkdirSync(join(tmpDir, '.claude'), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }, null, 2))
  patchClaudeSettings(tmpDir)
  const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  expect(json.permissions.allow).toContain('Bash(git:*)')
  expect(json.hooks.SessionStart).toBeDefined()
  expect(json.hooks.PostToolUse).toBeDefined()
})

it('is idempotent — returns already-present on second call', () => {
  patchClaudeSettings(tmpDir)
  const result = patchClaudeSettings(tmpDir)
  expect(result.status).toBe('already-present')
  const json = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
  // hooks not duplicated
  expect(json.hooks.SessionStart).toHaveLength(1)
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/cli test -- --reporter=verbose 2>&1 | grep -A5 'patchClaudeSettings'
```

Expected: all 3 `patchClaudeSettings` tests fail (hooks use UserPromptSubmit, no `if` field).

- [ ] **Step 3: Update CONTEXTGIT_HOOKS and patchClaudeSettings in init-helpers.ts**

In `packages/cli/src/lib/init-helpers.ts`, replace lines 237–261 (the `CONTEXTGIT_HOOKS` constant) with:

```typescript
const CONTEXTGIT_HOOKS = {
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command:
            `printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"MANDATORY: Call project_memory_load before doing any work. Do not read files, write code, or answer questions until you have called project_memory_load and read the snapshot."}}'`,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Bash',
      if: 'Bash(git commit*)',
      hooks: [
        {
          type: 'command',
          command:
            `printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"MANDATORY: Call project_memory_save NOW before proceeding to any next task. Every git commit must be paired with project_memory_save immediately after."}}'`,
        },
      ],
    },
  ],
}
```

Then in `patchClaudeSettings` (lines 279–281), update the hook keys from `UserPromptSubmit`/`PostToolUse` to `SessionStart`/`PostToolUse`:

```typescript
const hooks = (json['hooks'] as Record<string, unknown[]> | undefined) ?? {}
hooks['SessionStart'] = [...(hooks['SessionStart'] ?? []), ...CONTEXTGIT_HOOKS.SessionStart]
hooks['PostToolUse'] = [...(hooks['PostToolUse'] ?? []), ...CONTEXTGIT_HOOKS.PostToolUse]
json['hooks'] = hooks
```

- [ ] **Step 4: Run the full cli test suite**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/cli test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/mendetrajovski/contexthub
git add packages/cli/src/lib/init-helpers.ts packages/cli/src/lib/init-helpers.test.ts
git commit -m "fix(cli): use SessionStart hook and native if condition for PostToolUse in contextgit init"
```

---

## Task 3: Fix ClaudeMdGenerator warning message

**Files:**
- Modify: `packages/core/src/claude-md-generator.ts`
- Modify: `packages/core/src/claude-md-generator.test.ts`

### Context

When `CLAUDE.md` exists and was not generated by ContextGit, the generator writes to `CLAUDE.contextgit.md` and returns a warning. The current warning says "rename CLAUDE.contextgit.md to CLAUDE.md" — but the correct workflow is to import it via `@CLAUDE.contextgit.md` on the first line of the existing CLAUDE.md. This keeps the user's CLAUDE.md intact and still loads the auto-generated context.

- [ ] **Step 1: Write failing test for new warning text**

In `packages/core/src/claude-md-generator.test.ts`, update the assertion in the "writes CLAUDE.contextgit.md when CLAUDE.md exists and was NOT auto-generated" test:

```typescript
it('writes CLAUDE.contextgit.md when CLAUDE.md exists and was NOT auto-generated', async () => {
  writeFileSync(join(tmpDir, 'CLAUDE.md'), '# My manually written CLAUDE.md\nDo not overwrite.')

  const result = await generator.write(tmpDir, {
    projectName: 'My Project',
    content: 'Generated content.',
    timestamp: new Date('2026-04-09T10:00:00Z'),
  })
  expect(result.file).toBe('CLAUDE.contextgit.md')
  expect(result.warning).toBeDefined()
  expect(result.warning).toContain('@CLAUDE.contextgit.md')
  // Original CLAUDE.md untouched
  expect(readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('Do not overwrite.')
  // New file created
  expect(existsSync(join(tmpDir, 'CLAUDE.contextgit.md'))).toBe(true)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/core test -- --reporter=verbose 2>&1 | grep -A5 'NOT auto-generated'
```

Expected: test fails because warning contains "rename" not "@CLAUDE.contextgit.md".

- [ ] **Step 3: Update the warning in claude-md-generator.ts**

In `packages/core/src/claude-md-generator.ts`, replace lines 51–54:

```typescript
writeFileSync(contextgitMdPath, generated, 'utf-8')
const warning =
  `CLAUDE.md already exists and was not generated by ContextGit. ` +
  `Context written to CLAUDE.contextgit.md instead. ` +
  `Add '@CLAUDE.contextgit.md' as the first line of your CLAUDE.md for auto-synced project context.`
return { file: 'CLAUDE.contextgit.md', warning }
```

- [ ] **Step 4: Run the full core test suite**

```bash
cd /Users/mendetrajovski/contexthub
pnpm --filter @contextgit/core test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/mendetrajovski/contexthub
git add packages/core/src/claude-md-generator.ts packages/core/src/claude-md-generator.test.ts
git commit -m "fix(core): update CLAUDE.contextgit.md warning to instruct @-import instead of rename"
```

---

## Final: Full test suite + project_memory_save

- [ ] **Run full test suite**

```bash
cd /Users/mendetrajovski/contexthub
pnpm test
```

Expected: all tests pass (was 122 before; new tests bring the total higher).

- [ ] **Call project_memory_save** with summary of all 3 fixes.
