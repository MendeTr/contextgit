// remote-store.ts — resolve the correct remote ContextStore for push/pull.
//
// Priority:
//   1. --remote flag (always HTTP RemoteStore, bypasses everything)
//   2. config.supabaseUrl → SupabaseStore (requires SUPABASE_SERVICE_KEY env)
//   3. config.remote → RemoteStore (HTTP)
//   4. Neither → error

import { RemoteStore, SupabaseStore } from '@contextgit/store'
import type { ContextStore } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'

export function resolveRemoteStore(
  config: ContextGitConfig,
  remoteFlag?: string,
): ContextStore {
  // --remote flag always means HTTP RemoteStore, regardless of other config
  if (remoteFlag) return new RemoteStore(remoteFlag)

  // Supabase takes precedence over HTTP remote when both configured
  if (config.supabaseUrl) {
    const key = process.env['SUPABASE_SERVICE_KEY']
    if (!key) {
      throw new Error(
        'SUPABASE_SERVICE_KEY env var is required when supabaseUrl is configured.\n' +
        'Set it in your shell or Claude Code env config.',
      )
    }
    return new SupabaseStore(config.supabaseUrl, key)
  }

  if (config.remote) return new RemoteStore(config.remote)

  throw new Error(
    'No remote configured.\n' +
    'Run: contextgit set-remote supabase <url>  (Supabase)\n' +
    '  or: contextgit set-remote <url>          (self-hosted API)',
  )
}
