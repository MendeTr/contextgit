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

/**
 * Live git facts line (02 DELTA gate 1): Branch | HEAD | commit count, read fresh on every load.
 * Returns null unless at least one of headSha / commitCount is set — branchName alone is already
 * shown elsewhere in the snapshot and doesn't justify the section.
 */
function gitFactsLine(branchName: string, headSha?: string, commitCount?: number): string | null {
  if (!headSha && commitCount == null) return null
  const parts: string[] = []
  if (branchName) parts.push(`Branch: ${branchName}`)
  if (headSha) parts.push(`HEAD: ${headSha.slice(0, 8)}`)
  if (commitCount != null) parts.push(`${commitCount} commits`)
  return parts.join(' | ')
}

export class SnapshotFormatter {
  format(snapshot: SessionSnapshot, fmt: SnapshotFormat): string {
    // Note: snapshot.projectSummary is intentionally NOT rendered. Per
    // 02_ContextGit_DELTA_granularity.md, the load returns only the curated
    // roadmap (live ## Git + threads + recent activity) — the stored prose
    // summary went stale at load time and is dropped, not maintained.
    const { branchName, branchSummary, recentCommits, openThreads, activeClaims } = snapshot

    if (fmt === 'json') {
      return JSON.stringify(snapshot, null, 2)
    }

    const countLine = decayCountLine(snapshot.staleThreadCount, snapshot.expiredWatchCount)
    const factsLine = gitFactsLine(branchName, snapshot.headSha, snapshot.commitCount)

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
            `- [${t.id.slice(0, 6)}] ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
        )
        .join('\n')
      const threadsSection = countLine ? `${threads || '(none)'}\n${countLine}` : (threads || '(none)')
      const claimsSection = activeClaims.length
        ? activeClaims
            .map(
              (cl) =>
                `- [CLAIMED by ${cl.agentId}] ${cl.task} (claimed ${cl.claimedAt.toISOString()})`,
            )
            .join('\n')
        : '(none)'
      const sections: string[] = []
      if (factsLine) sections.push(`## Git`, factsLine, ``)
      sections.push(`## Open Threads`, threadsSection)
      sections.push(``, `## Recent Activity`, commits || '(no commits yet)')
      sections.push(``, `## Active Claims`, claimsSection)
      return sections.join('\n')
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
          `[${t.id.slice(0, 6)}] ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
      )
      .join('\n')
    const threadsSectionText = countLine ? `${threads || '(none)'}\n${countLine}` : (threads || '(none)')
    const claimsSectionText = activeClaims.length
      ? activeClaims
          .map(
            (cl) =>
              `- [CLAIMED by ${cl.agentId}] ${cl.task} (claimed ${cl.claimedAt.toISOString()})`,
          )
          .join('\n')
      : '(none)'
    const textSections: string[] = []
    if (factsLine) textSections.push(`=== GIT ===`, factsLine, ``)
    textSections.push(`=== CURRENT BRANCH: ${branchName} ===`, branchSummary || '(no branch summary yet)')
    textSections.push(``, `=== RECENT COMMITS ===`, commits || '(none)')
    textSections.push(``, `=== OPEN THREADS ===`, threadsSectionText)
    textSections.push(``, `=== ACTIVE CLAIMS ===`, claimsSectionText)
    return textSections.join('\n')
  }
}
