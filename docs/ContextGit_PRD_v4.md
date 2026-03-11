# ContextGit
### The Memory Layer for AI Agent Workflows

---

**Version 4.0 | March 2026**
**Status: Draft for Co-founder Review**
**Classification: Confidential**

---

## The Problem

Every AI coding agent today suffers from amnesia. When you start a new session with Claude Code, Cursor, Codex, or any other AI coding tool, the agent knows nothing about your project, your conventions, your past decisions, or what it already tried and failed.

The workaround is a CLAUDE.md or AGENTS.md file. But after weeks of active development, this file either becomes a massive context-eating blob, or stays too shallow to be useful. Neither scales. And it solves only the simplest case — a single developer, a single tool, a single session.

The result is a cycle every developer using AI agents recognises:

- **Context ramp-up waste** — Every session burns tokens re-discovering your architecture and codebase.
- **Loop behavior** — The agent loses track of earlier fixes and starts re-applying or undoing its own work.
- **Session isolation** — Knowledge from one session never transfers to the next. You re-teach the same things over and over.
- **No cross-agent memory** — Switch tools, spawn a sub-agent, run a CI pipeline — each one starts from zero.
- **Team fragmentation** — Multiple developers using AI agents on the same project share nothing. Every agent is an island.

This problem manifests across every AI agent workflow in use today — interactive sessions, autonomous loops, CI pipelines, multi-agent orchestration. The tooling is different in each case. The amnesia is the same.

---

## The Insight

### What GCC Proved in the Lab

An Oxford academic research project called GCC (Git-Context-Controller) proved that treating agent context like a git repository solves the amnesia problem. Agents use COMMIT, BRANCH, MERGE, and CONTEXT commands to manage their own reasoning history. Rolling summaries prevent context bloat. Paginated retrieval keeps sessions lean. GCC achieved state-of-the-art results on SWE-Bench — 48% resolution, outperforming 26 other systems.

GCC was never built for real teams. It has no shared persistence, no multi-agent coordination, no web interface, and no way to share context across tools or developers.

### What Ralph Wiggum Proved in Practice

Independently, a community of developers converged on a pattern called the Ralph Wiggum Technique. The core mechanic is disarmingly simple:

```bash
while true; do cat PROMPT.md | claude -p --dangerously-skip-permissions; done
```

Fresh context window every loop iteration. One task per iteration. `IMPLEMENTATION_PLAN.md` on disk is the shared state between loops. The agent reads the plan, picks the most important task, implements it, commits the code to git, exits. The loop restarts with a clean context. Repeat.

Ralph solves the *execution loop* problem brilliantly. But `IMPLEMENTATION_PLAN.md` is a flat task list — it tells the agent what to do next, not why decisions were made, what was tried and failed, what the architectural conventions are, or what another developer's agent discovered last week. The plan file is explicitly disposable. That is fine for solo work. It breaks for teams.

### The Combination

**ContextGit is the persistent institutional memory layer that every AI agent workflow is missing.**

- GCC provides the proven context model — commits, branches, rolling summaries.
- ContextGit builds the infrastructure, tooling, and platform around it — dual persistence, MCP server, REST API, web platform.
- Every workflow — Ralph loops, interactive sessions, CI pipelines, multi-agent orchestration, custom frameworks — plugs into the same memory layer through the interface that fits them.

The analogy to git is intentional. GCC gave us the commit model. Ralph proved that loops with persistent file state work at scale. ContextGit is the GitHub moment — making structured agent memory accessible, collaborative, and networked across every workflow.

---

## What is ContextGit

ContextGit is the memory layer for AI agent workflows. It gives agents persistent, structured, shared memory across sessions, tools, loops, pipelines, and teams — regardless of how those agents are invoked.

There are three ways to think about it:

- **For a solo developer** — persistent memory that survives between sessions, zero infrastructure required
- **For a team** — a shared context store where every agent's knowledge accumulates and compounds, across tools and workflows
- **For the ecosystem** — a public platform where developers publish and clone agent context alongside their code, the same way they publish and clone code on GitHub

---

## Core Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  HOW AGENTS CONNECT                                              │
│                                                                  │
│  MCP Server        REST API            CLI / Git hooks           │
│  (interactive      (pipelines,         (Ralph loops,             │
│   tools)           custom agents)       CI, automation)          │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│  Context Engine  (based on GCC / Aline)                          │
│  COMMIT | BRANCH | MERGE | CONTEXT                               │
│  Rolling summaries | Open threads | Session contract              │
│  AGENTS.md generator | Snapshot export                           │
└──────────────────────────┬───────────────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          │                                 │
┌─────────┴──────────┐           ┌──────────┴──────────┐
│  LocalStore        │           │  RemoteStore         │
│  SQLite + vec      │           │  Postgres + pgvector │
│  Solo dev          │           │  Team / hosted       │
│  Zero setup        │           │  Concurrent writes   │
└────────────────────┘           └─────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│  ContextGit Web Platform                                         │
│  Explore repos | Branch viewer | Diff view | Search              │
│  Clone context | Fork | Star | Team dashboards                   │
└──────────────────────────────────────────────────────────────────┘
```

### Layer 1 — Context Engine (based on GCC)

The brain. Structured context management through four git-like operations:

- **COMMIT** — Checkpoints a milestone with a rolling summary. Each commit carries compressed history of everything before it. An agent never needs to load hundreds of past entries to understand where it is.
- **BRANCH** — Creates an isolated workspace to explore an alternative approach. If it fails, the main context is untouched.
- **MERGE** — Integrates a successful branch back with a synthesis summary. Open threads from the branch carry forward if unresolved.
- **CONTEXT** — Retrieves history at the right granularity: global snapshot, branch summary, specific commit, or semantic search. Always lean. Never bulk-loaded.

### Layer 2 — Persistence Layer (dual-mode)

**LocalStore (SQLite + sqlite-vec)** — Zero infrastructure. Ships with the binary. Works offline. For solo developers.

**RemoteStore (Postgres + pgvector)** — Hosted by ContextGit or self-hosted. Concurrent writes, semantic search, scales. For teams and hosted pipelines.

One config field switches between them: `store: local` or `store: <remote-url>`.

### Layer 3 — Integration Interfaces

Three ways agents connect, each suited to a different workflow:

**MCP Server** — For interactive tools (Claude Code, Cursor, Codex). Runs locally alongside the developer's tool. Auto-detects git branches, installs git hooks, handles background snapshotting.

**REST API** — For automated pipelines, CI agents, custom frameworks (LangChain, CrewAI), and anything that isn't MCP-compatible. POST commits, GET snapshots, search context. Full feature parity with the MCP server.

**CLI** — For Ralph-style loops and shell scripts. `contextgit snapshot` generates AGENTS.md. `contextgit commit` checkpoints from the command line. `contextgit clone` downloads a public context repository. Composable with any bash workflow.

### Layer 4 — Web Platform

A GitHub-like web application where developers browse, search, publish, and clone agent context repositories. The network layer that makes institutional knowledge shareable across the ecosystem.

---

## How It Works

### The Session Start Contract

This is the most important mechanism in ContextGit. Whatever the workflow — an interactive session, a Ralph loop iteration, a CI pipeline run, a spawned sub-agent — the agent calls `context_get scope=global` and receives a compact, structured snapshot. Always the same shape. Always under 600 tokens. Regardless of whether the project has 5 commits or 500:

```
=== PROJECT STATE ===
Next.js 14, Tailwind, JWT RS256 auth, Stripe webhooks.
Middleware pattern for all auth. API routes under /api/v1.
Postgres via Supabase. Prisma ORM.

=== CURRENT BRANCH: feature/rate-limiting ===
Implementing rate limiting on API routes.
Redis chosen over in-memory — must survive deploys.
Upstash Redis client installed. Middleware skeleton in place.

=== LAST 3 COMMITS ===
[2h ago]    "Upstash client configured, env vars set"  by dev via Claude Code
[5h ago]    "Decided against in-memory: won't survive server restarts"  by dev
[yesterday] "Rate limit middleware skeleton at middleware/rateLimit.ts"  by dev

=== OPEN THREADS ===
[ ] Sliding window vs fixed window algorithm — not yet decided
[ ] Test coverage for rate limiter — pending
[ ] Token refresh fails on mobile Safari — tracked in fix/safari-token
```

**~400–600 tokens. Flat cost regardless of project age.**

This is not the PRD. It is not the architecture document. It is the distilled reality of what has actually been built and decided — more useful to an agent than any document written before development started.

For deeper history the agent uses semantic search on demand:

```
context_get scope=search query="token refresh implementation"
→ 2–3 most relevant commits from any branch, any date, ~800 tokens
```

### Open Threads

Open threads are a first-class data structure, not extracted from summaries. Every commit can tag items explicitly:

```
threads.open:  "sliding window vs fixed window not decided"
threads.close: { id: "thread_abc", note: "chose Redis, see commit" }
```

Unresolved decisions are never silently dropped by summary compression. They are always surfaced at session start.

---

## Workflow Integrations

ContextGit is workflow-agnostic. Here is how it plugs into each major pattern in use today.

### 1. Interactive Sessions (Claude Code, Cursor, Codex)

The largest segment of AI-assisted development today. Developer opens a tool, works for an hour, closes it. Next day, fresh context. ContextGit plugs in via the MCP server with zero workflow change.

```
Session opens
  → Agent calls context_get scope=global automatically (system prompt injection)
  → Receives compact snapshot, fully oriented in ~500 tokens
  → Works normally, commits milestones via context_commit
  → Session closes

Next session opens
  → Same compact snapshot, updated with yesterday's commits
  → Agent picks up exactly where the last one left off
```

No new commands to learn. No workflow changes. The MCP server handles everything.

### 2. Ralph / Autonomous Loop

Ralph's `while true` loop already solves the execution problem. ContextGit plugs in as the memory layer without changing the loop mechanics.

```bash
while true; do
  # Generate AGENTS.md from ContextGit snapshot
  contextgit snapshot --format=agents-md > AGENTS.md

  # Run Ralph iteration (reads AGENTS.md + IMPLEMENTATION_PLAN.md as always)
  cat PROMPT.md | claude -p --dangerously-skip-permissions

  # Checkpoint context after iteration completes
  contextgit commit "Loop iteration: $(git log -1 --pretty=%s)"

  git push origin "$(git branch --show-current)"
done
```

**What this adds to Ralph:**

- `AGENTS.md` is auto-generated from accumulated context — never manually maintained, never stale
- Decisions, failed approaches, and architectural discoveries persist across loop restarts
- When a second developer runs the same loop on the same project, their AGENTS.md reflects everything the first developer's loops discovered
- The ContextGit web UI gives visibility into what the loop has been doing — branch tree, commit history, open threads — without reading raw git logs

**What stays unchanged:** `IMPLEMENTATION_PLAN.md` remains entirely Ralph's domain. ContextGit does not touch it. Clean separation: Ralph owns task tracking, ContextGit owns institutional memory.

### 3. CI / GitHub Actions Pipelines

Agents running in CI — auto-fix failing tests, auto-review PRs, auto-generate docs — are stateless by design. Each run is a fresh environment. ContextGit gives these agents project knowledge without any manual setup.

```yaml
# .github/workflows/ai-review.yml
- name: Pull context snapshot
  run: contextgit snapshot --project $PROJECT_ID --store $CONTEXTHUB_REMOTE_URL > AGENTS.md

- name: Run review agent
  run: cat prompts/review.md | claude -p --dangerously-skip-permissions

- name: Commit agent findings
  run: contextgit commit "CI review: PR #$PR_NUMBER findings" --store $CONTEXTHUB_REMOTE_URL
```

Every CI run builds on what previous runs discovered. A flaky test pattern found in one run is committed to context. The next run that touches the same code area retrieves it automatically.

### 4. Multi-Agent Orchestration

Orchestrators spawning dev agents, test agents, and review agents. Each sub-agent calls `context_get scope=global` on startup and is immediately oriented without manual briefing. Each agent writes its findings directly to the shared store, attributed by role.

```
Orchestrator spawns dev agent:
  → Dev agent: context_get scope=global  (~500 tokens, fully oriented)
  → Dev agent: implements feature
  → Dev agent: context_commit role=dev "Stripe webhooks implemented"

Orchestrator spawns test agent (same branch):
  → Test agent: context_get scope=global  (includes dev agent's commits)
  → Test agent: runs tests, finds edge case
  → Test agent: context_commit role=test "Edge case: duplicate webhook on retry"
    threads.open: ["duplicate webhook on retry — needs idempotency key update"]

Orchestrator synthesis:
  → context_commit role=orchestrator "Feature complete. 1 open thread."
```

No agent is manually briefed. The context store is the shared brain.

### 5. Background Agents (Cursor, etc.)

Background agents run autonomously while the developer is away. ContextGit gives them full project context at startup via the MCP server. Their findings are committed back, so when the developer returns and opens an interactive session the next morning, the session snapshot includes everything the background agent discovered overnight.

### 6. Custom Agent Frameworks (LangChain, CrewAI, custom pipelines)

Teams building their own agent pipelines call the ContextGit REST API directly. No MCP required.

```python
import requests

# Get session snapshot at pipeline start
snapshot = requests.get(
    f"{CONTEXTHUB_URL}/v1/projects/{PROJECT_ID}/snapshot",
    headers={"Authorization": f"Bearer {API_KEY}"}
).json()

agents_context = snapshot["projectSummary"]

# ... run pipeline ...

# Commit findings at pipeline end
requests.post(
    f"{CONTEXTHUB_URL}/v1/projects/{PROJECT_ID}/commits",
    json={"message": "Pipeline run complete", "content": findings},
    headers={"Authorization": f"Bearer {API_KEY}"}
)
```

ContextGit becomes the memory backend for any orchestration framework, not just MCP-compatible tools.

---

## For the Open Source Ecosystem

A developer building an open-source project publishes their context repository to ContextGit alongside their GitHub repo. The README links to both.

A new contributor clones the code from GitHub and the agent context from ContextGit. Their AI coding tool — whatever it is, whatever workflow they use — immediately understands the architecture, the conventions, the known failure modes, and the active development threads.

```bash
contextgit clone contextgit.dev/vercel/next.js-agent-context
```

This is the flywheel. Every published context repository makes the platform more valuable. Every developer who clones a context repository has a reason to publish their own.

---

## How to Build It

### Phase 1 — Integration Core (Weeks 1–4)

**Goal:** Context engine working on dual-mode persistence. Session start contract validated. All three integration interfaces (MCP, REST, CLI) functional. Validated on a real project using at least two different workflows.

- Fork GCC/Aline (MIT licensed)
- Build storage abstraction with LocalStore (SQLite + sqlite-vec)
- Port COMMIT, BRANCH, MERGE, CONTEXT against the storage interface
- Rolling summary (rule-based compression in Phase 1)
- Open threads as first-class data
- Git branch auto-detection and hook installer
- Local vector embeddings for semantic search
- MCP server: `npx contextgit init`
- REST API: core context endpoints
- CLI: `contextgit snapshot`, `contextgit commit`, `contextgit clone`
- Validate on a real project across two workflows: interactive session + Ralph loop

**The validation gate:** Does the session start snapshot orient an agent without reading any other documentation? Is AGENTS.md generated from the snapshot useful in a Ralph loop? If no to either, fix before Phase 2.

**Deliverable:** All three interfaces working. Context survives across sessions, loop iterations, and tool switches. Zero infrastructure for solo use.

### Phase 2 — Multi-Agent and Team Support (Weeks 5–8)

**Goal:** Multiple agents, multiple tools, multiple workflows sharing context on the same project.

- RemoteStore (Postgres + pgvector) behind the same storage interface
- Agent registry with roles (solo, dev, test, review, orchestrator, ci)
- Namespacing: private branches and shared branches
- Context sync: push local → remote, pull remote → local
- CI integration: GitHub Actions example workflow
- Basic auth and API keys
- Project and user management

**Deliverable:** Developer running interactive Claude Code sessions and Ralph loops on the same project share one context store. CI agents contribute to the same store. All workflows write to and read from the same institutional memory.

### Phase 3 — Web Platform (Weeks 9–14)

**Goal:** GitHub-like interface for browsing, sharing, and discovering agent context across the ecosystem.

- React web application with context repository explorer
- Branch tree visualization (D3.js), aligned to git branches
- Commit diff viewer — what changed, by which agent, from which workflow
- Open threads panel — per project, per branch
- Full-text and semantic search
- Public context repositories — publish, clone, fork, star
- Team dashboard — live WebSocket view of all active agents across all workflows
- Session replay
- User auth, project management, organization accounts

**Deliverable:** Web platform where teams manage agent context visually and developers share context repositories with the world.

---

## Technical Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Context Engine | TypeScript / Node.js | Matches GCC/Aline and MCP ecosystem |
| MCP Server | MCP SDK (TypeScript) | Native integration with Claude Code, Cursor |
| REST API | Node.js / Express | CI, custom frameworks, non-MCP agents |
| CLI | TypeScript / oclif | Ralph loops, shell scripts, automation |
| LocalStore | SQLite + sqlite-vec | Zero setup, offline, solo dev |
| RemoteStore | Postgres + pgvector | Concurrent writes, team + hosted |
| Hosted Infra | Supabase | Postgres + pgvector + auth + realtime, free tier |
| Semantic Search | Local embeddings (Phase 1), pgvector (Phase 2+) | No API key required locally |
| Web Frontend | React + Tailwind + D3.js | D3 for branch/graph visualizations |
| API Layer | REST + WebSocket | REST for CRUD, WebSocket for live agent activity |
| Git Integration | simple-git | Branch detection, hook installation |

---

## Why This Is Defensible

AI platforms — Anthropic, OpenAI, Google — will each build proprietary context management for their own tools. They will not agree on a shared standard. This creates the exact fragmentation that existed before git unified version control.

ContextGit is the neutral, open-source layer that works across all of them and all workflows. Claude Code uses it. Cursor uses it. A Ralph loop uses it. A GitHub Actions pipeline uses it. A LangChain agent uses it. Whatever ships next year uses it.

The moat is not the code — it is open source. The moat is:

- **Accumulated knowledge** — A team's context repository is institutional memory. Migrating away means losing it.
- **Workflow independence** — Works with every pattern, today and tomorrow. As new agent workflows emerge, ContextGit adds an integration interface. The memory layer stays the same.
- **Network effects** — Public context repositories create discovery and sharing loops across the ecosystem.
- **Community contributions** — Context templates, workflow-specific integrations, best practices contributed by the community compound over time.

The longer-term hedge: context windows are getting larger. If vendors partially solve session memory natively within their own tools, the cross-tool, cross-workflow, cross-team knowledge graph becomes the headline value. That story is already in the product.

---

## Business Model

Open-source core with commercial hosting:

| Tier | Offering | Price |
|------|----------|-------|
| Open Source | CLI + MCP server + REST API + LocalStore + single-project web UI | Free forever |
| Team | Hosted RemoteStore, team management, SSO, shared dashboards, private repos, CI integration | $15/user/month |
| Enterprise | On-prem deployment, audit logs, compliance, SLA, priority support | Custom |

Public context repositories are always free. The network effect depends on it.

---

## Open Source Strategy

ContextGit is built on GCC/Aline (MIT licensed):

- **Credit prominently** — Acknowledge GCC/Aline in the README, docs, and website.
- **Contribute upstream** — Generic improvements to the context engine go back to GCC.
- **MIT license the core** — Anyone can use, fork, and modify.
- **Engage both communities** — GCC maintainers and the Ralph Wiggum community. Both are natural early adopters and potential contributors.
- **Commercial layer is additive** — Paid tiers offer hosting and team features. Core functionality is never restricted.

---

## Success Criteria

### 30 Days
- All three interfaces working: MCP, REST, CLI
- Session start contract validated across two workflows (interactive + Ralph)
- AGENTS.md generation from snapshot working and useful in a real Ralph loop
- GitHub repo with README and architecture documentation

### 90 Days
- RemoteStore live with Postgres + pgvector
- CI integration with GitHub Actions example
- Multi-agent support — orchestrator + dev + test on same project
- Web UI prototype with branch visualization and open threads panel
- 50+ GitHub stars, 3 external contributors

### 6 Months
- Public context repositories live — publish and clone end to end
- 500+ GitHub stars
- Beta of hosted team product
- 10 teams actively using across multiple workflow types
- Featured in Ralph Wiggum and Claude Code communities

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Rolling summary drops important decisions over time | High | Versioned summary history — every summary stored, never overwritten. Raw commits always searchable. Open threads immune to compression. |
| Platform vendors build native context management | High | Cross-tool, cross-workflow, open-source by design. Vendor solutions are siloed — increases demand for a neutral layer. |
| Fragmented adoption — different teams use different workflows | Medium | Workflow-agnostic design is the answer. One memory layer, many integration points. Not a risk, it is the positioning. |
| Low adoption in a crowded AI tooling space | Medium | Ralph community and Claude Code power users are the natural beachhead. Concrete value prop: AGENTS.md auto-generated, never stale. |
| GCC approach doesn't scale beyond benchmark tasks | Medium | Validate on real 6+ week project in Phase 1. Hybrid retrieval is the fallback. |
| Agent-cooperation in interactive sessions | Low | Ralph's loop enforces commits mechanically. For interactive sessions, background snapshotting and system prompt injection are the fallback. Validated in Phase 1. |

---

**Ready to build this?**

Phase 1 is four weeks. Three integration interfaces. One validation question: does the session start snapshot orient an agent without reading any other documentation, across at least two different workflows?

Everything else follows from that answer.

Let's talk.
