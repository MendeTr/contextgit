// search — full-text search over context commits.

import { Command, Flags } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class SearchCmd extends Command {
  static description = 'Search context commits with full-text search'

  static flags = {
    query: Flags.string({
      char: 'q',
      description: 'Search query',
      required: true,
    }),
    limit: Flags.integer({
      char: 'l',
      description: 'Maximum results to show',
      default: 5,
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SearchCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))

    const results = await store.fullTextSearch(flags.query, config.projectId)
    const trimmed = results.slice(0, flags.limit)

    if (flags.json) {
      this.log(JSON.stringify(trimmed, null, 2))
      return
    }

    if (trimmed.length === 0) {
      this.log(`No results for: ${flags.query}`)
      return
    }

    this.log(`Found ${trimmed.length} result(s) for: "${flags.query}"\n`)
    for (const r of trimmed) {
      const ts = new Date(r.commit.createdAt).toLocaleString()
      this.log(`[${r.matchType}] ${r.commit.message}`)
      this.log(`  ID: ${r.commit.id}  |  ${ts}`)
      this.log(`  ${r.commit.content.slice(0, 120).replace(/\n/g, ' ')}`)
      this.log('')
    }
  }
}
