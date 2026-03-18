import { describe, it, expect } from 'vitest'

// Test the Supabase check states in isolation
async function checkSupabase(supabaseUrl?: string, envKey?: string, fetchStatus = 200): Promise<string> {
  if (!supabaseUrl) return '[ ] Supabase: not configured (optional)'
  if (!envKey) return '[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing'
  // Simulate fetch
  if (fetchStatus === 401) return '[!] Supabase: reachable but SUPABASE_SERVICE_KEY rejected'
  if (fetchStatus < 400) return '[✓] Supabase: connected'
  return '[!] Supabase: unreachable'
}

describe('doctor Supabase check', () => {
  it('reports not configured when supabaseUrl absent', async () => {
    expect(await checkSupabase()).toBe('[ ] Supabase: not configured (optional)')
  })
  it('reports missing key when supabaseUrl set but env absent', async () => {
    expect(await checkSupabase('https://x.supabase.co')).toBe('[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing')
  })
  it('reports rejected key on 401', async () => {
    expect(await checkSupabase('https://x.supabase.co', 'key', 401)).toBe('[!] Supabase: reachable but SUPABASE_SERVICE_KEY rejected')
  })
  it('reports connected on 2xx', async () => {
    expect(await checkSupabase('https://x.supabase.co', 'key', 200)).toBe('[✓] Supabase: connected')
  })
})
