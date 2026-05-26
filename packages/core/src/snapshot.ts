// SnapshotFormatter — converts a SessionSnapshot to one of the 3 output formats.
// Moved from store/local/index.ts (inline) to core so all consumers share the same output.

import type { Claim, PlanNode, SessionSnapshot, SnapshotFormat, Thread } from './types.js'

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

/**
 * Render the active plan tree as nested lines with status markers (04 DELTA).
 *   ✓  complete (task with status='done', or container with all children complete)
 *   →  the single "next" pending task — first pending task in document order
 *   ▸  in-progress (task) or partial (container with some children complete)
 *   ○  not started / empty container / pending
 *
 * The marker uses the same `isComplete` rule that drives the [n/m done]
 * rollup — display and rollup are derived from one definition. Containers
 * (plan/step) need children to be complete; status='done' alone on an empty
 * container doesn't make it ✓ (matches queries.ts walkAndSetProgress).
 *
 * Returns null when the tree is empty.
 */
function renderPlanTree(tree: PlanNode[]): string | null {
  if (!tree || tree.length === 0) return null

  // Find the single "next" pending task (depth-first document order)
  let nextTaskId: string | null = null
  const findNext = (nodes: PlanNode[]): boolean => {
    for (const n of nodes) {
      if (n.level === 'task' && n.status === 'pending') {
        nextTaskId = n.id
        return true
      }
      if (n.children && findNext(n.children)) return true
    }
    return false
  }
  findNext(tree)

  // Mirror of queries.ts walkAndSetProgress — single source of truth for what
  // "complete" means at any depth. Used here so the marker matches the rollup.
  const isComplete = (n: PlanNode): boolean => {
    if (n.level === 'task') return n.status === 'done'
    if (!n.children || n.children.length === 0) return false
    return n.children.every(isComplete)
  }

  const lines: string[] = []
  const render = (node: PlanNode, depth: number) => {
    const indent = '  '.repeat(depth)
    let marker: string
    if (node.level === 'task') {
      if (node.status === 'done') marker = '✓'
      else if (node.id === nextTaskId) marker = '→'
      else if (node.status === 'in_progress') marker = '▸'
      else marker = '○'
    } else {
      if (isComplete(node)) marker = '✓'
      else if (node.progress && node.progress.done > 0) marker = '▸'
      else if (node.status === 'in_progress') marker = '▸'
      else marker = '○'
    }
    let line = `${indent}[${node.id.slice(0, 6)}] ${marker} ${node.title}`
    if (node.level !== 'task' && node.progress && node.progress.total > 0) {
      line += `  [${node.progress.done}/${node.progress.total} done]`
    }
    if (node.id === nextTaskId) line += '  ← next'
    lines.push(line)
    for (const c of node.children ?? []) render(c, depth + 1)
  }
  for (const top of tree) render(top, 0)
  return lines.join('\n')
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
      const planRendered = renderPlanTree(snapshot.planTree ?? [])
      if (planRendered) sections.push(`## Plan`, planRendered, ``)
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
    const planRenderedText = renderPlanTree(snapshot.planTree ?? [])
    if (planRenderedText) textSections.push(`=== PLAN ===`, planRenderedText, ``)
    textSections.push(`=== CURRENT BRANCH: ${branchName} ===`, branchSummary || '(no branch summary yet)')
    textSections.push(``, `=== RECENT COMMITS ===`, commits || '(none)')
    textSections.push(``, `=== OPEN THREADS ===`, threadsSectionText)
    textSections.push(``, `=== ACTIVE CLAIMS ===`, claimsSectionText)
    return textSections.join('\n')
  }
}
