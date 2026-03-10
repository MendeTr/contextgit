#!/usr/bin/env node
// index.ts — entry point for the ContextHub MCP server process.
// Started by the MCP host (Claude Desktop / Claude Code) via stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Server is now listening on stdin/stdout — process stays alive until the
  // host closes the connection.
}

main().catch(err => {
  console.error('[contexthub-mcp] Fatal error:', err)
  process.exit(1)
})
