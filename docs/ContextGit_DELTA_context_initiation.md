# ContextGit — Delta: Context Initiation Ritual

**Type:** Delta spec — standalone feature  
**Status:** Ready to build  
**Date:** 2026-04-09  
**Scope:** MCP tool descriptions + agent behavior on empty context. No new CLI commands. No new packages.

---

## What This Delta Solves

ContextGit has a cold start problem. When a user installs ContextGit on an existing project and their AI calls `context_get` for the first time, it gets back nothing. The tool designed to solve session amnesia starts with amnesia.

This is especially painful for **brownfield projects** — codebases with months or years of history, decisions, and context scattered across docs, code, git history, and the developer's head. The AI has no idea what the project is, why it exists, what's been tried, or what patterns to follow.

Even on **greenfield projects**, the first session is when foundational decisions happen. If nobody writes a good initial context commit, the tool never builds momentum. Users try ContextGit, see an empty response, don't know what to write, and drop off.

**The fix:** When context is empty, the MCP tool guides the AI agent through a structured initiation ritual. The agent gathers context from multiple sources, synthesizes it, presents a draft to the human for review, and writes a rich first context commit. No new CLI commands — the intelligence lives in the MCP tool description and the agent does the work in Claude Code (or any AI coding tool).

---

## Design Principles

- **The agent drives the ritual, the human validates.** The AI does the heavy lifting of reading, scanning, and synthesizing. The human reviews and corrects. This is critical — the AI will get things wrong on a brownfield project, and the human correcting it is itself valuable context.
- **Docs before code.** The order of context gathering matters. Intent documents (specs, PRDs, architecture) explain the *why*. Code explains the *what*. Git history explains the *when*. The AI should understand intent before implementation.
- **No new commands.** The ritual is triggered by the MCP tool response when context is empty. The agent runs it inside Claude Code (or Cursor, or any MCP-compatible tool). Terminal wizards are rigid — a conversational AI can ask follow-up questions, understand nuance, and adapt.
- **Works for all project types.** Brownfield with extensive docs, brownfield with no docs, greenfield just starting — the ritual adapts based on what's available.
- **CLAUDE.md as a build artifact.** Every `context_commit` generates/updates a CLAUDE.md file from the latest context snapshot. CLAUDE.md is never manually maintained — it's a derived output. This gives ContextGit compatibility with vanilla Claude Code, Cursor, and Anthropic's official CLAUDE.md management plugin, while the structured database remains the source of truth.

---

## The Ritual — Context Gathering Hierarchy

When the AI detects an empty context (first `context_get` returns no commits), it follows this priority order:

### Priority 1: Intent Documents

The highest-value context. These explain why the project exists and what it's supposed to do.

**What to look for:**
- Specs, PRDs, requirements documents
- Architecture docs, design documents
- Decision logs (ADRs)
- User-provided files ("here, read this")

**How the agent finds them:**
- Ask the user: "Do you have any specs, PRDs, or architecture documents? Point me to them — files in the repo, local paths, or paste the content."
- Check common locations: `/docs`, `/documentation`, `/specs`, `/architecture`, root-level markdown files
- Look for references in README (links to wikis, external docs, Google Docs)

### Priority 2: Project Structure

Tells the AI how the project is organized and what tools it uses.

**What to scan (automatically, no user input needed):**
- `README.md` — project description, setup instructions
- `package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` — dependencies, scripts, project metadata
- Folder structure (2 levels deep) — module organization
- Config files — `.env.example`, `tsconfig.json`, `docker-compose.yml`, CI configs
- Monorepo structure if applicable — workspace config, package relationships

### Priority 3: Codebase Patterns

Tells the AI how things are actually built, which may differ from the docs.

**What to analyze:**
- Key entry points (main files, index files, route definitions)
- Naming conventions and code style
- Architecture patterns in practice (MVC, service layer, etc.)
- Test structure and patterns
- Error handling patterns

### Priority 4: Git History

Tells the AI where momentum is and what changed recently.

**What to read:**
- Last 20-50 commit messages — recent activity and focus areas
- Most frequently changed files — active development areas
- Branch structure — what's in progress
- Contributors — who works on what

---

## Agent Behavior Specification

### When `context_get` returns empty

The MCP tool response includes the initiation prompt. The agent then runs the ritual conversationally inside the coding tool (Claude Code, Cursor, etc.).

### The conversation flow

```
Agent calls context_get → empty response with initiation instructions

Agent: "This is a fresh ContextGit setup — I don't have any project 
context yet. Let me build a solid foundation so I can be useful from 
the start.

Do you have any specs, architecture docs, PRDs, or design documents 
for this project? They can be files in the repo, local paths, or 
you can paste the content."

--- User provides docs (or says "no docs") ---

Agent reads provided documents, extracts:
  - Project purpose and goals
  - Key architectural decisions
  - Technology choices and rationale
  - Constraints and requirements
  - Current status and roadmap

Agent: "Got it. Now let me scan the codebase to see how things 
are actually structured..."

--- Agent reads project structure, configs, key files ---

Agent: "And let me check the recent git history..."

--- Agent reads recent commits ---

Agent: "Here's what I understand about this project:

[Draft context summary — structured, comprehensive]

What did I get wrong? What's missing? What would you correct?"

--- Human reviews and corrects ---

Agent incorporates corrections, writes context_commit:
  "context initiation: [rich structured summary incorporating 
   all gathered context, reviewed and validated by developer]"
```

### Adapting to project type

**Brownfield with docs:** Full ritual. Docs first, then code scan confirms or contradicts the docs. Agent flags discrepancies: "The architecture doc says you're using REST, but I see GraphQL schema files. Which is current?"

**Brownfield without docs:** Skip Priority 1, lean heavily on Priority 2-4. Agent extracts as much as possible from code and git history, then asks targeted questions: "I can see this is a Next.js app with Stripe integration. What's the core business logic? What are the main user flows?"

**Greenfield (near-empty repo):** Mostly conversational. Agent asks: "What are you building? What tech stack have you chosen? What are the key decisions you've already made?" Turns answers into structured first commit.

---

## MCP Tool Description Changes

### `context_get` — empty state response

When `context_get` returns no commits for the current project, the response text should include:

```
No project context found. This is a fresh ContextGit setup.

Run the context initiation ritual:

1. Ask the user for specs, PRDs, architecture docs, or design documents. 
   These are the highest-value context. Check /docs, /documentation, /specs 
   and root-level markdown files. Ask the user directly — they may have 
   documents outside the repo.

2. Scan the project structure: README, package.json/Cargo.toml/pyproject.toml, 
   folder structure (2 levels), config files, monorepo workspace config.

3. Analyze codebase patterns: entry points, naming conventions, architecture 
   patterns, test structure, error handling.

4. Read recent git history: last 20-50 commit messages, active branches, 
   most changed files.

5. Synthesize everything into a structured project summary. Present it to 
   the user for review. Ask what you got wrong and what's missing.

6. After the user validates, write a context_commit with the reviewed summary. 
   This is the foundation all future context builds on — make it thorough.

7. Generate a CLAUDE.md file in the project root from the same content. 
   This ensures compatibility with vanilla Claude Code and any tool that 
   reads CLAUDE.md. The file is auto-generated — add a comment at the top:
   "# Auto-generated by ContextGit. Do not edit manually — changes will be 
   overwritten on next context_commit."

Do steps 1-4 before showing the summary. Do not skip the human review in step 5.
```

### `context_commit` — first commit guidance

The MCP tool description for `context_commit` should note:

```
If this is the first context commit for the project (context initiation), 
structure the message as a comprehensive project summary:

- Project: name, purpose, current status
- Architecture: tech stack, key patterns, module structure
- Decisions: major technical decisions and their rationale
- Conventions: naming, code style, testing approach
- Current state: what's working, what's in progress, what's planned
- Open threads: unresolved questions, known issues, pending decisions
```

---

## What the First Commit Looks Like

After the ritual, the first `context_commit` should produce something like:

```
context initiation: Loqally — AI-powered brand workspace for real estate marketing

## Project
Loqally is a SaaS platform where real estate marketing teams create 
property ads, presentations, and branded content using AI. Users upload 
brand guidelines and templates, and the AI generates content that follows 
their brand rules. Built for agencies managing multiple property listings.

## Architecture  
Next.js 14 app with TypeScript. Supabase for auth and database. 
Vercel deployment. Monorepo with packages for core, UI components, 
and AI integrations.

## Key Decisions
- PPT generation uses python-pptx via API route (not client-side)
- Brand rules stored as structured JSON, not free text
- AI learns from user corrections ("don't use this font" → remembered)
- Template system: users upload .pptx templates, AI fills them

## Conventions
- File naming: kebab-case for files, PascalCase for components
- API routes under /api/v1/
- All AI prompts in /lib/prompts/ directory
- Tests co-located with source files

## Current State
- PPT generator working with template preview
- Chat-based fine-tuning not started
- Brand portal MVP complete
- Auth and user management done

## Open Threads
- Template parsing occasionally misaligns text boxes
- Need to decide on image generation provider (DALL-E vs Midjourney API)
- Performance optimization for large template files not started
```

This single commit gives any AI agent — or any new contributor — enough context to start working immediately.

---

## Implementation

All changes are in existing files. No new packages or commands.

### Step 1 — Update `context_get` empty state response

**File:** `packages/mcp/src/server.ts`

When the snapshot contains zero commits, append the initiation ritual instructions to the response text. The instructions are the agent's guide — they tell it what to do inside Claude Code.

### Step 2 — Update `context_commit` tool description

**File:** `packages/mcp/src/server.ts`

Add guidance for first-commit structure to the tool description. This helps the agent write a well-structured initiation commit even if it doesn't follow the full ritual.

### Step 3 — Add `isInitiated` flag to snapshot

**File:** `packages/core/src/types.ts` + `packages/store/src/local/index.ts`

Add `isInitiated: boolean` to `SessionSnapshot`. `true` when the project has at least one commit. The MCP server uses this to decide whether to include the ritual instructions.

### Step 4 — CLAUDE.md generation on every `context_commit`

**File:** `packages/mcp/src/server.ts` (or a new utility in `packages/core/src/claude-md-generator.ts`)

After every successful `context_commit`, generate a CLAUDE.md file in the project root from the current context snapshot.

**CLAUDE.md structure:**

```markdown
<!-- Auto-generated by ContextGit. Do not edit manually — changes will be overwritten on next context_commit. -->
<!-- Source of truth: .contextgit/ database. Use ContextGit MCP tools to update. -->
<!-- Last updated: {timestamp} -->

# {Project Name}

## Project Overview
{from project summary}

## Architecture
{tech stack, key patterns, module structure}

## Key Decisions
{major technical decisions and rationale}

## Conventions
{naming, code style, testing approach}

## Current State
{what's working, in progress, planned}

## Open Threads
{unresolved questions, known issues}

## Build & Run
{commands, setup instructions — extracted from README/package.json}
```

**Behavior:**
- If CLAUDE.md already exists and was NOT generated by ContextGit (no auto-generated comment at top), do NOT overwrite. Instead, generate as `CLAUDE.contextgit.md` and warn the user.
- If CLAUDE.md exists and IS auto-generated, overwrite it.
- If no CLAUDE.md exists, create it.
- The generation reads the latest snapshot and formats it as markdown — the content is always derived from the context database, never maintained separately.

### Step 5 — Add CLAUDE.md to .gitignore guidance

During `contextgit init`, suggest adding `CLAUDE.md` to `.gitignore` if the user wants the generated file to stay local. Alternatively, committing it to git means every contributor gets the latest context summary even without ContextGit installed — this is the recommended approach.

---

## What Does NOT Change

- No new CLI commands. The ritual runs inside the AI coding tool.
- No new MCP tools. Existing `context_get` and `context_commit` are sufficient.
- No automated codebase scanning built into ContextGit. The AI agent does the scanning using its own file-reading capabilities.
- No forced structure for the first commit. The guidance is in the tool description — the agent and user decide the final content together.
- Solo and team workflows are unaffected for projects that already have context.

---

## Validation Criteria

1. Fresh `contextgit init` on a brownfield project → `context_get` → agent receives initiation instructions
2. Agent asks for docs, scans codebase, reads git history without user prompting each step
3. Agent presents a structured summary for human review
4. Human corrections are incorporated into the final commit
5. Second `context_get` call returns the rich initiation context — no more ritual instructions
6. A different AI agent opening the same project gets the full context immediately
7. CLAUDE.md is generated in the project root after the first `context_commit`
8. Subsequent `context_commit` calls update CLAUDE.md automatically
9. Existing manually-created CLAUDE.md is not overwritten — `CLAUDE.contextgit.md` is created instead with a warning

---

## Future Enhancements

- **`contextgit seed` CLI command** — for users who want to run the initiation outside of an AI coding tool, a guided terminal flow that asks questions and writes the first commit
- **Auto-detect document locations** — scan for common doc patterns (wiki links in README, `/docs` folder, ADR directories) and suggest them to the agent
- **Template first commits** — pre-built templates for common project types (Next.js app, API service, monorepo, CLI tool) that the agent can use as a starting structure
- **Re-initiation** — ability to re-run the ritual when a project has significantly changed and the existing context is stale
- **CLAUDE.md customization** — let users configure which sections appear in the generated CLAUDE.md and in what order
- **Compatibility with Anthropic's claude-md-management plugin** — detect if the plugin is installed and coordinate updates so neither tool overwrites the other's changes
