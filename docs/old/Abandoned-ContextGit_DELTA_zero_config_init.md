# ContextGit — Delta Spec: Zero-Config Init

**Date:** 2026-03-16  
**Status:** Ready for implementation  
**Target version:** 0.0.5  
**Scope:** `packages/cli` — `init` command only

---

## Problem

`contextgit init` currently prints the MCP server entry and system prompt fragment and tells the user to paste them manually into their MCP client config. This is the primary drop-off point for new users.

The discipline that makes ContextGit work — agents calling `context_get` automatically at session start — depends entirely on the system prompt fragment being present in the MCP client config. If the user skips the paste step, or pastes it incorrectly, ContextGit is installed but broken. The agent never loads context. The user sees no value.

The CLAUDE.md approach is also fragile: it only works in Claude Code, breaks when a new developer joins the team, and is one more manual step that can be skipped.

**The fix:** `contextgit init` auto-detects installed MCP clients and injects the configuration directly. No manual pasting. Zero-config.

---

## Goal

After running `contextgit init` in any project directory, the developer's MCP clients are fully configured. The next time they open Claude Code (or Cursor, or Claude Desktop), the ContextGit MCP server is available and the system prompt instructs the agent to call `context_get scope=global` automatically.

The session start contract must be enforced by the tool itself — not by a convention in CLAUDE.md.

---

## Scope

### In scope
- Auto-detect Claude Code (`~/.claude.json`)
- Auto-detect Cursor (`~/.cursor/mcp.json`)
- Auto-detect Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows)
- Inject MCP server entry into each detected client config
- Inject system prompt fragment into each detected client config
- Print a clear summary of what was configured and what was skipped
- Preserve all existing content in client config files — surgical JSON merge, never overwrite
- Idempotent — running `contextgit init` twice on the same project does not duplicate entries
- If no MCP clients are detected, fall back to printing the manual paste instructions (current behavior) with a note explaining what was searched

### Out of scope
- Cursor support is best-effort — include it if the config schema is compatible, skip it cleanly if not
- VS Code Copilot, Windsurf, or other MCP clients — post-launch
- Removing or updating stale entries from previous installs — post-launch
- `--client` flag to target a specific client — post-launch

---

## The System Prompt Fragment

This is the exact text to inject as the `systemPrompt` field on the MCP server entry (or equivalent field for each client). Do not alter the wording — this is what makes the session start contract work.

```
You have access to ContextGit memory tools.

At the start of every session, call context_get with scope=global immediately — before reading any files, before asking any questions, before doing any work. Do not skip this step.

After completing significant work (a feature, a decision, a resolved problem), call context_commit with a message describing what was done, what was decided, and any open questions. Include the current git branch and commit hash at the top of the message.

If you are about to explore a risky or experimental approach, call context_branch first to create an isolated context workspace.
```

---

## Client Config Schemas

### Claude Code — `~/.claude.json`

Claude Code stores MCP servers under `mcpServers` at the top level. Each entry is keyed by server name. The `systemPrompt` field on the entry is injected into the agent's system prompt when the server is active.

**Before:**
```json
{
  "mcpServers": {
    "other-server": { "command": "npx", "args": ["other-server"] }
  }
}
```

**After:**
```json
{
  "mcpServers": {
    "other-server": { "command": "npx", "args": ["other-server"] },
    "contextgit": {
      "command": "npx",
      "args": ["contextgit", "mcp"],
      "systemPrompt": "<system prompt fragment above>"
    }
  }
}
```

If `mcpServers` does not exist, create it. If `contextgit` entry already exists, skip injection and note it in output.

### Cursor — `~/.cursor/mcp.json`

Cursor's MCP config uses `mcpServers` with the same schema as Claude Code. Apply the same merge. If the file does not exist, create it with the contextgit entry only.

**Note:** Cursor's support for `systemPrompt` on individual server entries may vary by version. Attempt to write it. If the schema rejects it on validation, write the entry without `systemPrompt` and note in output that the system prompt could not be injected for Cursor — user should add CLAUDE.md conventions manually for Cursor sessions.

### Claude Desktop — platform-specific path

Claude Desktop uses `mcpServers` under a `globalShortcuts` wrapper in some versions. Read the file first and detect the schema before writing. If the schema matches Claude Code's top-level `mcpServers` format, apply the same merge. If the schema is unrecognized, skip and print a warning.

---

## Implementation Plan

All changes are in `packages/cli/src/commands/init.ts`. No other packages need modification.

### Step 1 — Extract system prompt constant

Define the system prompt fragment as a named constant at the top of the init command file. Do not inline it — it will be referenced in tests.

```typescript
const MCP_SYSTEM_PROMPT = `You have access to ContextGit memory tools.

At the start of every session, call context_get with scope=global immediately — before reading any files, before asking any questions, before doing any work. Do not skip this step.

After completing significant work (a feature, a decision, a resolved problem), call context_commit with a message describing what was done, what was decided, and any open questions. Include the current git branch and commit hash at the top of the message.

If you are about to explore a risky or experimental approach, call context_branch first to create an isolated context workspace.`
```

### Step 2 — Write a `ClientConfigManager` utility

Create `packages/cli/src/lib/client-config.ts` with the following responsibilities:

- `detectClients(): DetectedClient[]` — check existence of each known config file path, return array of detected clients with their resolved paths
- `injectMcpServer(clientPath: string, clientType: ClientType): InjectionResult` — read the JSON file, merge the contextgit server entry, write it back atomically (write to temp file, rename)
- `isAlreadyInjected(config: object): boolean` — check if `contextgit` key already exists under `mcpServers`

Types:
```typescript
type ClientType = 'claude-code' | 'cursor' | 'claude-desktop'

interface DetectedClient {
  type: ClientType
  path: string
}

interface InjectionResult {
  status: 'injected' | 'already-present' | 'skipped' | 'error'
  reason?: string
}
```

**Atomic write pattern** — never corrupt the user's config:
```typescript
const tmpPath = configPath + '.contextgit-tmp'
await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2))
await fs.rename(tmpPath, configPath)
```

**Read-first always** — parse the existing file before any write. If the file is invalid JSON, status = 'error', reason = 'existing config is not valid JSON — skipped to avoid data loss'. Never overwrite a corrupt file.

### Step 3 — Update the init command

After the existing init logic completes (project DB created, config written, hooks offered), add the client configuration step:

```
1. Call detectClients()
2. For each detected client, call injectMcpServer()
3. Collect results
4. Print summary (see Output Format below)
5. If zero clients detected, print fallback manual instructions
```

The client config step runs after project init, not before. A failed injection should never block project init from completing.

Wrap the entire client config block in try/catch. If anything unexpected throws, print a warning and fall back to manual instructions. Never crash init due to a client config write failure.

### Step 4 — Output format

Successful injection:
```
✅ Configured Claude Code   (~/.claude.json)
✅ Configured Cursor        (~/.cursor/mcp.json)
⏭  Claude Desktop not found (skipped)

ContextGit is ready. Open Claude Code in this project and start a session.
The agent will call context_get automatically on every session start.
```

Already present:
```
⏭  Claude Code already configured (skipped)
```

No clients found:
```
⚠️  No MCP clients detected.

Add the following to your MCP client config manually:

  "contextgit": {
    "command": "npx",
    "args": ["contextgit", "mcp"],
    "systemPrompt": "..."
  }

Searched:
  ~/.claude.json
  ~/.cursor/mcp.json
  ~/Library/Application Support/Claude/claude_desktop_config.json
```

Error on one client:
```
❌ Claude Code config error: existing config is not valid JSON — skipped to avoid data loss
   Path: ~/.claude.json
   Fix manually or re-run after repairing the file.
```

---

## Tests

Add tests in `packages/cli/src/lib/client-config.test.ts`:

1. `detectClients` returns empty array when no config files exist
2. `detectClients` returns Claude Code entry when `~/.claude.json` exists
3. `injectMcpServer` writes correct JSON structure to a new empty config file
4. `injectMcpServer` merges into existing config without touching other keys
5. `injectMcpServer` returns `already-present` if contextgit key exists
6. `injectMcpServer` returns `error` and does not write if existing file is invalid JSON
7. `injectMcpServer` uses atomic write (temp file + rename)
8. `isAlreadyInjected` returns true when contextgit is present under mcpServers

Use a temp directory for all file operations in tests — never touch real `~/.claude.json` in tests.

---

## Validation Gate

Before marking this delta complete:

1. Fresh install: `npm install -g contextgit@0.0.5` on a machine with Claude Code installed
2. Navigate to any project directory
3. Run `contextgit init`
4. Confirm `~/.claude.json` contains the contextgit server entry and system prompt
5. Open Claude Code in that directory
6. Type `start` — confirm agent calls `context_get` without being asked to
7. Confirm no clarifying questions before agent begins work

If step 6 and 7 pass — the session start contract is enforced by the tool. This delta is complete.

---

## What does NOT change

- `.contextgit/system-prompt.md` is still written during init (keep it as a reference for developers who want to understand what was injected)
- The MCP server implementation itself (`packages/mcp`) is unchanged
- The project DB, config, and hooks logic in init is unchanged
- CLAUDE.md conventions remain valid for developers who want additional project-specific instructions — but ContextGit no longer depends on them

---

## Architecture note

The architecture document already describes the MCP server as handling "system prompt injection" and "auto-detects git branches, installs hooks." This implementation delivers on that description. No architecture update required.
