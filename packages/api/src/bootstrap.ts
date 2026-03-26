// bootstrap.ts — shared setup: load config, open store, detect git branch, init engine.

import os from 'os'
import { simpleGit } from 'simple-git'
import { ContextEngine } from '@contextgit/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import type { ContextStore } from '@contextgit/store'
import { loadConfig } from './config.js'

export interface ApiContext {
  engine: ContextEngine
  store: ContextStore
  projectId: string
  branchId: string
}

async function detectGitBranch(): Promise<string> {
  try {
    const git = simpleGit(process.cwd())
    const result = await git.revparse(['--abbrev-ref', 'HEAD'])
    return result.trim()
  } catch {
    return 'main'
  }
}

async function resolveContextBranch(
  store: ContextStore,
  projectId: string,
  gitBranch: string,
): Promise<string> {
  const existing = await store.getBranchByGitName(projectId, gitBranch)
  if (existing) return existing.id

  const created = await store.createBranch({
    projectId,
    name: `Context: ${gitBranch}`,
    gitBranch,
  })
  return created.id
}

export async function bootstrap(): Promise<ApiContext> {
  const config = loadConfig()
  const { projectId, configDir } = config

  const store = new LocalStore(projectId, resolveDbPath(projectId, configDir))
  const gitBranch = await detectGitBranch()
  const branchId = await resolveContextBranch(store, projectId, gitBranch)

  const hostname = os.hostname()
  const agentId = `${hostname}-api-server`

  const engine = new ContextEngine(
    store,
    agentId,
    config.agentRole ?? 'solo',
    'contextgit-api',
    config.workflowType ?? 'interactive',
  )
  await engine.init(projectId, branchId)

  return { engine, store, projectId, branchId }
}
