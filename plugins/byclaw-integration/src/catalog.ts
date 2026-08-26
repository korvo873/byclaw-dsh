/** Authorized ByClaw digital-employee and expert-group catalog loader. */

import { isByClawExpertGroupSnapshot, parseByClawDigitalEmployee, parseByClawExpertGroup } from './resources.ts'
import type {
  ByClawDigitalEmployee,
  ByClawExpertGroup,
  ByClawExpertGroupMember,
  ByClawExpertGroupRuntime,
} from './types.ts'

const DISCOVER_PATH = '/byaiService/api/v2/digitEmploy/discoverMine'
const RESOURCE_DETAIL_PATH = '/byaiService/digitalEmployeeController/findDetailsById'
const DISCOVER_BODY = {
  terminals: ['ALL', 'PC', 'APP'],
  keyword: '',
  metaStatus: 'ALL',
  orgFilters: [{ type: 'all' }],
  orderField: 'updateTime',
  orderBy: 'desc',
  language: 'zh-CN',
}

const ORCHESTRATOR_RUNTIME_PATH = '/byaiService/internal/v1/orchestrators/resolve-runtime'

/** Minimal Redis commands used by resource discovery. */
export interface ByClawCatalogRedis {
  get(key: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
}

export interface AuthorizedByClawResources {
  employees: ByClawDigitalEmployee[]
  groups: ByClawExpertGroup[]
  directEmployeeIds: string[]
  authHeaders: Record<string, string>
}

export interface LoadAuthorizedByClawResourcesOptions {
  redis: ByClawCatalogRedis
  userCode: string
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
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

function dataArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = record(payload)
  if (root === undefined) return []
  if (Array.isArray(root['data'])) return root['data']
  const data = record(root['data'])
  for (const key of ['records', 'list', 'rows']) {
    if (Array.isArray(data?.[key])) return data[key] as unknown[]
  }
  return []
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

async function loadResourceDetail(
  options: LoadAuthorizedByClawResourcesOptions,
  headers: Record<string, string>,
  resourceId: string,
): Promise<Record<string, unknown>> {
  const response = await (options.fetchImpl ?? fetch)(serviceUrl(options.baseUrl, RESOURCE_DETAIL_PATH), {
    method: 'POST',
    headers,
    body: JSON.stringify({ resourceId, language: 'zh-CN' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!response.ok) throw new Error(`ByClaw resource detail ${resourceId} failed with HTTP ${response.status}`)
  const detail = responseData(await response.json())
  const returnedId = requiredText(detail['resourceId'] ?? detail['id'], 'resourceId')
  if (returnedId !== resourceId) {
    throw new Error(`ByClaw resource detail returned ${returnedId}, expected ${resourceId}`)
  }
  return detail
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

async function authHeaders(redis: ByClawCatalogRedis, userCode: string): Promise<Record<string, string>> {
  const mappedUserId = text(await redis.get(`SHARE_BFM_USER_CODE_${userCode}`))
  if (mappedUserId === '') throw new Error(`ByClaw login auth was not found for userCode ${userCode}`)
  const auth = await redis.hgetall(`user:${mappedUserId}:login:auth`)
  const headers: Record<string, string> = { 'content-type': 'application/json', language: 'zh-CN' }
  for (const key of ['Beyond-Token', 'Sso-Token', 'WHALE_AGENT_AUTHORIZATION']) {
    const value = text(auth[key])
    if (value !== '') headers[key] = value
  }
  headers['X-User-Id'] = userCode
  if (headers['Beyond-Token'] === undefined) throw new Error(`ByClaw Beyond-Token was not found for userCode ${userCode}`)
  return headers
}

/** Discover caller-authorized resource IDs, then load current HTTP detail records. */
export async function loadAuthorizedByClawResources(
  options: LoadAuthorizedByClawResourcesOptions,
): Promise<AuthorizedByClawResources> {
  const userCode = options.userCode.trim()
  if (userCode === '') throw new Error('ByClaw userCode must not be empty')
  const baseUrl = options.baseUrl.replace(/\/+$/u, '')
  if (baseUrl === '') throw new Error('ByClaw baseUrl must not be empty')
  const headers = await authHeaders(options.redis, userCode)
  const response = await (options.fetchImpl ?? fetch)(serviceUrl(baseUrl, DISCOVER_PATH), {
    method: 'POST',
    headers,
    body: JSON.stringify(DISCOVER_BODY),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!response.ok) throw new Error(`ByClaw discoverMine failed with HTTP ${response.status}`)
  const discovered = dataArray(await response.json())
  const authorizedIds = [...new Set(discovered.flatMap((value) => {
    const item = record(value)
    if (item === undefined || item['usesPermissions'] !== true) return []
    const id = text(item['resourceId'] ?? item['id'])
    return id === '' ? [] : [id]
  }))]

  const employees: ByClawDigitalEmployee[] = []
  const groups: ByClawExpertGroup[] = []
  for (const id of authorizedIds) {
    const snapshot = await loadResourceDetail(options, headers, id)
    if (isByClawExpertGroupSnapshot(snapshot)) groups.push(parseByClawExpertGroup(snapshot))
    else employees.push(parseByClawDigitalEmployee(snapshot))
  }

  const directEmployeeIds = employees.map(employee => employee.id)
  const scan = (options.redis as unknown as {
    scan?: (cursor: string, ...args: string[]) => Promise<[string, string[]]>
  }).scan?.bind(options.redis)
  if (scan !== undefined) {
    const knownGroups = new Set(groups.map(group => group.id))
    const authorizedEmployees = new Set(directEmployeeIds)
    let cursor = '0'
    do {
      const page = await scan(cursor, 'MATCH', 'DIG_EMPLOYEE_*', 'COUNT', '200')
      cursor = page[0]
      for (const key of page[1]) {
        const raw = await options.redis.get(key)
        if (raw === null) continue
        let snapshot: unknown
        try { snapshot = JSON.parse(raw) as unknown } catch { continue }
        if (!isByClawExpertGroupSnapshot(snapshot)) continue
        const group = parseByClawExpertGroup(snapshot)
        if (knownGroups.has(group.id) || group.members.length === 0) continue
        if (group.members.every(member => authorizedEmployees.has(member.employeeId))) {
          const current = parseByClawExpertGroup(await loadResourceDetail(options, headers, group.id))
          groups.push(current)
          knownGroups.add(current.id)
        }
      }
    } while (cursor !== '0')
  }
  const loadedEmployeeIds = new Set(directEmployeeIds)
  for (const memberId of new Set(groups.flatMap(group => group.members.map(member => member.employeeId)))) {
    if (loadedEmployeeIds.has(memberId)) continue
    employees.push(parseByClawDigitalEmployee(await loadResourceDetail(options, headers, memberId)))
    loadedEmployeeIds.add(memberId)
  }

  return {
    employees: employees.sort((left, right) => left.name.localeCompare(right.name)),
    groups: groups.sort((left, right) => left.name.localeCompare(right.name)),
    directEmployeeIds,
    authHeaders: headers,
  }
}
