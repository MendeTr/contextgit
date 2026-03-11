// auth.ts — Bearer token authentication middleware
//
// Reads CONTEXTGIT_API_KEY from the environment. When set, every request must
// include an `Authorization: Bearer <key>` header whose SHA-256 hash matches
// the stored hash. When the env var is absent the server runs in dev mode and
// all requests are passed through unauthenticated.

import { createHash, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest()
}

export function createAuthMiddleware(apiKey: string | undefined) {
  if (!apiKey) {
    // Dev mode — no key configured, pass all requests
    return (_req: Request, _res: Response, next: NextFunction): void => next()
  }

  const expectedHash = sha256(apiKey)

  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization']

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required' })
      return
    }

    const token = authHeader.slice(7)
    const tokenHash = sha256(token)

    if (tokenHash.length !== expectedHash.length || !timingSafeEqual(tokenHash, expectedHash)) {
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    next()
  }
}
