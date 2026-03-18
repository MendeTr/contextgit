import { describe, it, expect, vi } from 'vitest'
import { resolveRemoteStore } from './remote-store.js'
import { SupabaseStore } from '@contextgit/store'
import { RemoteStore } from '@contextgit/store'

vi.mock('@contextgit/store', () => ({
  SupabaseStore: vi.fn(),
  RemoteStore: vi.fn(),
  LocalStore: vi.fn(),
}))

describe('resolveRemoteStore', () => {
  const baseConfig = { projectId: 'p1', project: 'test', store: 'local',
                       agentRole: 'solo', workflowType: 'interactive',
                       autoSnapshot: false, snapshotInterval: 30,
                       embeddingModel: 'local' } as const

  it('uses SupabaseStore when supabaseUrl is set and key is in env', () => {
    process.env['SUPABASE_SERVICE_KEY'] = 'test-key'
    resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' })
    expect(SupabaseStore).toHaveBeenCalledWith('https://x.supabase.co', 'test-key')
    delete process.env['SUPABASE_SERVICE_KEY']
  })

  it('throws when supabaseUrl is set but SUPABASE_SERVICE_KEY is missing', () => {
    delete process.env['SUPABASE_SERVICE_KEY']
    expect(() => resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' }))
      .toThrow('SUPABASE_SERVICE_KEY')
  })

  it('uses RemoteStore when --remote flag is passed (always HTTP, regardless of supabaseUrl)', () => {
    process.env['SUPABASE_SERVICE_KEY'] = 'key'
    resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' }, 'https://api.example.com')
    expect(RemoteStore).toHaveBeenCalledWith('https://api.example.com')
    delete process.env['SUPABASE_SERVICE_KEY']
  })

  it('uses RemoteStore when config.remote is set and supabaseUrl is absent', () => {
    resolveRemoteStore({ ...baseConfig, remote: 'https://api.example.com' })
    expect(RemoteStore).toHaveBeenCalledWith('https://api.example.com')
  })

  it('throws when no remote is configured at all', () => {
    expect(() => resolveRemoteStore(baseConfig)).toThrow('No remote configured')
  })
})
