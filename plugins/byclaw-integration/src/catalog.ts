/** Authorized ByClaw digital-employee and expert-group catalog loader. */

import { isByClawExpertGroupSnapshot, parseByClawDigitalEmployee, parseByClawExpertGroup } from './resources.ts'
import {
  resolveByClawAuthorization,
  type ByClawAuthorizationRedis,
} from './resource-authorization.ts'
import type {
  ByClawDigitalEmployee,
  ByClawExpertGroup,
  ByClawExpertGroupMember,
  ByClawExpertGroupRuntime,
} from './types.ts'

const ORCHESTRATOR_RUNTIME_PATH = '/byaiService/internal/v1/orchestrators/resolve-runtime'

/** Minimal Redis commands used by resource discovery. */
export interface ByClawCatalogRedis extends ByClawAuthorizationRedis {}

export interface AuthorizedByClawResources {
  employees: ByClawDigitalEmployee[]
  groups: ByClawExpertGroup[]
  directEmployeeIds: string[]
  authHeaders: Record<string, string>
  authorization: {
    userId: string
    authKey: string
    resourceIds: string[]
  }
}

export interface LoadAuthorizedByClawResourcesOptions {
  redis: ByClawCatalogRedis
  userCode: string
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  snapshotConcurrency?: number
  excludedResourceIds?: ReadonlySet<string>
}

/** Inputs for resolving one expert group's own leader runtime. */
export interface LoadByClawExpertGroupRuntimeOptions {
  groupId: string
  baseUrl: string
  authHeaders: Record<string, string>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function requiredText(value: unknown, field: string): string {
  const parsed = text(value)
  if (parsed === '') throw new Error(`ByClaw response requires non-empty ${field}`)
  return parsed
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function responseData(payload: unknown): Record<string, unknown> {
  const root = record(payload)
  const data = record(root?.['data']) ?? root
  if (data === undefined) throw new Error('ByClaw response data must be an object')
  return data
}

function runtimeMembers(value: unknown): ByClawExpertGroupMember[] {
  if (!Array.isArray(value)) throw new Error('ByClaw resolve-runtime agents must be an array')
  return value.map((candidate, index) => {
    const agent = record(candidate)
    if (agent === undefined) throw new Error('ByClaw resolve-runtime agent must be an object')
    const employeeId = requiredText(agent['id'] ?? agent['resourceId'], 'agents[].id')
    const name = requiredText(agent['name'] ?? agent['resourceName'], 'agents[].name')
    const role = text(agent['teamRole'] ?? agent['role'])
    const description = text(agent['description'] ?? agent['resourceDesc'])
    return {
      employeeId,
      employeeCode: text(agent['resourceCode']) || `DIG_EMPLOYEE_${employeeId}`,
      name,
      ...role === '' ? {} : { role },
      ...description === '' ? {} : { description },
      order: index + 1,
    }
  })
}

function serviceUrl(baseUrl: string, path: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/u, '')}${path}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ByClaw baseUrl must use HTTP(S): ${baseUrl}`)
  }
  return url.toString()
}

/** Resolve the expert team's dedicated leader Prompt, model reference, and version. */
export async function loadByClawExpertGroupRuntime(
  options: LoadByClawExpertGroupRuntimeOptions,
): Promise<ByClawExpertGroupRuntime> {
  const groupId = options.groupId.trim()
  if (groupId === '') throw new Error('ByClaw expert-group id must not be empty')
  const response = await (options.fetchImpl ?? fetch)(
    serviceUrl(options.baseUrl, ORCHESTRATOR_RUNTIME_PATH),
    {
      method: 'POST',
      headers: options.authHeaders,
      body: JSON.stringify({
        schemaVersion: 'byclaw.orchestrator-runtime-request/v1',
        kind: 'EXPERT_TEAM',
        orchestratorId: groupId,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  )
  if (!response.ok) throw new Error(`ByClaw resolve-runtime failed with HTTP ${response.status}`)
  const data = responseData(await response.json())
  const orchestrator = record(data['orchestrator'])
  const prompt = record(data['prompt'])
  const model = record(data['model'])
  const returnedId = requiredText(orchestrator?.['id'], 'orchestrator.id')
  if (returnedId !== groupId) throw new Error(`ByClaw resolve-runtime returned group ${returnedId}, expected ${groupId}`)
  return {
    groupId,
    name: requiredText(orchestrator?.['name'], 'orchestrator.name'),
    prompt: requiredText(prompt?.['content'], 'prompt.content'),
    promptVersion: requiredText(prompt?.['version'], 'prompt.version'),
    contextProfile: requiredText(data['contextProfile'], 'contextProfile'),
    configVersion: requiredText(data['configVersion'], 'configVersion'),
    modelId: requiredText(model?.['modelId'], 'model.modelId'),
    members: runtimeMembers(data['agents']),
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(values[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

async function loadResourceSnapshot(
  redis: ByClawCatalogRedis,
  resourceId: string,
): Promise<Record<string, unknown>> {
  const raw = await redis.get(`DIG_EMPLOYEE_${resourceId}`)
  if (raw === null || raw.trim() === '') throw new Error(`ByClaw Redis resource ${resourceId} was not found`)
  let snapshot: unknown
  try {
    snapshot = JSON.parse(raw) as unknown
  } catch (error: unknown) {
    throw new Error(`ByClaw Redis resource ${resourceId} is not valid JSON`, { cause: error })
  }
  const parsed = record(snapshot)
  if (parsed === undefined) throw new Error(`ByClaw Redis resource ${resourceId} must be an object`)
  const returnedId = requiredText(parsed['resourceId'] ?? parsed['id'], 'resourceId')
  if (returnedId !== resourceId) {
    throw new Error(`ByClaw Redis resource returned ${returnedId}, expected ${resourceId}`)
  }
  return parsed
}

/** Load caller-authorized Redis snapshots and supplementary expert-group members by exact ID. */
export async function loadAuthorizedByClawResources(
  options: LoadAuthorizedByClawResourcesOptions,
): Promise<AuthorizedByClawResources> {
  const userCode = options.userCode.trim()
  if (userCode === '') throw new Error('ByClaw userCode must not be empty')
  const concurrency = options.snapshotConcurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('ByClaw snapshotConcurrency must be a positive integer')
  }
  const authorization = await resolveByClawAuthorization(options.redis, userCode)
  const effectiveResourceIds = authorization.resourceIds.filter(id => !options.excludedResourceIds?.has(id))
  const snapshots = await mapConcurrent(
    effectiveResourceIds,
    concurrency,
    id => loadResourceSnapshot(options.redis, id),
  )

  const employees: ByClawDigitalEmployee[] = []
  const groups: ByClawExpertGroup[] = []
  for (const snapshot of snapshots) {
    if (isByClawExpertGroupSnapshot(snapshot)) groups.push(parseByClawExpertGroup(snapshot))
    else employees.push(parseByClawDigitalEmployee(snapshot))
  }

  const directEmployeeIds = employees.map(employee => employee.id)
  const directlyLoadedIds = new Set(effectiveResourceIds)
  const supplementaryMemberIds = [...new Set(groups.flatMap(group => group.members.map(member => member.employeeId)))]
    .filter(memberId => !directlyLoadedIds.has(memberId) && !options.excludedResourceIds?.has(memberId))
  const supplementarySnapshots = await mapConcurrent(
    supplementaryMemberIds,
    concurrency,
    id => loadResourceSnapshot(options.redis, id),
  )
  for (const snapshot of supplementarySnapshots) {
    if (isByClawExpertGroupSnapshot(snapshot)) {
      throw new Error(`ByClaw expert-group member ${requiredText(snapshot['resourceId'], 'resourceId')} resolved to a group`)
    }
    employees.push(parseByClawDigitalEmployee(snapshot))
  }

  return {
    employees: employees.sort((left, right) => left.name.localeCompare(right.name)),
    groups: groups.sort((left, right) => left.name.localeCompare(right.name)),
    directEmployeeIds,
    authHeaders: authorization.authHeaders,
    authorization: {
      userId: authorization.userId,
      authKey: authorization.authKey,
      resourceIds: authorization.resourceIds,
    },
  }
}
