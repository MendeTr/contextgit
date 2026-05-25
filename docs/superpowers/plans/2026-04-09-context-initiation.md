# Context Initiation Ritual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Solve ContextGit's cold start problem by guiding AI agents through a context-gathering ritual when `project_memory_load` returns an empty project, and generating a CLAUDE.md file after every `project_memory_save`.

**Architecture:** Add an `isInitiated` boolean to `SessionSnapshot` (computed in the store layer from whether the branch has any commits). When `false`, the MCP server appends ritual instructions to the `project_memory_load` response text. A new `ClaudeMdGenerator` in `@contextgit/core` writes/updates CLAUDE.md in the project root after every successful `project_memory_save`.

**Tech Stack:** TypeScript, better-sqlite3 (sync), Vitest, Node.js `fs` module (for CLAUDE.md file writes), `@modelcontextprotocol/sdk`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/types.ts` | Modify | Add `isInitiated: boolean` to `SessionSnapshot` |
| `packages/core/src/snapshot.test.ts` | Modify | Update `makeSnapshot` helper to include `isInitiated` |
| `packages/store/src/local/queries.ts` | Modify | Compute `isInitiated` in `getSessionSnapshot` |
| `packages/store/src/local/local-store.test.ts` | Modify | Test `isInitiated` is `false` / `true` correctly |
| `packages/core/src/claude-md-generator.ts` | Create | Generate + write CLAUDE.md from commit content |
| `packages/core/src/claude-md-generator.test.ts` | Create | Unit tests for generator logic and file write behavior |
| `packages/core/src/index.ts` | Modify | Export `ClaudeMdGenerator` |
| `packages/mcp/src/server.ts` | Modify | (1) Inject ritual when `!snapshot.isInitiated`; (2) Update `project_memory_save` description; (3) Call generator after commit |

---

## Task 1: Add `isInitiated` to `SessionSnapshot` type

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/snapshot.test.ts`

- [ ] **Step 1: Add `isInitiated` to the interface**

In `packages/core/src/types.ts`, update `SessionSnapshot`:

```typescript
export interface SessionSnapshot {
  projectSummary: string       // max 2000 tokens
  branchName: string
  branchSummary: string        // max 500 tokens
  recentCommits: Commit[]      // last 3
  openThreads: Thread[]
  activeClaims: Claim[]        // non-released, non-TTL-expired claims
  isInitiated: boolean         // true when the project has at least one commit
}
```

- [ ] **Step 2: Update `makeSnapshot` helper in snapshot.test.ts**

`makeSnapshot` creates a `SessionSnapshot`. Add `isInitiated: true` as the default (existing tests describe an already-initiated project):

```typescript
function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    projectSummary: 'project summary',
    branchName: 'main',
    branchSummary: 'branch summary',
    recentCommits: [],
    openThreads: [],
    activeClaims: [],
    isInitiated: true,
    ...overrides,
  }
}
```

- [ ] **Step 3: Run tests to verify nothing is broken**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test
```

Expected: all tests pass (TypeScript will error at compile time if callers of `SessionSnapshot` are missing the new field — but `makeSnapshot` now covers the test file).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/snapshot.test.ts
git commit -m "feat(core): add isInitiated boolean to SessionSnapshot"
```

---

## Task 2: Compute `isInitiated` in the store query

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Modify: `packages/store/src/local/local-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/store/src/local/local-store.test.ts`, add a new describe block after the existing `getSessionSnapshot` test:

```typescript
it('getSessionSnapshot sets isInitiated=false when branch has no commits', async () => {
  const project = await store.createProject({ name: 'p' })
  const branch = await store.createBranch({
    projectId: project.id,
    name: 'main',
    gitBranch: 'main',
  })

  const snapshot = await store.getSessionSnapshot(project.id, branch.id)
  expect(snapshot.isInitiated).toBe(false)
})

it('getSessionSnapshot sets isInitiated=true after a commit exists', async () => {
  const project = await store.createProject({ name: 'p' })
  const branch = await store.createBranch({
    projectId: project.id,
    name: 'main',
    gitBranch: 'main',
  })
  await store.upsertAgent({
    id: 'agent-init',
    projectId: project.id,
    role: 'solo',
    tool: 'claude-code',
    workflowType: 'interactive',
  })
  await store.createCommit({
    branchId: branch.id,
    agentId: 'agent-init',
    agentRole: 'solo',
    tool: 'claude-code',
    workflowType: 'interactive',
    message: 'context initiation: My Project',
    content: 'Initial context captured.',
    summary: 'Initial context captured.',
    commitType: 'manual',
  })

  const snapshot = await store.getSessionSnapshot(project.id, branch.id)
  expect(snapshot.isInitiated).toBe(true)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test -- packages/store/src/local/local-store.test.ts
```

Expected: FAIL — TypeScript error or runtime error because `isInitiated` is not yet set in the returned object.

- [ ] **Step 3: Implement `isInitiated` in `getSessionSnapshot`**

In `packages/store/src/local/queries.ts`, update `getSessionSnapshot` to compute `isInitiated`. Add it just before the `return` statement:

```typescript
getSessionSnapshot(projectId: string, branchId: string, options?: { agentRole?: string }): SessionSnapshot {
  // ... (existing code unchanged until the return) ...

  // Last 3 commits on current branch (optionally filtered by agent role)
  const recentCommits = options?.agentRole
    ? (this.stmts.selectCommitsByRole.all(branchId, options.agentRole, 3) as CommitRow[]).map(toCommit)
    : this.listCommits(branchId, { limit: 3, offset: 0 })

  // Check if the branch has been initiated (any commit exists, regardless of role filter)
  const allCommits = this.listCommits(branchId, { limit: 1, offset: 0 })
  const isInitiated = allCommits.length > 0

  // All open threads for the project
  const openThreads = this.listOpenThreads(projectId)

  const activeClaims = this.listActiveClaims(projectId)

  return {
    projectSummary,
    branchName: branch?.name ?? '',
    branchSummary,
    recentCommits,
    openThreads,
    activeClaims,
    isInitiated,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test -- packages/store/src/local/local-store.test.ts
```

Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/local-store.test.ts
git commit -m "feat(store): compute isInitiated in getSessionSnapshot"
```

---

## Task 3: Inject initiation ritual into `project_memory_load` response

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Locate `handleProjectMemoryLoad` in server.ts**

The handler is at line ~137. It already does:
```typescript
const snapshot = await ctx.store.getSessionSnapshot(...)
const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
return { content: [{ type: 'text', text }] }
```

`snapshot.isInitiated` is now available before the `format()` call.

- [ ] **Step 2: Add the ritual text constant above the handler**

Add this constant near the top of the `createServer` function body (before `handleProjectMemoryLoad`):

```typescript
const INITIATION_RITUAL = `
---
## ContextGit: Fresh Setup Detected

No project context found. This is a fresh ContextGit setup. Run the context initiation ritual before doing any other work:

1. Ask the user for specs, PRDs, architecture docs, or design documents.
   These are the highest-value context. Check /docs, /documentation, /specs,
   and root-level markdown files. Ask the user directly — they may have
   documents outside the repo.

2. Scan the project structure automatically (no user input needed):
   README, package.json / Cargo.toml / pyproject.toml / go.mod, folder
   structure (2 levels deep), config files (.env.example, tsconfig.json,
   docker-compose.yml, CI configs), monorepo workspace config.

3. Analyze codebase patterns: entry points, naming conventions, architecture
   patterns in practice, test structure, error handling patterns.

4. Read recent git history: last 20-50 commit messages, active branches,
   most frequently changed files.

5. Synthesize everything into a structured project summary. Present it to
   the user for review. Ask: "What did I get wrong? What's missing?"

6. After the user validates, write a project_memory_save with the reviewed
   summary. Structure it as:
   - Project: name, purpose, current status
   - Architecture: tech stack, key patterns, module structure
   - Decisions: major technical decisions and rationale
   - Conventions: naming, code style, testing approach
   - Current state: what's working, what's in progress, what's planned
   - Open threads: unresolved questions, known issues, pending decisions

   This is the foundation all future context builds on — make it thorough.

7. A CLAUDE.md file will be auto-generated in the project root after you
   call project_memory_save. It gives context to any tool that reads CLAUDE.md.

Do steps 1-4 before showing the summary. Do not skip the human review in step 5.
---`
```

- [ ] **Step 3: Append ritual text when `!snapshot.isInitiated`**

Update `handleProjectMemoryLoad` to append the ritual when not initiated. Find the line that builds `text` and the return:

```typescript
      const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
      return {
        content: [{ type: 'text' as const, text }],
      }
```

Replace with:

```typescript
      const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
      const output = snapshot.isInitiated ? text : text + INITIATION_RITUAL
      return {
        content: [{ type: 'text' as const, text: output }],
      }
```

- [ ] **Step 4: Build to catch TypeScript errors**

```bash
cd /Users/mendetrajovski/contexthub && pnpm build
```

Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): inject context initiation ritual when snapshot is empty"
```

---

## Task 4: Update `project_memory_save` tool description for first-commit guidance

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Locate the `project_memory_save` tool registration**

It is at line ~275 in server.ts. The current description is:

```typescript
server.tool(
  'project_memory_save',
  `Save project memory after completing work.
...`,
  projectMemorySaveSchema,
  handleProjectMemorySave,
)
```

- [ ] **Step 2: Replace the description**

```typescript
server.tool(
  'project_memory_save',
  `Save project memory after completing work.

IMPORTANT: Call this tool BEFORE ending your session or moving to the next task. This saves what you did, what you decided, and what questions remain — so the next session (or the next agent) can pick up where you left off.

If you skip this call, the next session starts blind. Your work will be invisible to future agents. They will re-do what you already did.

Call after: completing a feature, making an architectural decision, resolving a bug, closing a thread, or finishing any meaningful unit of work. Small decisions compound — save them.

FIRST COMMIT (context initiation): If this is the first context commit for the project, structure the content as a comprehensive project summary with these sections:
- Project: name, purpose, current status
- Architecture: tech stack, key patterns, module structure
- Decisions: major technical decisions and their rationale
- Conventions: naming, code style, testing approach
- Current state: what's working, what's in progress, what's planned
- Open threads: unresolved questions, known issues, pending decisions

A CLAUDE.md file will be auto-generated in the project root from this content.`,
  projectMemorySaveSchema,
  handleProjectMemorySave,
)
```

- [ ] **Step 3: Build to catch TypeScript errors**

```bash
cd /Users/mendetrajovski/contexthub && pnpm build
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): add first-commit structure guidance to project_memory_save description"
```

---

## Task 5: Create `ClaudeMdGenerator`

**Files:**
- Create: `packages/core/src/claude-md-generator.ts`
- Create: `packages/core/src/claude-md-generator.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing tests first**

Create `packages/core/src/claude-md-generator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeMdGenerator } from './claude-md-generator.js'

describe('ClaudeMdGenerator', () => {
  let tmpDir: string
  let generator: ClaudeMdGenerator

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-md-test-'))
    generator = new ClaudeMdGenerator()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('generate()', () => {
    it('produces a string with the auto-generated header comment', () => {
      const result = generator.generate({
        projectName: 'My Project',
        content: '## Architecture\nNext.js app.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result).toContain('Auto-generated by ContextGit')
      expect(result).toContain('Do not edit manually')
    })

    it('includes the content in the output', () => {
      const result = generator.generate({
        projectName: 'My Project',
        content: '## Architecture\nNext.js app.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result).toContain('## Architecture')
      expect(result).toContain('Next.js app.')
    })

    it('includes the project name', () => {
      const result = generator.generate({
        projectName: 'Loqally',
        content: 'Some content.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result).toContain('Loqally')
    })
  })

  describe('write()', () => {
    it('creates CLAUDE.md when it does not exist', async () => {
      const result = await generator.write(tmpDir, {
        projectName: 'My Project',
        content: '## Architecture\nNext.js.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result.file).toBe('CLAUDE.md')
      expect(result.warning).toBeUndefined()
      expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true)
    })

    it('overwrites CLAUDE.md if it was auto-generated by ContextGit', async () => {
      const autoGenContent = '<!-- Auto-generated by ContextGit. Do not edit manually -->\nOld content.'
      writeFileSync(join(tmpDir, 'CLAUDE.md'), autoGenContent)

      const result = await generator.write(tmpDir, {
        projectName: 'My Project',
        content: 'New content.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result.file).toBe('CLAUDE.md')
      expect(result.warning).toBeUndefined()
      const written = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8')
      expect(written).toContain('New content.')
      expect(written).not.toContain('Old content.')
    })

    it('writes CLAUDE.contextgit.md when CLAUDE.md exists and was NOT auto-generated', async () => {
      writeFileSync(join(tmpDir, 'CLAUDE.md'), '# My manually written CLAUDE.md\nDo not overwrite.')

      const result = await generator.write(tmpDir, {
        projectName: 'My Project',
        content: 'Generated content.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result.file).toBe('CLAUDE.contextgit.md')
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('CLAUDE.contextgit.md')
      // Original CLAUDE.md untouched
      expect(readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('Do not overwrite.')
      // New file created
      expect(existsSync(join(tmpDir, 'CLAUDE.contextgit.md'))).toBe(true)
    })

    it('updates CLAUDE.contextgit.md if it already exists from a previous run', async () => {
      writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Manual CLAUDE.md')
      writeFileSync(join(tmpDir, 'CLAUDE.contextgit.md'), '<!-- Auto-generated by ContextGit. Do not edit manually -->\nOld generated.')

      const result = await generator.write(tmpDir, {
        projectName: 'My Project',
        content: 'Latest generated content.',
        timestamp: new Date('2026-04-09T10:00:00Z'),
      })
      expect(result.file).toBe('CLAUDE.contextgit.md')
      const written = readFileSync(join(tmpDir, 'CLAUDE.contextgit.md'), 'utf-8')
      expect(written).toContain('Latest generated content.')
    })
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test -- packages/core/src/claude-md-generator.test.ts
```

Expected: FAIL — `ClaudeMdGenerator` does not exist yet.

- [ ] **Step 3: Implement `ClaudeMdGenerator`**

Create `packages/core/src/claude-md-generator.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const AUTO_GEN_MARKER = '<!-- Auto-generated by ContextGit. Do not edit manually'

interface GenerateOptions {
  projectName: string
  content: string
  timestamp: Date
}

interface WriteResult {
  file: 'CLAUDE.md' | 'CLAUDE.contextgit.md'
  warning?: string
}

export class ClaudeMdGenerator {
  generate(opts: GenerateOptions): string {
    const { projectName, content, timestamp } = opts
    return [
      `<!-- Auto-generated by ContextGit. Do not edit manually — changes will be overwritten on next project_memory_save. -->`,
      `<!-- Source of truth: .contextgit/ database. Use ContextGit MCP tools to update. -->`,
      `<!-- Last updated: ${timestamp.toISOString()} -->`,
      ``,
      `# ${projectName}`,
      ``,
      content,
    ].join('\n')
  }

  async write(projectRoot: string, opts: GenerateOptions): Promise<WriteResult> {
    const claudeMdPath = join(projectRoot, 'CLAUDE.md')
    const contextgitMdPath = join(projectRoot, 'CLAUDE.contextgit.md')
    const generated = this.generate(opts)

    // CLAUDE.md does not exist — create it
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, generated, 'utf-8')
      return { file: 'CLAUDE.md' }
    }

    // CLAUDE.md exists — check if it was auto-generated by ContextGit
    const existing = readFileSync(claudeMdPath, 'utf-8')
    if (existing.startsWith(AUTO_GEN_MARKER)) {
      writeFileSync(claudeMdPath, generated, 'utf-8')
      return { file: 'CLAUDE.md' }
    }

    // CLAUDE.md is manually maintained — write to CLAUDE.contextgit.md instead
    writeFileSync(contextgitMdPath, generated, 'utf-8')
    const warning =
      `CLAUDE.md already exists and was not generated by ContextGit. ` +
      `Context written to CLAUDE.contextgit.md instead. ` +
      `To use ContextGit's auto-generated context, rename CLAUDE.contextgit.md to CLAUDE.md.`
    return { file: 'CLAUDE.contextgit.md', warning }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test -- packages/core/src/claude-md-generator.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Export from `packages/core/src/index.ts`**

Add the export:

```typescript
export * from './types.js'
export * from './summarizer.js'
export * from './snapshot.js'
export * from './threads.js'
export * from './engine.js'
export * from './embeddings.js'
export * from './claude-md-generator.js'
```

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/claude-md-generator.ts packages/core/src/claude-md-generator.test.ts packages/core/src/index.ts
git commit -m "feat(core): add ClaudeMdGenerator — writes CLAUDE.md from commit content"
```

---

## Task 6: Integrate CLAUDE.md generation into `project_memory_save`

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Import `ClaudeMdGenerator` in server.ts**

Add to the existing import from `@contextgit/core`:

```typescript
import { ContextEngine, EmbeddingService, SnapshotFormatter, ClaudeMdGenerator } from '@contextgit/core'
```

- [ ] **Step 2: Instantiate the generator in `createServer`**

Add this line near the top of `createServer`, alongside `autoSnapshot`:

```typescript
const claudeMdGen = new ClaudeMdGenerator()
```

- [ ] **Step 3: Call the generator after a successful commit**

In `handleProjectMemorySave`, find the success return block:

```typescript
      return {
        content: [
          {
            type: 'text' as const,
            text: `Commit recorded.\nID: ${commit.id}\nMessage: ${commit.message}`,
          },
        ],
      }
```

Replace with:

```typescript
      // Generate/update CLAUDE.md in the project root
      let claudeMdNote = ''
      try {
        const result = await claudeMdGen.write(process.cwd(), {
          projectName: ctx.config.project,
          content: commit.content,
          timestamp: commit.createdAt,
        })
        claudeMdNote = result.warning
          ? `\n\nWarning: ${result.warning}`
          : `\nCLAUDE.md updated (${result.file}).`
      } catch {
        // Non-fatal — CLAUDE.md generation failure does not fail the commit
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Commit recorded.\nID: ${commit.id}\nMessage: ${commit.message}${claudeMdNote}`,
          },
        ],
      }
```

- [ ] **Step 4: Build to catch TypeScript errors**

```bash
cd /Users/mendetrajovski/contexthub && pnpm build
```

Expected: builds without errors.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/mendetrajovski/contexthub && pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): generate CLAUDE.md after every project_memory_save"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Covered by |
|---|---|
| Empty `context_get` → initiation ritual in response | Task 3 |
| Agent asks for docs, scans codebase, reads git history | Task 3 (ritual text instructs the agent) |
| Agent presents summary for human review | Task 3 (ritual text step 5) |
| Second `context_get` returns rich context, no ritual | Task 2 (`isInitiated=true` after first commit) |
| CLAUDE.md generated after first `context_commit` | Tasks 5+6 |
| Subsequent `context_commit` updates CLAUDE.md | Task 6 (called on every save) |
| Existing manual CLAUDE.md not overwritten → `CLAUDE.contextgit.md` | Task 5 |
| `context_commit` first-commit structure guidance in tool description | Task 4 |
| `isInitiated` flag on snapshot | Tasks 1+2 |

### Notes

- **Step 5 gitignore guidance** from the spec ("suggest adding CLAUDE.md to .gitignore during contextgit init") is out of scope for this plan — it requires changes to the CLI init command, which is a separate file. It is a recommendation in the delta spec's "Step 5" but is marked as "suggestion" and does not affect the core feature. Can be done as a follow-up.
- The `context_commit` deprecated alias also benefits from the updated `project_memory_save` description (users reading the old tool still get the first-commit note indirectly since the handler is shared). The alias description already says "DEPRECATED: Use project_memory_save instead" — no update needed there.
- CLAUDE.md generation is non-fatal: an `fs` error (permissions, read-only filesystem) will not fail the commit. This matches the spec's principle "Never fail a COMMIT due to summarizer — graceful fallback always."
