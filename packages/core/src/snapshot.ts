// SnapshotFormatter — converts a SessionSnapshot to one of the 3 output formats.
// Moved from store/local/index.ts (inline) to core so all consumers share the same output.

import type { SessionSnapshot, SnapshotFormat } from './types.js'

export class SnapshotFormatter {
  format(snapshot: SessionSnapshot, fmt: SnapshotFormat): string {
    const { projectSummary, branchName, branchSummary, recentCommits, openThreads } = snapshot

    if (fmt === 'json') {
      return JSON.stringify(snapshot, null, 2)
    }

    if (fmt === 'agents-md') {
      const commits = recentCommits
        .map(
          (c) =>
            `- [${c.createdAt.toISOString()}] "${c.message}" by ${c.agentRole} via ${c.tool} (${c.workflowType})`,
        )
        .join('\n')
      const threads = openThreads
        .map(
          (t) =>
            `- [ ] ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
        )
        .join('\n')
      return [
        `## Project State`,
        projectSummary || '(no summary yet)',
        ``,
        `## Current Branch: ${branchName}`,
        branchSummary || '(no branch summary yet)',
        ``,
        `## Recent Activity`,
        commits || '(no commits yet)',
        ``,
        `## Open Threads`,
        threads || '(none)',
      ].join('\n')
    }

    // text (default)
    const commits = recentCommits
      .map(
        (c) =>
          `[${c.createdAt.toISOString()}] "${c.message}"  by ${c.agentRole} via ${c.tool} (${c.workflowType})`,
      )
      .join('\n')
    const threads = openThreads
      .map(
        (t) =>
          `[ ] ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
      )
      .join('\n')

    return [
      `=== PROJECT STATE ===`,
      projectSummary || '(no summary yet)',
      ``,
      `=== CURRENT BRANCH: ${branchName} ===`,
      branchSummary || '(no branch summary yet)',
      ``,
      `=== LAST 3 COMMITS ===`,
      commits || '(none)',
      ``,
      `=== OPEN THREADS ===`,
      threads || '(none)',
    ].join('\n')
  }
}
