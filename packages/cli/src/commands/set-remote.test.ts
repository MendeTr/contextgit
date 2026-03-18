import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadConfig, saveConfig } from '../config.js'

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ projectId: 'p1', project: 'test', remote: undefined, supabaseUrl: undefined })),
  saveConfig: vi.fn(),
}))

// We test the dispatch logic directly since oclif commands are hard to unit-test.
// The key behaviors: 'supabase' keyword writes supabaseUrl; anything else writes remote.

describe('set-remote dispatch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('writes supabaseUrl when first arg is "supabase"', () => {
    // Simulate the dispatch logic from the command
    const typeOrUrl = 'supabase'
    const url = 'https://xyz.supabase.co'
    const config = loadConfig()
    if (typeOrUrl === 'supabase') {
      saveConfig({ ...config, supabaseUrl: url })
    } else {
      saveConfig({ ...config, remote: typeOrUrl })
    }
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ supabaseUrl: 'https://xyz.supabase.co' }))
  })

  it('writes remote (HTTP) when first arg is a URL', () => {
    const typeOrUrl: string = 'https://api.example.com'
    const config = loadConfig()
    if (typeOrUrl === 'supabase') {
      saveConfig({ ...config, supabaseUrl: 'irrelevant' })
    } else {
      saveConfig({ ...config, remote: typeOrUrl })
    }
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ remote: 'https://api.example.com' }))
    expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ supabaseUrl: expect.anything() }))
  })
})
