#!/usr/bin/env node
// Starts the ContextGit MCP server (stdio transport).
// Uses Node module resolution — works whether @contextgit/mcp is nested or hoisted.
import('@contextgit/mcp').catch(err => {
  console.error('[contextgit-mcp] Failed to start:', err.message)
  process.exit(1)
})
