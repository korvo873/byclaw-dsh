/** Independent ByClaw adapter plugin for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  GatewayDataEmitter,
  createRedis,
} from '@byclaw/by-framework'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultCatalogDir } from '@byclaw/dsh-agent-teams/catalog'
import { defaultAgentTemplateDir } from './agent-template.ts'
import { loadAuthorizedByClawResources, type AuthorizedByClawResources } from './catalog.ts'
import { ByClawGenerationLease } from './generation-lease.ts'
import { defaultByClawSkillCache, projectByClawResourcesToTemplates } from './integration.ts'
import {
  BYCLAW_DSH_AGENT_TYPE,
  DEFAULT_BYCLAW_BE_BASE_URL,
} from './protocol.ts'
import { ByClawDshSessionRuntime } from './session-runtime.ts'
import { registerAgentTemplateRuntime } from './template-runtime.ts'
import { resolveByClawInboundTarget } from './inbound-routing.ts'
import {
  ByClawResourceWatch,
} from './resource-watch.ts'
import { registerByClawSessionEventType } from './session-workspace.ts'
import { ByClawDshWorkerRuntime } from './worker-runtime.ts'
import {
  BYCLAW_REDIS_MODEL_ENABLED_ENV,
  ByClawDynamicModelRuntime,
  resolveByClawRedisModelsEnabled,
} from './model-runtime.ts'

export { BYCLAW_DSH_AGENT_TYPE, DEFAULT_BYCLAW_BE_BASE_URL }
export * from './types.ts'
export * from './session-workspace.ts'
export * from './inbound-routing.ts'
export {
  BYCLAW_REDIS_MODEL_ENABLED_ENV,
  ByClawDynamicModelRuntime,
  byClawProviderKey,
  byClawPrologueModelId,
  decryptByClawAuthToken,
  resolveByClawRedisModelsEnabled,
} from './model-runtime.ts'
export type { ByClawModelFallback, ByClawModelRuntimeOptions, ByClawModelSelection } from './model-runtime.ts'

export const name = 'byclaw-dsh'
export const inject = ['agentPresets', 'agents', 'llm', 'sessionPersistence', 'subagents', 'tools', 'systemPrompt']

export interface Config {
  enabled?: boolean
  userCode?: string
  baseUrl?: string
  catalogDir?: string
  agentTemplateDir?: string
  skillCacheDir?: string
  workspace?: string
  stateDir?: string
  provider?: string
  model?: string
  workerId?: string
  agentTypes?: string[]
  maxConcurrency?: number
  refreshChannel?: string
  authorizationPollMs?: number
  authorizationPollOnlyMs?: number
  authorizationMissingGraceMs?: number
  resourceDebounceMs?: number
  snapshotConcurrency?: number
  projectionConcurrency?: number
  subagentProvider?: string
  agentPreset?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  userCode: z.string(),
  baseUrl: z.string().default(DEFAULT_BYCLAW_BE_BASE_URL),
  catalogDir: z.string(),
  agentTemplateDir: z.string(),
  skillCacheDir: z.string(),
  workspace: z.string(),
  stateDir: z.string().default('.agent-teams'),
  provider: z.string(),
  model: z.string(),
  workerId: z.string(),
  agentTypes: z.array(z.string()).default(undefined as unknown as string[]),
  maxConcurrency: z.natural().min(1).default(8),
  refreshChannel: z.string().default('byai:pub:dig_employee_change'),
  authorizationPollMs: z.natural().min(1).default(5_000),
  authorizationPollOnlyMs: z.natural().min(1).default(2_000),
  authorizationMissingGraceMs: z.natural().min(1).default(15_000),
  resourceDebounceMs: z.natural().min(1).default(250),
  snapshotConcurrency: z.natural().min(1).default(8),
  projectionConcurrency: z.natural().min(1).default(8),
  subagentProvider: z.string().default('spawn'),
  agentPreset: z.string().default('standard'),
})

/** Compact specialist identity exposed to the main Agent for routing only. */
export interface ByClawRoutingEmployee {
  id: string
  code: string
  name: string
  description: string
  template_id: string
  invocation: 'ordinary-child-agent'
}

/** Compact expert-team identity exposed to the main Agent for routing only. */
export interface ByClawRoutingGroup {
  id: string
  code: string
  name: string
  description: string
  template_id: string
  invocation: 'expert-team-leader-agent'
  members: Array<{ id: string; name: string; role?: string }>
}

function compactRoutingText(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499).trimEnd()}…`
}

/** Main-Agent routing catalog; child Skills, tools, prompts, and model details are intentionally absent. */
export function resourceRoutingCatalog(resources: AuthorizedByClawResources): {
  worker_type: typeof BYCLAW_DSH_AGENT_TYPE
  employees: ByClawRoutingEmployee[]
  groups: ByClawRoutingGroup[]
} {
  const direct = new Set(resources.directEmployeeIds)
  return {
    worker_type: BYCLAW_DSH_AGENT_TYPE,
    employees: resources.employees.filter(employee => direct.has(employee.id)).map(employee => ({
      id: employee.id,
      code: employee.code,
      name: employee.name,
      description: compactRoutingText(employee.description || employee.capabilities),
      template_id: `byclaw-employee-${employee.id}`,
      invocation: 'ordinary-child-agent',
    })),
    groups: resources.groups.map(group => ({
      id: group.id,
      code: group.code,
      name: group.name,
      description: compactRoutingText(group.description),
      template_id: `byclaw-group-${group.id}`,
      invocation: 'expert-team-leader-agent',
      members: group.members.map(member => ({
        id: member.employeeId,
        name: member.name,
        ...member.role === undefined ? {} : { role: member.role },
      })),
    })),
  }
}

/** Build the main-agent routing and temporary-team lifecycle policy. */
export function rosterPrompt(resources: AuthorizedByClawResources): string {
  const catalog = resourceRoutingCatalog(resources)
  return [
    'ByClaw authorized resource routing:',
    'Before listing or routing work, call byclaw_list_resources so dynamic authorization and template versions are current.',
    'For one specialist, call byclaw_instantiate_template with byclaw-employee-<resourceId>. A single employee is one ordinary child Agent; never create AgentTeams for it.',
    'For an expert group, call byclaw_instantiate_template with byclaw-group-<resourceId>. This creates the group\'s own leader Agent; that leader, not you and not its first member, orchestrates the configured roster.',
    'Use AgentTeams directly only for a genuinely ad-hoc multi-agent collaboration assembled for one complex task.',
    '临时 AgentTeams 在汇总结果后立即 agent_teams_delete；删除运行团队不删除 DSH 父子会话历史。只有用户明确要求继续协作时才保留团队。',
    '',
    'Authorized standalone digital employees:',
    ...catalog.employees.map(employee => `- ${employee.name} (${employee.id}): ${employee.description || '未提供能力描述'}`),
    'Authorized expert groups:',
    ...catalog.groups.map(group => `- ${group.name} (${group.id}): ${group.description || '专家团'}；成员 ${group.members.map(member => `${member.name}/${member.role ?? '成员'}`).join('、')}`),
  ].join('\n')
}

function workerId(configured: string | undefined, userCode: string): string {
  const value = configured?.trim()
  return value === undefined || value === ''
    ? `byclaw-dsh-${hostname()}-${process.pid}-${userCode}`
    : value
}

/** Resolve the exact by-framework AgentTypes consumed by this Worker. */
export function resolveWorkerAgentTypes(configured: readonly string[] | undefined, userCode: string): string[] {
  if (configured === undefined) return [BYCLAW_DSH_AGENT_TYPE, `${BYCLAW_DSH_AGENT_TYPE}_${userCode}`]
  const values = [...new Set(configured.map(value => value.trim()).filter(value => value !== ''))]
  if (values.length === 0) throw new Error('byclaw-dsh config.agentTypes requires at least one non-empty AgentType')
  return values
}

/** Activate resource synchronization and the by-framework Worker. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled !== true) return
  registerByClawSessionEventType()
  const userCode = config.userCode?.trim() || process.env['USER_CODE']?.trim()
  if (userCode === undefined || userCode === '') throw new Error('byclaw-dsh requires config.userCode or USER_CODE')
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BYCLAW_BE_BASE_URL
  const catalogDir = resolve(config.catalogDir?.trim() || defaultCatalogDir())
  const agentTemplateDir = resolve(config.agentTemplateDir?.trim() || defaultAgentTemplateDir())
  const skillCacheDir = resolve(config.skillCacheDir?.trim() || defaultByClawSkillCache(agentTemplateDir))
  const workspace = resolve(config.workspace?.trim() || process.cwd())
  const redisModelsEnabled = resolveByClawRedisModelsEnabled(process.env[BYCLAW_REDIS_MODEL_ENABLED_ENV])

  const generationLease = new ByClawGenerationLease()
  let closeRuntime = (): Promise<void> => generationLease.close()
  // AgentTeams reads this service while the provider fiber is unloading, so
  // one composite effect drains runtime work before removing the registration.
  ctx.effect(function* () {
    yield ctx.provide('byclawGenerationLease', generationLease)
    yield () => closeRuntime()
  }, 'byclaw-dsh.lifecycle')
  const redis = createRedis()
  const refreshChannel = config.refreshChannel ?? 'byai:pub:dig_employee_change'
  let models: ByClawDynamicModelRuntime
  let resources: AuthorizedByClawResources
  let sessions: ByClawDshSessionRuntime | undefined
  let worker: ByClawDshWorkerRuntime | undefined
  let resourceWatch: ByClawResourceWatch | undefined
  let acceptingRefresh = true
  let refresh: Promise<AuthorizedByClawResources | undefined> = Promise.resolve(undefined)
  let disposed = false
  const deletedResourceIds = new Set<string>()
  const close = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    acceptingRefresh = false
    const failures: unknown[] = []
    const settle = async (operation: (() => Promise<unknown>) | undefined): Promise<void> => {
      if (operation === undefined) return
      try { await operation() } catch (error: unknown) { failures.push(error) }
    }
    await settle(resourceWatch === undefined ? undefined : () => resourceWatch?.close() ?? Promise.resolve())
    await settle(() => generationLease.close())
    await settle(() => refresh)
    await settle(worker === undefined ? undefined : () => worker?.close() ?? Promise.resolve())
    await settle(sessions === undefined ? undefined : () => sessions?.close() ?? Promise.resolve())
    await settle(() => redis.quit())
    if (failures.length > 0) throw new AggregateError(failures, 'byclaw-dsh resource disposal failed')
  }
  closeRuntime = close
  const synchronize = (): Promise<AuthorizedByClawResources> => {
    if (!acceptingRefresh) return Promise.reject(new Error('byclaw-dsh resource refresh rejected during disposal'))
    const operation = refresh.then(async () => {
      const next = await loadAuthorizedByClawResources({
        redis,
        userCode,
        baseUrl,
        snapshotConcurrency: config.snapshotConcurrency ?? 8,
        excludedResourceIds: deletedResourceIds,
      })
      await projectByClawResourcesToTemplates({
        resources: next,
        agentTemplateDir,
        teamCatalogDir: catalogDir,
        cacheRoot: skillCacheDir,
        baseUrl,
        generationLease,
        projectionConcurrency: config.projectionConcurrency ?? 8,
        resolveModel: (bindingId, modelId) => models.resolve(bindingId, modelId),
      })
      resources = next
      resourceWatch?.updateWatchedResources(new Set([
        ...next.employees.map(employee => employee.id),
        ...next.groups.map(group => group.id),
        ...next.groups.flatMap(group => group.members.map(member => member.employeeId)),
      ]))
      return next
    })
    refresh = operation.catch(() => undefined)
    return operation
  }
  const synchronizeOrRetain = async (): Promise<void> => {
    try {
      await synchronize()
    } catch (error: unknown) {
      ctx.logger.warn(`byclaw-dsh resource refresh failed; retaining last-good templates and Skills: ${String(error)}`)
    }
  }
  try {
    await redis.ping()
    models = new ByClawDynamicModelRuntime(ctx, redis, {
      provider: config.provider,
      model: config.model,
      redisModelsEnabled,
    })

    resources = await synchronize()
    ctx.logger.info(`byclaw-dsh cold-start synchronization complete: employees=${resources.employees.length}; groups=${resources.groups.length}`)

    resourceWatch = new ByClawResourceWatch({
      redis,
      userCode,
      channel: refreshChannel,
      pollMs: config.authorizationPollMs ?? 5_000,
      pollOnlyMs: config.authorizationPollOnlyMs ?? 2_000,
      missingGraceMs: config.authorizationMissingGraceMs ?? 15_000,
      debounceMs: config.resourceDebounceMs ?? 250,
      logger: ctx.logger,
      onAuthorizationChange: async authorization => {
        const previousAuthorization = new Set(resources.authorization.resourceIds)
        const nextAuthorization = new Set(authorization.resourceIds)
        for (const resourceId of deletedResourceIds) {
          if (!nextAuthorization.has(resourceId)) deletedResourceIds.delete(resourceId)
        }
        for (const resourceId of nextAuthorization) {
          if (!previousAuthorization.has(resourceId)) deletedResourceIds.delete(resourceId)
        }
        await synchronize()
      },
      onResourceChange: async changes => {
        for (const change of changes) {
          if (change.eventType === 'DIG_EMPLOYEE_DELETED') deletedResourceIds.add(change.resourceId)
          else deletedResourceIds.delete(change.resourceId)
        }
        await synchronize()
      },
    })
    resourceWatch.updateWatchedResources(new Set([
      ...resources.employees.map(employee => employee.id),
      ...resources.groups.map(group => group.id),
      ...resources.groups.flatMap(group => group.members.map(member => member.employeeId)),
    ]))
    await resourceWatch.start(resources.authorization)

    const templateRuntime = registerAgentTemplateRuntime(ctx, {
      catalogDir: agentTemplateDir,
      subagentProvider: config.subagentProvider ?? 'spawn',
      resolveModel: (bindingId, modelId) => models.resolve(bindingId, modelId),
      beforeInstantiate: synchronizeOrRetain,
      generationLease,
      generationCatalogDir: catalogDir,
      maxDepth: 2,
    })

    ctx.tools.register(defineTool({
      name: 'byclaw_list_resources',
      description: 'List the current user-authorized ByClaw digital employees and expert groups as a compact routing catalog. Always call this before answering availability or routing questions. Child Skills and tools load only after template instantiation.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.json }],
      },
      execute: async () => {
        await synchronizeOrRetain()
        return { json: JSON.stringify(resourceRoutingCatalog(resources)) }
      },
    }))

    const agentTypes = resolveWorkerAgentTypes(config.agentTypes, userCode)
    const sourceAgentType = agentTypes[0] as string
    const emitter = new GatewayDataEmitter(redis)
    sessions = new ByClawDshSessionRuntime(ctx, {
      workspace,
      stateDir: config.stateDir ?? '.agent-teams',
      agentTemplateDir,
      agentPreset: config.agentPreset?.trim() || 'standard',
      resolveModel: bindingId => models.resolve(bindingId),
      rosterPrompt: () => rosterPrompt(resources),
      sourceAgentType,
      emitter,
      resolveInboundTarget: (command, text) => resolveByClawInboundTarget(resources, command.extraPayload, text),
      templateRuntime,
    })
    const id = workerId(config.workerId, userCode)
    worker = new ByClawDshWorkerRuntime({
      redis,
      workerId: id,
      agentTypes,
      sessions,
      maxConcurrency: config.maxConcurrency ?? 8,
    })
    await worker.start(id)

    ctx.logger.info(`byclaw-dsh Worker online: ${agentTypes.join(',')}; BE=${baseUrl}; agentTemplates=${join(agentTemplateDir, 'templates')}; teams=${join(catalogDir, 'templates')}`)

  } catch (error: unknown) {
    try {
      await close()
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'byclaw-dsh setup and cleanup failed')
    }
    throw error
  }
}
