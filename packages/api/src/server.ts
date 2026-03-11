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
import { readServerConfig, sha256hex } from './server-config.js'

export async function createApp(): Promise<Express> {
  const ctx = await bootstrap()

  // Resolve key hash: prefer ~/.contextgit/server.json, fall back to env var
  const serverCfg = readServerConfig()
  let keyHashHex = serverCfg.keyHash
  if (!keyHashHex) {
    const envKey = process.env['CONTEXTGIT_API_KEY']
    if (envKey) keyHashHex = sha256hex(envKey)
  }

  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware(keyHashHex))

  app.use('/v1/store', createStoreRouter(ctx.store))
  app.use('/', createRouter(ctx))

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}
