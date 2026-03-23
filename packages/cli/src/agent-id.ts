// agent-id.ts — single source of truth for CLI agent ID.
// Used by both claim.ts and bootstrap.ts so that claims and commits
// always use the same agent ID, enabling auto-release on commit.

import os from 'os'

/**
 * Returns the agent ID for CLI commands.
 * Priority: CONTEXTGIT_AGENT_ID env var > derived from hostname + username.
 */
export function getCliAgentId(): string {
  if (process.env.CONTEXTGIT_AGENT_ID) {
    return process.env.CONTEXTGIT_AGENT_ID
  }
  const user = process.env.USER ?? process.env.USERNAME ?? 'unknown'
  return `cli-${user}`
}
