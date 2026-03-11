// router.ts — Express router for ContextGit REST API
//
// Routes:
//   POST /commits  — engine.commit() — persist a context commit
//   GET  /snapshot — store.getFormattedSnapshot() — formatted project snapshot
//   GET  /search   — store.fullTextSearch() — full-text search over commits

import { Router, Request, Response } from 'express'
import type { ApiContext } from './bootstrap.js'
import type { SnapshotFormat } from '@contextgit/core'

export function createRouter(ctx: ApiContext): Router {
  const router = Router()

  // ── POST /commits ──────────────────────────────────────────────────────────
  // Body: { message, content, open_threads?, close_thread_ids? }
  router.post('/commits', async (req: Request, res: Response) => {
    try {
      const { message, content, open_threads, close_thread_ids } = req.body as {
        message?: unknown
        content?: unknown
        open_threads?: unknown
        close_thread_ids?: unknown
      }

      if (typeof message !== 'string' || message.trim() === '') {
        res.status(400).json({ error: "'message' is required and must be a non-empty string" })
        return
      }
      if (typeof content !== 'string' || content.trim() === '') {
        res.status(400).json({ error: "'content' is required and must be a non-empty string" })
        return
      }

      const threads: { open?: string[]; close?: Array<{ id: string; note: string }> } = {}

      if (Array.isArray(open_threads) && open_threads.length > 0) {
        threads.open = open_threads.map(String)
      }
      if (Array.isArray(close_thread_ids) && close_thread_ids.length > 0) {
        threads.close = close_thread_ids.map((id: unknown) => ({
          id: String(id),
          note: 'Closed via API',
        }))
      }

      const commit = await ctx.engine.commit({
        message,
        content,
        ...(Object.keys(threads).length > 0 ? { threads } : {}),
      })

      res.status(201).json({ id: commit.id, message: commit.message, createdAt: commit.createdAt })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })

  // ── GET /snapshot ──────────────────────────────────────────────────────────
  // Query: ?format=agents-md|json|text  (default: agents-md)
  router.get('/snapshot', async (req: Request, res: Response) => {
    try {
      const format = (req.query['format'] ?? 'agents-md') as SnapshotFormat
      const validFormats: SnapshotFormat[] = ['agents-md', 'json', 'text']
      if (!validFormats.includes(format)) {
        res.status(400).json({ error: `'format' must be one of: ${validFormats.join(', ')}` })
        return
      }

      const snapshot = await ctx.store.getFormattedSnapshot(ctx.projectId, ctx.branchId, format)

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json')
        res.send(snapshot)
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.send(snapshot)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })

  // ── GET /search ────────────────────────────────────────────────────────────
  // Query: ?q=<query>&limit=<n>  (limit default: 5, max: 20)
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const q = req.query['q']
      if (typeof q !== 'string' || q.trim() === '') {
        res.status(400).json({ error: "'q' query parameter is required" })
        return
      }

      const limitRaw = parseInt(String(req.query['limit'] ?? '5'), 10)
      const limit = Number.isNaN(limitRaw) ? 5 : Math.min(Math.max(limitRaw, 1), 20)

      const results = await ctx.store.fullTextSearch(q, ctx.projectId)
      const trimmed = results.slice(0, limit)

      res.json({
        query: q,
        total: trimmed.length,
        results: trimmed.map(r => ({
          id: r.commit.id,
          message: r.commit.message,
          content: r.commit.content,
          score: r.score,
          matchType: r.matchType,
          createdAt: r.commit.createdAt,
        })),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })

  return router
}
