import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { createAuthMiddleware } from './auth.js'

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

async function startServer(apiKey: string | undefined): Promise<{ url: string; server: http.Server }> {
  const app = express()
  app.use(createAuthMiddleware(apiKey ? sha256hex(apiKey) : undefined))
  app.get('/ping', (_req, res) => res.json({ ok: true }))

  const server = http.createServer(app)
  const port = await new Promise<number>(resolve =>
    server.listen(0, () => resolve((server.address() as AddressInfo).port)),
  )
  return { url: `http://localhost:${port}`, server }
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers })
  const body = await res.json()
  return { status: res.status, body }
}

describe('createAuthMiddleware', () => {
  it('passes all requests when no API key is configured (dev mode)', async () => {
    const { url, server } = await startServer(undefined)
    try {
      const { status } = await get(`${url}/ping`)
      expect(status).toBe(200)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns 401 when Authorization header is missing', async () => {
    const { url, server } = await startServer('my-secret-key')
    try {
      const { status, body } = await get(`${url}/ping`)
      expect(status).toBe(401)
      expect(body).toMatchObject({ error: 'Authorization required' })
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const { url, server } = await startServer('my-secret-key')
    try {
      const { status } = await get(`${url}/ping`, { Authorization: 'Basic abc123' })
      expect(status).toBe(401)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns 401 for a wrong Bearer token', async () => {
    const { url, server } = await startServer('my-secret-key')
    try {
      const { status, body } = await get(`${url}/ping`, { Authorization: 'Bearer wrong-key' })
      expect(status).toBe(401)
      expect(body).toMatchObject({ error: 'Invalid API key' })
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('passes request with the correct Bearer token', async () => {
    const { url, server } = await startServer('my-secret-key')
    try {
      const { status, body } = await get(`${url}/ping`, { Authorization: 'Bearer my-secret-key' })
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true })
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})
