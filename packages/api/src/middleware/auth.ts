// auth.ts — Bearer token authentication middleware
//
// Accepts a pre-computed SHA-256 hex digest of the API key (keyHashHex).
// Every request must include an `Authorization: Bearer <key>` header whose
// SHA-256 hash matches the stored digest.
// When keyHashHex is absent the server runs in dev mode (all requests pass).

import { createHash, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest()
}

export function createAuthMiddleware(keyHashHex: string | undefined) {
  if (!keyHashHex) {
    // Dev mode — no key configured, pass all requests
    return (_req: Request, _res: Response, next: NextFunction): void => next()
  }

  const expectedHash = Buffer.from(keyHashHex, 'hex')

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
