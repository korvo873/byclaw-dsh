/** Team-aware lifecycle barrier for long-lived and headless Harness surfaces. */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { findTeamByCaptain } from './state.ts'
import type { MemberStatus, TaskStatus, TeamLifecycle } from './types.ts'

export type TeamSettlement = 'active' | 'completed' | 'blocked'

interface SettlementView {
  lifecycle?: TeamLifecycle
  members: readonly { status: MemberStatus }[]
  tasks: readonly { id: string; status: TaskStatus; dependencies: readonly string[] }[]
}

export interface AgentTeamsLifecycleBarrier {
  waitForCaptain(
    captainSessionId: string,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<{ teamId?: string; settlement: 'no-team' | Exclude<TeamSettlement, 'active'> }>
}

/** Classify whether a DAG still has live/runnable work or has reached quiescence. */
export function classifyTeamSettlement(team: SettlementView): TeamSettlement {
  if (team.lifecycle === 'draft' || team.tasks.length === 0) return 'active'
  if (team.members.some(member => member.status === 'working')) return 'active'
  if (team.tasks.some(task => task.status === 'claimed' || task.status === 'in_progress')) return 'active'

  const byId = new Map(team.tasks.map(task => [task.id, task]))
  const hasRunnable = team.tasks.some(task => task.status === 'pending'
    && task.dependencies.every(dependency => byId.get(dependency)?.status === 'completed'))
  if (hasRunnable) return 'active'

  if (team.tasks.every(task => task.status === 'completed')) return 'completed'
  return 'blocked'
}

function abortError(): Error {
  const error = new Error('AgentTeams lifecycle wait aborted')
  error.name = 'AbortError'
  return error
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const aborted = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(abortError())
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/** Publish a barrier that lets one-shot surfaces keep child sessions alive. */
export function installAgentTeamsLifecycle(
  ctx: Context,
  stateDir: string,
  maxWaitMs = 30 * 60_000,
): void {
  const service: AgentTeamsLifecycleBarrier = {
    async waitForCaptain(captainSessionId, workspace, signal) {
      const stateRoot = join(workspace, stateDir)
      const deadline = Date.now() + maxWaitMs
      while (true) {
        const team = await findTeamByCaptain(stateRoot, captainSessionId)
        if (team === undefined) return { settlement: 'no-team' }
        const settlement = classifyTeamSettlement(team)
        if (settlement !== 'active') return { teamId: team.id, settlement }
        if (Date.now() >= deadline) {
          throw new Error(`AgentTeams team "${team.id}" did not settle within ${maxWaitMs}ms`)
        }
        await pause(100, signal)
      }
    },
  }
  ctx.provide('agentTeamsLifecycle' as never, service as never)
}
