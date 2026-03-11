// server.ts — ContextGit REST API server
//
// Creates and configures the Express app. Separated from index.ts so tests
// can import createApp() without binding to a port.

import express from 'express'
import type { Express } from 'express'
import { bootstrap } from './bootstrap.js'
import { createRouter } from './router.js'
import { createStoreRouter } from './store-router.js'
import { createAuthMiddleware } from './middleware/auth.js'

export async function createApp(): Promise<Express> {
  const ctx = await bootstrap()

  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware(process.env['CONTEXTGIT_API_KEY']))

  app.use('/v1/store', createStoreRouter(ctx.store))
  app.use('/', createRouter(ctx))

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}
