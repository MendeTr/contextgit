# ContextGit — Docs Roadmap

**Last updated:** 2026-05-21

This is the index for `docs/`. It exists because the folder accumulated layers —
founding vision, completed phase plans, delta specs — and it was no longer obvious
which document is a *task to do* versus a *record of what happened*.

Read this file first.

---

## Active work queue — do these in order

These are the only documents that describe work not yet done. The number prefix is
the order.

| # | Spec | Target | Status |
|---|------|--------|--------|
| **01** | `01_ContextGit_DELTA_connectivity_fixes.md` | `0.1.x` | Ready — **do first** |
| **02** | `02_ContextGit_DELTA_granularity.md` | `0.2.0` | Ready — do after 01 is shipped and re-audited |

**Why this order is fixed:** `01` fixes three bugs found in a Claude Code usage
audit — most importantly, the `@CLAUDE.contextgit.md` include is never wired, so on
any project with a pre-existing `CLAUDE.md` the save half of ContextGit is
disconnected. Until `01` ships, no measurement of `02` is meaningful. `02` (the
three-tier memory model) is built and measured against the post-`01` audit baseline.

---

## Done — historical record, do not treat as tasks

These describe work that is already shipped. Kept in `docs/` as the build record.

| Document | What it is |
|----------|------------|
| `ContextGit_PRD_v4.md` | Current product vision. Baseline truth. Aligned with the granularity decision (rolling summaries, open threads immune to compression, windowed retrieval). |
| `ContextGit_ARCHITECTURE_v3.md` | Current architecture. |
| `ContextGit_PHASE1_PLAN.md` | Phase 1 build plan — **complete**. |
| `ContextGit_PHASE2_PLAN.md` | Phase 2 build plan — **complete**. |
| `ContextGit_DELTA.md` | Append-only scope-change log. Not a plan. Never rewritten. |
| `ContextGit_DELTA_3_plugin.md` | Claude Code plugin delta — shipped. |
| `ContextGit_DELTA_multiagent.md` | Multi-agent coordination delta — shipped. |
| `ContextGit_DELTA_live_claims.md` | Live claims coordination delta — shipped. |
| `decisions.md` | Running decision log. |
| `ContextGit_Testing_Guide.md` | Testing reference. |

---

## Superseded — see `docs/old/`

Documents that were replaced by a later decision are moved to `docs/old/` so they
do not appear to be live. They are kept, not deleted, for traceability.

| Document | Superseded by |
|----------|---------------|
| `old/Abandoned-ContextGit_DELTA_zero_config_init.md` | `ContextGit_DELTA_3_plugin.md` (the `systemPrompt` MCP field it relied on does not exist in Claude Code) |

---

## Conventions

- **Delta specs** (`*_DELTA_*.md`) are units of work. Active ones get a `NN_` prefix
  showing queue order. Once shipped, the prefix can stay — it is also the rough
  chronological order.
- **PRD / Architecture / Phase plans** are not tasks and are never prefixed.
- **Superseded** documents move to `docs/old/`, they are not edited or deleted.
- `ContextGit_DELTA.md` is the one append-only log — never rewritten, by its own rule.
