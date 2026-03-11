// bootstrap.ts — shared setup for commit/context commands.
// Loads config, opens LocalStore, detects git branch, initializes ContextEngine.

import os from 'os'
import { simpleGit } from 'simple-git'
import { ContextEngine } from '@contextgit/core'
import { LocalStore, RemoteStore } from '@contextgit/store'
import type { ContextStore } from '@contextgit/store'
import { loadConfig } from './config.js'

export interface CliContext {
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

export async function bootstrap(): Promise<CliContext> {
  const config = loadConfig()
  const { projectId } = config

  const store: ContextStore =
    config.store && config.store !== 'local'
      ? new RemoteStore(config.store)
      : new LocalStore(projectId)
  const gitBranch = await detectGitBranch()
  const branchId = await resolveContextBranch(store, projectId, gitBranch)

  const hostname = os.hostname()
  const agentId = `${hostname}-cli-interactive`

  const engine = new ContextEngine(
    store,
    agentId,
    config.agentRole ?? 'solo',
    'contextgit-cli',
    config.workflowType ?? 'interactive',
  )
  await engine.init(projectId, branchId)

  return { engine, store, projectId, branchId }
}
