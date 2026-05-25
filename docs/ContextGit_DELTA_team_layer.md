# ContextGit — Delta: Team Collaboration Layer

**Type:** Delta spec — changes and additions on top of PRD v4, Architecture v3, and Phase 2 Plan  
**Status:** Ready to build  
**Date:** 2026-04-09  
**Scope:** Multi-user team collaboration via Supabase. Contributors join a project, get full context, coordinate work through AI agents.

---

## What This Delta Solves

ContextGit v0.1.x is a solo developer tool. Context lives in a local SQLite database and travels with the repository. This works — but only for one person.

**The scenario this delta enables:**

A repo owner has been building a project with ContextGit for weeks. A contributor clones the repo, runs `contextgit join`, and their AI agent immediately understands the full project: architecture decisions, what's been tried, what failed, current patterns, and what needs to be done next. No onboarding doc. No "read the wiki." No two-hour ramp-up.

The owner's AI and contributor's AI coordinate through Supabase — structured task lifecycle messages, freeform questions, and context proposals that work like PRs for project memory.

**Three problems this delta solves:**

1. **Session amnesia for teams** — contributors start from zero every time. Even if they read the code, they don't know the decisions behind it.
2. **Task coordination across agents** — who's working on what, what's available, what's done.
3. **Context integrity** — contributors can read everything but can't corrupt the shared context without review.

---

## Design Principles

- **Build for vibe coders first, architect so human-first mode works later.** The default flow assumes AI agents are the primary actors. Nothing in the design prevents a human-driven workflow.
- **ContextGit is a context layer, not a PM tool.** Tasks live wherever the owner already tracks them (GitHub Issues, TASKS.md, conversation). ContextGit enriches them with context and coordinates execution.
- **Human sets direction, AI executes.** AI does not invent roadmap items. Owner creates tasks or points at existing sources. AI structures and attaches context.
- **Git mental model for context.** Contributors don't write directly to shared context. They propose changes (like a PR). Owner's AI reviews and merges.

---

## Infrastructure: User-Hosted Supabase

The owner creates and hosts their own Supabase project. ContextGit does not host any infrastructure.

**Why:** Zero cost for ContextGit as a product. Data ownership stays with the owner. Supabase free tier is generous. Developers can create a Supabase project in 2 minutes.

**Setup flow:**

```
Owner runs: contextgit init --team
  → Prompted for Supabase URL + anon key + service role key
  → Credentials stored locally in .contextgit/config.json
  → ContextGit connects to Supabase and runs migrations
  → Tables created, RLS policies applied
  → Owner registered as first member with role: owner
  → Done. Ready to invite contributors.
```

**Contributor setup:**

```
Contributor clones repo
Contributor runs: contextgit join <invite-link>
  → Opens Supabase Auth signup (email or GitHub OAuth)
  → Creates membership request in members table (status: pending)
  → Owner is notified (via messages table)
  → Owner approves
  → Contributor's AI now has live read access to all shared context
  → Done.
```

---

## Authentication: Supabase Auth + RLS

All access is authenticated through Supabase Auth. Row Level Security enforces access control at the database level.

**Why Supabase Auth instead of custom tokens:** RLS policies use `auth.uid()` natively. Rolling our own auth means reinventing what Supabase already provides, and RLS won't work properly without it.

**Auth flow for CLI/MCP:**

1. `contextgit join` triggers Supabase Auth signup/login (opens browser for OAuth or prompts for email/password)
2. Supabase returns a JWT + refresh token
3. Tokens stored locally in `.contextgit/auth.json` (gitignored)
4. All Supabase client calls include the JWT
5. RLS policies validate `auth.uid()` against the `members` table

**Supported auth methods:**
- Email + password (default)
- GitHub OAuth (natural fit for developers)

---

## Supabase Schema

Four tables. Not five — the task_board is a lightweight cache of GitHub Issues, not a standalone PM system.

### `projects`

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  repo_url TEXT,
  owner_id UUID NOT NULL REFERENCES auth.users(id),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: members can read their projects, owner can write
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read their projects"
  ON projects FOR SELECT
  USING (
    id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );

CREATE POLICY "Owner can update project"
  ON projects FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "Authenticated users can create projects"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = owner_id);
```

### `members`

```sql
CREATE TABLE members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('owner', 'contributor')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  UNIQUE(project_id, user_id)
);

ALTER TABLE members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read their own project memberships"
  ON members FOR SELECT
  USING (
    project_id IN (SELECT project_id FROM members m WHERE m.user_id = auth.uid() AND m.status = 'approved')
    OR user_id = auth.uid()
  );

CREATE POLICY "Anyone authenticated can request membership"
  ON members FOR INSERT
  WITH CHECK (auth.uid() = user_id AND status = 'pending');

CREATE POLICY "Owner can approve/revoke members"
  ON members FOR UPDATE
  USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );
```

### `context_proposals`

```sql
CREATE TABLE context_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id),
  commit_content TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_note TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

ALTER TABLE context_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read proposals for their projects"
  ON context_proposals FOR SELECT
  USING (
    project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );

CREATE POLICY "Contributors can create proposals"
  ON context_proposals FOR INSERT
  WITH CHECK (
    auth.uid() = author_id
    AND project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );

CREATE POLICY "Owner can review proposals"
  ON context_proposals FOR UPDATE
  USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );
```

### `messages`

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  type TEXT NOT NULL CHECK (type IN (
    'task_available', 'task_claimed', 'task_in_progress', 'task_done',
    'question', 'update', 'review_request', 'proposal_submitted',
    'member_joined', 'member_approved'
  )),
  content TEXT NOT NULL,
  reference_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- reference_id is a polymorphic pointer:
--   for task messages: GitHub Issue URL or number
--   for proposal messages: context_proposals.id
--   for member messages: members.id

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read messages for their projects"
  ON messages FOR SELECT
  USING (
    project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );

CREATE POLICY "Members can send messages"
  ON messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    AND project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );
```

### `task_cache` (not a task board)

```sql
CREATE TABLE task_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('github', 'manual')),
  source_id TEXT,
  title TEXT NOT NULL,
  context_summary TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('proposed', 'available', 'claimed', 'in_progress', 'done')),
  assigned_to UUID REFERENCES auth.users(id),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  github_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- source_id: GitHub Issue number when source = 'github'
-- context_summary: AI-generated enrichment with project context
-- github_url: direct link to the issue for reference

ALTER TABLE task_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read tasks for their projects"
  ON task_cache FOR SELECT
  USING (
    project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );

CREATE POLICY "Members can create and update tasks"
  ON task_cache FOR ALL
  USING (
    project_id IN (SELECT project_id FROM members WHERE user_id = auth.uid() AND status = 'approved')
  );
```

---

## Context Sharing Model

**Opt-out by default.** All project context is shared with approved contributors. Owner can mark specific context commits as private.

**How it works:**

1. Owner's local SQLite context syncs to Supabase continuously (push on every `context_commit`)
2. Approved contributors pull shared context into their local SQLite DB
3. Contributors work locally, writing context to their own DB as they go
4. When done, contributor's AI creates a `context_proposal` — a context commit that hasn't been merged
5. Owner's AI reviews the proposal: does it make sense? Does it conflict with existing decisions?
6. If approved, the proposal content is merged into shared context
7. If rejected, reviewer_note explains why

**Privacy mechanism:**

- Commits in the local DB have an optional `private: boolean` flag (default: false)
- Private commits are excluded from Supabase sync
- `contextgit init --team` displays a clear warning: "All project context will be visible to approved contributors. Use `contextgit commit --private` to exclude sensitive context."
- Future enhancement: auto-detect sensitive patterns (API keys, credentials, pricing) and prompt before sharing

**What gets shared:**
- Architecture decisions
- What was tried and failed
- Coding patterns and conventions
- Current state and open threads
- Task context and coordination messages

**What stays private (owner marks explicitly):**
- Client names and business details
- API keys and credentials discussed in context
- Internal pricing or strategy discussions

---

## Task Flow

ContextGit does not manage tasks. It enriches them with context and coordinates execution.

### Task creation — two modes

**Mode C: Owner creates tasks conversationally**

```
Owner tells AI: "I need the payment integration built. Use Stripe, 
follow the patterns we established for the auth module."

Owner's AI:
  → Structures the task with a title and description
  → Enriches with relevant context (auth module patterns, architecture decisions)
  → Writes to task_cache (source: 'manual')
  → Posts 'task_available' message to messages table
  → Optionally creates a GitHub Issue with the enriched description
```

**Mode B: Owner points at existing source**

```
Owner tells AI: "Sync my open GitHub Issues for this repo"

Owner's AI:
  → Reads open issues via GitHub API
  → For each issue, generates a context_summary using project context
  → Writes to task_cache (source: 'github', source_id: issue number, github_url: issue link)
  → Posts 'task_available' messages for new issues
```

### Task lifecycle

```
proposed → available → claimed → in_progress → done

proposed:    contributor suggested this (like opening a GitHub Issue)
available:   owner approved, ready for someone to pick up
claimed:     an agent has claimed it
in_progress: work is underway
done:        work complete, context proposal submitted
```

Status changes are recorded as messages for full audit trail.

### Contributor proposes a task

```
Contributor tells AI: "I think we need a caching layer for API responses"

Contributor's AI:
  → Creates task in task_cache (status: 'proposed')
  → Enriches the proposal with project context (because it has full context)
  → Posts 'proposal_submitted' message
  → Owner's AI reviews: "Your contributor proposed X. Here's their reasoning 
    and how it fits the current architecture."
  → Owner approves → status flips to 'available'
```

---

## Agent Messaging

Hybrid model: structured messages for task lifecycle, freeform for conversation.

### Structured message types

| Type | Trigger | Content |
|------|---------|---------|
| `task_available` | New task ready | Task title + context summary |
| `task_claimed` | Agent picks up task | Task ID + agent info |
| `task_in_progress` | Work begins | Progress notes |
| `task_done` | Work complete | Summary + proposal reference |
| `review_request` | Context proposal submitted | Proposal ID + summary |
| `member_joined` | New member request | User info |
| `member_approved` | Owner approves member | Confirmation |

### Freeform messages

| Type | Use case |
|------|----------|
| `question` | Contributor's AI asks clarifying question about a task or architecture |
| `update` | Status update, progress note, heads-up about a refactor |

### Agent-to-agent flow

```
Contributor's AI posts: question — "The auth module uses JWT RS256, 
  but the Stripe webhook handler seems to expect HMAC. Is this intentional?"

Owner's AI reads the question, checks project context, responds:
  update — "Yes, intentional. Stripe webhooks use their own HMAC 
  verification. Don't wrap them in our JWT middleware. See commit 
  ctx_abc123 for the decision."
```

The AI is the integration layer. Messages are in Supabase. Both agents can read/write through the MCP tools.

---

## GitHub Integration

GitHub first. GitLab and Bitbucket later when someone asks.

### What ContextGit does with GitHub

- **Reads** open issues to populate task_cache
- **Enriches** each issue with project context (context_summary field)
- **Syncs** status changes bidirectionally (issue closed on GitHub → task_cache updated, task done in ContextGit → issue closed on GitHub)
- **Creates** issues when owner makes tasks conversationally and wants them tracked on GitHub

### What ContextGit does NOT do

- Replace GitHub Issues as the source of truth
- Add labels, milestones, or project board management
- Manage GitHub permissions or access

### Authentication

GitHub Personal Access Token stored in `.contextgit/config.json`. The owner provides it during `contextgit init --team` setup.

### For non-GitHub users

Everything works without GitHub. Tasks are created conversationally (Mode C) and written directly to task_cache. The only difference is no automatic sync with an external issue tracker.

---

## New CLI Commands

### `contextgit init --team`

```
contextgit init --team
  → Prompt: Supabase URL
  → Prompt: Supabase anon key
  → Prompt: Supabase service role key (for migrations)
  → Prompt: GitHub PAT (optional, for issue sync)
  → Run Supabase migrations (create tables, apply RLS)
  → Register owner in members table
  → Store credentials in .contextgit/config.json
  → Print: "Team mode enabled. Run 'contextgit invite' to add contributors."
```

### `contextgit invite`

```
contextgit invite
  → Generates an invite link containing: project_id + Supabase URL
  → Link format: contextgit://join/<project_id>?url=<supabase_url>
  → Print: "Share this link with contributors:
    contextgit join <link>"
```

### `contextgit join <invite-link>`

```
contextgit join <invite-link>
  → Parse project_id and Supabase URL from link
  → Open browser for Supabase Auth (signup/login)
  → Store auth tokens locally
  → Create membership request (status: pending)
  → Post 'member_joined' message
  → Print: "Membership requested. Waiting for owner approval."
  → After approval: pull shared context into local SQLite DB
```

### `contextgit members`

```
contextgit members
  → List all members of current project
  → Show: name, role, status, last active

contextgit members approve <user-id>
  → Approve a pending membership request
  → Post 'member_approved' message

contextgit members revoke <user-id>
  → Revoke a contributor's access
```

### `contextgit propose`

```
contextgit propose -m "Added caching layer decisions"
  → Create context_proposal from current local context changes
  → Post 'review_request' message
  → Print: "Context proposal submitted for review."
```

### `contextgit review`

```
contextgit review
  → List pending context proposals

contextgit review approve <proposal-id>
  → Merge proposal content into shared context
  → Update proposal status to 'approved'

contextgit review reject <proposal-id> -m "reason"
  → Update proposal status to 'rejected'
  → Store reviewer_note
```

### `contextgit tasks`

```
contextgit tasks
  → List tasks from task_cache with status and assignment

contextgit tasks sync
  → Sync open GitHub Issues into task_cache with context enrichment
```

---

## New MCP Tools

### `context_team_status`

```typescript
{
  name: 'context_team_status',
  description: 'Get team status: members, pending proposals, available tasks, recent messages.',
  inputSchema: {
    project_id: z.string()
  }
}
```

### `context_propose`

```typescript
{
  name: 'context_propose',
  description: 'Submit a context proposal for owner review. Use after completing work to share context changes.',
  inputSchema: {
    project_id: z.string(),
    message: z.string(),
    content: z.string()
  }
}
```

### `context_message`

```typescript
{
  name: 'context_message',
  description: 'Send a message to the team. Use for questions, updates, or status changes.',
  inputSchema: {
    project_id: z.string(),
    type: z.enum(['question', 'update', 'task_claimed', 'task_in_progress', 'task_done']),
    content: z.string(),
    reference_id: z.string().optional()
  }
}
```

### `context_tasks`

```typescript
{
  name: 'context_tasks',
  description: 'List available tasks with context summaries. Claim a task before starting work.',
  inputSchema: {
    project_id: z.string(),
    status: z.enum(['available', 'claimed', 'in_progress', 'done']).optional()
  }
}
```

---

## Migration Strategy

All Supabase tables are created during `contextgit init --team` using the service role key (which bypasses RLS). Migrations are versioned and tracked in a `_team_migrations` table in Supabase.

```sql
CREATE TABLE _team_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

This is separate from the local SQLite migration system. Local migrations handle `LocalStore` schema. Team migrations handle Supabase schema.

---

## What Does NOT Change

- Local SQLite remains the primary store for all ContextGit operations
- Solo developer workflow is unchanged — `contextgit init` without `--team` works exactly as before
- The existing MCP tools (`context_get`, `context_commit`, `context_claim`) work locally as before
- The multi-agent orchestration protocol (Delta: Multi-Agent) is orthogonal to the team layer — both can be used independently or together
- Push/pull to a self-hosted REST API is a separate sync mechanism from the Supabase team layer

---

## Build Order

1. **Supabase migration system** — `_team_migrations` table, versioned migration runner
2. **Schema** — projects, members, messages, context_proposals, task_cache tables with RLS
3. **Auth flow** — Supabase Auth integration in CLI (login, signup, token storage)
4. **`contextgit init --team`** — setup wizard, run migrations, register owner
5. **`contextgit invite` + `contextgit join`** — invite link generation, membership request flow
6. **`contextgit members`** — list, approve, revoke
7. **Context sync to Supabase** — push shared context on every `context_commit`, pull on `context_get` for contributors
8. **`contextgit propose` + `contextgit review`** — context proposal flow
9. **Messages** — MCP tool `context_message`, CLI `contextgit messages`
10. **Task cache + GitHub sync** — `contextgit tasks`, `contextgit tasks sync`, MCP tool `context_tasks`
11. **MCP tools** — `context_team_status`, `context_propose`, `context_message`, `context_tasks`

Each step is independently testable and shippable. Steps 1–6 are the minimum for "contributor joins and gets context." Steps 7–8 add the review gate. Steps 9–11 add coordination.

---

## Validation Criteria

The team layer is working when:

1. Owner runs `contextgit init --team` → Supabase tables created with RLS
2. Owner runs `contextgit invite` → generates invite link
3. Contributor runs `contextgit join <link>` → signs up, membership pending
4. Owner runs `contextgit members approve <id>` → contributor approved
5. Contributor's AI calls `context_get` → receives full shared project context
6. Contributor works, their AI calls `context_commit` locally
7. Contributor's AI calls `context_propose` → proposal appears for owner
8. Owner's AI reviews and approves → shared context updated
9. No context written to Supabase without owner approval (except owner's own commits)
10. RLS prevents any unauthenticated or unauthorized access

---

## Open Items for Future Deltas

- **Supabase Realtime subscriptions** — live push notifications instead of polling for new messages/proposals
- **GitLab / Bitbucket integration** — when users request it
- **Web dashboard** — visual view of team activity, proposals, task board
- **Context diffing** — sophisticated visual diff for context proposals (not needed for MVP — reviewer reads the proposal text)
- **Multiple owners / admin role** — currently single owner per project
- **Auto-flag sensitive content** — detect API keys, credentials in context before sharing
