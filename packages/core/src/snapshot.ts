// SnapshotFormatter — converts a SessionSnapshot to one of the 3 output formats.
// Moved from store/local/index.ts (inline) to core so all consumers share the same output.

import type { Claim, SessionSnapshot, SnapshotFormat, Thread } from './types.js'

function claimLabel(thread: Thread, activeClaims: Claim[]): string {
  const match = activeClaims.find(
    (cl) =>
      (cl.threadId && cl.threadId === thread.id) ||
      cl.task.toLowerCase().includes(thread.description.toLowerCase().slice(0, 30)),
  )
  return match ? `[CLAIMED by ${match.agentId}]` : '[FREE]'
}

function decayCountLine(staleCount: number | undefined, expiredCount: number | undefined): string | null {
  const stale = staleCount ?? 0
  const expired = expiredCount ?? 0
  if (stale === 0 && expired === 0) return null
  const parts: string[] = []
  if (stale > 0) parts.push(`+${stale} stale`)
  if (expired > 0) parts.push(`+${expired} expired-watch`)
  return `(${parts.join(', ')} — call project_memory_threads to view)`
}

export class SnapshotFormatter {
  format(snapshot: SessionSnapshot, fmt: SnapshotFormat): string {
    const { projectSummary, branchName, branchSummary, recentCommits, openThreads, activeClaims } = snapshot

    if (fmt === 'json') {
      return JSON.stringify(snapshot, null, 2)
    }

    const countLine = decayCountLine(snapshot.staleThreadCount, snapshot.expiredWatchCount)

    if (fmt === 'agents-md') {
      const uniqueThreads = [...new Map(openThreads.map((t) => [t.id, t])).values()]
      const commits = recentCommits
        .map(
          (c) =>
            `- [${c.createdAt.toISOString()}] "${c.message}" by ${c.agentRole} via ${c.tool} (${c.workflowType})`,
        )
        .join('\n')
      const threads = uniqueThreads
        .map(
          (t) =>
            `- ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
        )
        .join('\n')
      const threadsSection = countLine ? `${threads || '(none)'}\n${countLine}` : (threads || '(none)')
      return [
        `## Project State`,
        projectSummary || '(no summary yet)',
        ``,
        `## Open Threads`,
        threadsSection,
        ``,
        `## Recent Activity`,
        commits || '(no commits yet)',
        ``,
        `## Active Claims`,
        activeClaims.length
          ? activeClaims
              .map(
                (cl) =>
                  `- [CLAIMED by ${cl.agentId}] ${cl.task} (claimed ${cl.claimedAt.toISOString()})`,
              )
              .join('\n')
          : '(none)',
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
          `${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
      )
      .join('\n')
    const threadsSectionText = countLine ? `${threads || '(none)'}\n${countLine}` : (threads || '(none)')

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
      threadsSectionText,
      ``,
      `=== ACTIVE CLAIMS ===`,
      activeClaims.length
        ? activeClaims
            .map(
              (cl) =>
                `- [CLAIMED by ${cl.agentId}] ${cl.task} (claimed ${cl.claimedAt.toISOString()})`,
            )
            .join('\n')
        : '(none)',
    ].join('\n')
  }
}
