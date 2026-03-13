// store-router.ts — Express router providing direct ContextStore access over HTTP.
//
// Mounted at a path prefix (e.g. /v1/store). Used by RemoteStore clients.
//
// Routes:
//   POST   /projects                              → createProject
//   GET    /projects/:id                          → getProject
//   POST   /branches                              → createBranch
//   GET    /branches/:id                          → getBranch
//   GET    /projects/:projectId/branches?git=     → getBranchByGitName
//   GET    /projects/:projectId/branches          → listBranches
//   PUT    /branches/:id/head                     → updateBranchHead
//   POST   /branches/:id/merge                    → mergeBranch
//   POST   /commits                               → createCommit
//   GET    /commits/:id                           → getCommit
//   GET    /branches/:branchId/commits            → listCommits
//   GET    /projects/:id/snapshot                 → getFormattedSnapshot
//   GET    /projects/:id/session-snapshot         → getSessionSnapshot
//   GET    /projects/:id/threads                  → listOpenThreads
//   GET    /branches/:branchId/threads            → listOpenThreadsByBranch
//   POST   /commits/:id/embedding                 → indexEmbedding
//   POST   /projects/:id/search/semantic          → semanticSearch
//   GET    /projects/:id/search                   → fullTextSearch
//   POST   /agents                                → upsertAgent
//   GET    /projects/:id/agents                   → listAgents

import { Router, Request, Response } from 'express'
import type { ContextStore } from '@contextgit/store'
import type {
  AgentInput,
  BranchInput,
  CommitInput,
  Pagination,
  ProjectInput,
  SnapshotFormat,
  Thread,
} from '@contextgit/core'

function err(res: Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  res.status(500).json({ error: msg })
}

export function createStoreRouter(store: ContextStore): Router {
  const r = Router()

  // ── Projects ──────────────────────────────────────────────────────────────

  r.post('/projects', async (req: Request, res: Response) => {
    try {
      const result = await store.createProject(req.body as ProjectInput)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const result = await store.getProject(req.params['id']!)
      if (!result) { res.status(404).json({ error: 'Not found' }); return }
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Branches ──────────────────────────────────────────────────────────────

  r.post('/branches', async (req: Request, res: Response) => {
    try {
      const result = await store.createBranch(req.body as BranchInput)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/branches/:id', async (req: Request, res: Response) => {
    try {
      const result = await store.getBranch(req.params['id']!)
      if (!result) { res.status(404).json({ error: 'Not found' }); return }
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // GET /projects/:projectId/branches?git=<name>  → getBranchByGitName
  // GET /projects/:projectId/branches             → listBranches
  r.get('/projects/:projectId/branches', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params as { projectId: string }
      const git = req.query['git'] as string | undefined
      if (git) {
        const result = await store.getBranchByGitName(projectId, git)
        if (!result) { res.status(404).json({ error: 'Not found' }); return }
        res.json(result)
      } else {
        const result = await store.listBranches(projectId)
        res.json(result)
      }
    } catch (e) { err(res, e) }
  })

  r.put('/branches/:id/head', async (req: Request, res: Response) => {
    try {
      const { commitId } = req.body as { commitId: string }
      await store.updateBranchHead(req.params['id']!, commitId)
      res.status(204).end()
    } catch (e) { err(res, e) }
  })

  r.post('/branches/:id/merge', async (req: Request, res: Response) => {
    try {
      const { targetBranchId, summary } = req.body as { targetBranchId: string; summary: string }
      const result = await store.mergeBranch(req.params['id']!, targetBranchId, summary)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  // ── Commits ───────────────────────────────────────────────────────────────

  r.post('/commits', async (req: Request, res: Response) => {
    try {
      const result = await store.createCommit(req.body as CommitInput)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/commits/:id', async (req: Request, res: Response) => {
    try {
      const result = await store.getCommit(req.params['id']!)
      if (!result) { res.status(404).json({ error: 'Not found' }); return }
      res.json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/branches/:branchId/commits', async (req: Request, res: Response) => {
    try {
      const pagination: Pagination = {
        limit: parseInt(String(req.query['limit'] ?? '10'), 10),
        offset: parseInt(String(req.query['offset'] ?? '0'), 10),
      }
      const result = await store.listCommits(req.params['branchId']!, pagination)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Snapshots ─────────────────────────────────────────────────────────────

  // GET /projects/:id/snapshot?branchId=&format=  → getFormattedSnapshot
  r.get('/projects/:id/snapshot', async (req: Request, res: Response) => {
    try {
      const projectId = req.params['id']!
      const branchId = String(req.query['branchId'] ?? '')
      const format = String(req.query['format'] ?? 'text') as SnapshotFormat
      if (!branchId) { res.status(400).json({ error: "'branchId' query param required" }); return }
      const result = await store.getFormattedSnapshot(projectId, branchId, format)
      const ct = format === 'json' ? 'application/json' : 'text/plain; charset=utf-8'
      res.setHeader('Content-Type', ct).send(result)
    } catch (e) { err(res, e) }
  })

  // GET /projects/:id/session-snapshot?branchId=  → getSessionSnapshot
  r.get('/projects/:id/session-snapshot', async (req: Request, res: Response) => {
    try {
      const projectId = req.params['id']!
      const branchId = String(req.query['branchId'] ?? '')
      if (!branchId) { res.status(400).json({ error: "'branchId' query param required" }); return }
      const agentRole = req.query['agentRole'] ? String(req.query['agentRole']) : undefined
      const result = await store.getSessionSnapshot(projectId, branchId, agentRole ? { agentRole: agentRole as import('@contextgit/core').AgentRole } : undefined)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Threads ───────────────────────────────────────────────────────────────

  r.post('/threads', async (req: Request, res: Response) => {
    try {
      const body = req.body as Thread
      // Parse createdAt from ISO string to Date
      const thread: Thread = { ...body, createdAt: new Date(body.createdAt) }
      const result = await store.syncThread(thread)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/projects/:id/threads', async (req: Request, res: Response) => {
    try {
      const result = await store.listOpenThreads(req.params['id']!)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/branches/:branchId/threads', async (req: Request, res: Response) => {
    try {
      const result = await store.listOpenThreadsByBranch(req.params['branchId']!)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Embeddings & Search ───────────────────────────────────────────────────

  r.post('/commits/:id/embedding', async (req: Request, res: Response) => {
    try {
      const { vector } = req.body as { vector: number[] }
      await store.indexEmbedding(req.params['id']!, new Float32Array(vector))
      res.status(204).end()
    } catch (e) { err(res, e) }
  })

  r.post('/projects/:id/search/semantic', async (req: Request, res: Response) => {
    try {
      const { vector, limit } = req.body as { vector: number[]; limit?: number }
      const result = await store.semanticSearch(new Float32Array(vector), req.params['id']!, limit ?? 5)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/projects/:id/search', async (req: Request, res: Response) => {
    try {
      const q = req.query['q']
      if (typeof q !== 'string' || !q.trim()) {
        res.status(400).json({ error: "'q' query param required" }); return
      }
      const result = await store.fullTextSearch(q, req.params['id']!)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Claims ───────────────────────────────────────────────────────────────

  r.post('/projects/:id/claims', async (req: Request, res: Response) => {
    try {
      const { branchId, ...input } = req.body as { branchId: string } & import('@contextgit/core').ClaimInput
      const result = await store.claimTask(req.params['id']!, branchId, input)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.delete('/claims/:claimId', async (req: Request, res: Response) => {
    try {
      await store.unclaimTask(req.params['claimId']!)
      res.status(204).end()
    } catch (e) { err(res, e) }
  })

  r.get('/projects/:id/claims', async (req: Request, res: Response) => {
    try {
      const result = await store.listActiveClaims(req.params['id']!)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // GET /projects/:id/delta?branchId=&since=  → getContextDelta
  r.get('/projects/:id/delta', async (req: Request, res: Response) => {
    try {
      const projectId = req.params['id']!
      const branchId = String(req.query['branchId'] ?? '')
      const since = Number(req.query['since'])
      if (!branchId) { res.status(400).json({ error: "'branchId' query param required" }); return }
      if (isNaN(since)) { res.status(400).json({ error: "'since' must be a Unix ms timestamp" }); return }
      const result = await store.getContextDelta(projectId, branchId, since)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  // ── Agents ────────────────────────────────────────────────────────────────

  r.post('/agents', async (req: Request, res: Response) => {
    try {
      const result = await store.upsertAgent(req.body as AgentInput)
      res.status(201).json(result)
    } catch (e) { err(res, e) }
  })

  r.get('/projects/:id/agents', async (req: Request, res: Response) => {
    try {
      const result = await store.listAgents(req.params['id']!)
      res.json(result)
    } catch (e) { err(res, e) }
  })

  return r
}
