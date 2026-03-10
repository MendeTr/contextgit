// init — create .contexthub/config.json + project + branch in LocalStore.

import { Command, Flags } from '@oclif/core'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'
import { LocalStore } from '@contexthub/store'
import type { ContextHubConfig } from '@contexthub/core'

export default class Init extends Command {
  static description = 'Initialize ContextHub in this project'

  static flags = {
    name: Flags.string({
      char: 'n',
      description: 'Project name (defaults to current directory name)',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    const cwd = process.cwd()
    const configPath = join(cwd, '.contexthub', 'config.json')

    if (existsSync(configPath)) {
      this.log('ContextHub already initialized. Config found at .contexthub/config.json')
      return
    }

    const projectName = flags.name ?? basename(cwd)
    const projectId = nanoid()

    // Open store (creates DB + runs migrations).
    // Pass the same projectId so the DB path key matches the project entity's
    // ID used in all foreign keys throughout the store.
    const store = new LocalStore(projectId)
    await store.createProject({ id: projectId, name: projectName })

    // Detect current git branch for the initial context branch
    let gitBranch = 'main'
    try {
      const git = simpleGit(cwd)
      gitBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    } catch {
      // fallback to 'main'
    }

    await store.createBranch({
      projectId,
      name: `Context: ${gitBranch}`,
      gitBranch,
    })

    // Write config
    mkdirSync(join(cwd, '.contexthub'), { recursive: true })
    const config: ContextHubConfig = {
      project: projectName,
      projectId,
      store: 'local',
      agentRole: 'solo',
      workflowType: 'interactive',
      autoSnapshot: false,
      snapshotInterval: 10,
      embeddingModel: 'local',
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

    this.log(`Initialized ContextHub for project: ${projectName}`)
    this.log(`Project ID:  ${projectId}`)
    this.log(`Branch:      ${gitBranch}`)
    this.log(`Config:      .contexthub/config.json`)
    this.log(`DB:          ~/.contexthub/projects/${projectId}.db`)
  }
}
