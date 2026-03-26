// remote-show — display remote config and connectivity status.

import { Command } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'

type FetchResult =
  | { kind: 'unreachable'; error: string }
  | { kind: 'auth-required' }
  | { kind: 'not-found' }
  | { kind: 'ok'; project: { id: string; name: string } }
  | { kind: 'error'; status: number }

async function probeRemote(baseUrl: string, projectId: string): Promise<FetchResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/store/projects/${projectId}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth-required' }
  if (res.status === 404) return { kind: 'not-found' }
  if (!res.ok) return { kind: 'error', status: res.status }
  const body = (await res.json()) as { id: string; name: string }
  return { kind: 'ok', project: body }
}

export default class RemoteShowCmd extends Command {
  static description = 'Show remote configuration and connection status'

  async run(): Promise<void> {
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))

    this.log(`Project:  ${config.project}  (${config.projectId})`)

    const remoteUrl = config.remote
    if (!remoteUrl) {
      this.log(`Remote:   (not configured)`)
      this.log(``)
      this.log(`Run: contextgit set-remote <url>`)
      return
    }

    this.log(`Remote:   ${remoteUrl}`)

    // Local stats
    const branches = await store.listBranches(config.projectId)
    let totalLocalCommits = 0
    for (const b of branches) {
      const commits = await store.listCommits(b.id, { limit: 10_000, offset: 0 })
      totalLocalCommits += commits.length
    }
    this.log(`Local:    ${branches.length} branch(es), ${totalLocalCommits} commit(s)`)

    // Connectivity check
    this.log(``)
    this.log(`Checking connection…`)
    const result = await probeRemote(remoteUrl, config.projectId)

    switch (result.kind) {
      case 'unreachable':
        this.log(`Status:   Unreachable`)
        this.log(`Error:    ${result.error}`)
        break

      case 'auth-required':
        this.log(`Status:   Connected (authentication required — API key not configured in CLI)`)
        break

      case 'not-found':
        this.log(`Status:   Connected, project not yet pushed`)
        this.log(`Tip:      Run 'contextgit push' to create the project on the remote.`)
        break

      case 'ok':
        this.log(`Status:   Connected`)
        this.log(`Remote project: ${result.project.name}`)
        break

      case 'error':
        this.log(`Status:   Error (HTTP ${result.status})`)
        break
    }
  }
}
