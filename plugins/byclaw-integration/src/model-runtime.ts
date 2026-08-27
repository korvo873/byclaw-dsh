/** Dynamic ByClaw AI-model resolution and DSH LLM route registration. */

import { createDecipheriv } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { resolveRetryPolicy, type AdapterRegistrationHandle, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  createProvider,
  defaultProviderAuthContext,
  InMemoryCredentialStore,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type ThinkingBudgets,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

const AIMODEL_CONFIG_KEY = 'byai:aimodel:config'
const AIMODEL_TYPELIST_KEY = 'byai:aimodel:typelist'
const AIMODEL_TYPELIST_FIELD = 'LLM'
const AUTH_TOKEN_SM4_KEY_ENV = 'BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX'
export const BYCLAW_REDIS_MODEL_ENABLED_ENV = 'BYCLAW_REDIS_MODEL_ENABLED'
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const PROVIDER_PREFIX = 'baiying-m-'

type ByClawModelProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

interface ByClawModelRedis {
  hget(key: string, field: string): Promise<string | null>
}

interface AiModelRecord {
  authToken?: unknown
  instanceId?: unknown
  instanceParam?: unknown
  isDefault?: unknown
  maxContentToken?: unknown
  modelCode?: unknown
  modelName?: unknown
  modelType?: unknown
  status?: unknown
  url?: unknown
}

interface MaterializedModel {
  selection: ByClawModelSelection
  profile: ResolvedPiAiProviderProfile
  token: string
}

/** Non-secret diagnostic attached to one resolved model selection. */
export interface ByClawModelSelection extends ModelSelection {
  sourceModelId?: string
  protocol?: ByClawModelProtocol
  resolution: 'explicit' | 'default' | 'last-good' | 'fallback' | 'local'
}

/** Static deployment fallback used only when Redis and last-good resolution are unavailable. */
export interface ByClawModelFallback {
  provider?: string
  model?: string
}

/** Model-source options resolved once when the integration starts. */
export interface ByClawModelRuntimeOptions extends ByClawModelFallback {
  /** Whether runtime bindings may read and register Redis AI-model routes. */
  redisModelsEnabled?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function numericFlag(value: unknown): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Parse the deployment switch that selects Redis or local DSH models. */
export function resolveByClawRedisModelsEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (normalized === '' || ['true', '1', 'on', 'yes'].includes(normalized)) return true
  if (['false', '0', 'off', 'no'].includes(normalized)) return false
  throw new Error(`${BYCLAW_REDIS_MODEL_ENABLED_ENV} must be true/false, 1/0, on/off, or yes/no`)
}

/** Match baiying-enhance's stable provider route derivation. */
export function byClawProviderKey(modelId: string): string {
  const trimmed = modelId.trim()
  const unsigned = trimmed.startsWith('-') ? `neg-${trimmed.slice(1)}` : trimmed
  const normalized = unsigned.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown'
  return `${PROVIDER_PREFIX}${normalized}`
}

/** Read `prologue.modelId` from a string or object exactly as baiying-enhance does. */
export function byClawPrologueModelId(value: unknown): string | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  let prologue: unknown = source['prologue']
  if (typeof prologue === 'string' && prologue.trim() !== '') {
    try { prologue = JSON.parse(prologue) as unknown } catch { return undefined }
  }
  const id = text(record(prologue)?.['modelId'])
  return id === '' ? undefined : id
}

/** Decrypt a baiying-enhance SM4 token when the shared key is configured. */
export function decryptByClawAuthToken(token: string): string {
  const keyHex = process.env[AUTH_TOKEN_SM4_KEY_ENV]?.trim() ?? ''
  if (!/^[0-9a-fA-F]{32}$/u.test(keyHex)) return token
  try {
    const cipher = Buffer.from(token, 'base64')
    if (cipher.length === 0 || cipher.length % 16 !== 0) return token
    const decipher = createDecipheriv('sm4-ecb', Buffer.from(keyHex, 'hex'), null)
    return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8').trim() || token
  } catch {
    return token
  }
}

function protocolOf(instanceParam: Record<string, unknown>): ByClawModelProtocol {
  for (const candidate of [text(instanceParam['providerName']), text(instanceParam['modelProtocol'])]) {
    switch (candidate.toLowerCase()) {
      case 'anthropic': return 'anthropic-messages'
      case 'openai-responses':
      case 'openai responses':
      case 'responses': return 'openai-responses'
      case 'openai': return 'openai-completions'
    }
  }
  return 'openai-completions'
}

function apiOf(protocol: ByClawModelProtocol): ProviderStreams {
  switch (protocol) {
    case 'anthropic-messages': return anthropicMessagesApi()
    case 'openai-responses': return openAIResponsesApi()
    case 'openai-completions': return openAICompletionsApi()
  }
}

const THINKING_LEVELS = new Set<ModelThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function thinkingLevel(value: unknown, fallback: ModelThinkingLevel): ModelThinkingLevel {
  const normalized = text(value).toLowerCase() as ModelThinkingLevel
  return THINKING_LEVELS.has(normalized) ? normalized : fallback
}

/** Translate ByClaw reasoning metadata into the model fields consumed by pi-ai. */
export function byClawReasoningFields(instanceParam: Record<string, unknown>): {
  reasoning: boolean
  defaultLevel?: ModelThinkingLevel
  thinkingLevelMap?: ThinkingLevelMap
  thinkingBudgets?: ThinkingBudgets
  compat?: Model<Api>['compat']
} {
  const raw = record(instanceParam['reasoningConfig']) ?? {}
  const capability = text(raw['capability']).toLowerCase()
  const enabled = raw['enabled'] === true && capability !== '' && capability !== 'unsupported'
  if (!enabled) return { reasoning: false }
  const defaultLevel = thinkingLevel(raw['defaultLevel'], 'medium')
  const supported = Array.isArray(raw['supportedEfforts']) ? raw['supportedEfforts'] : []
  const effortMap = record(raw['effortMap']) ?? {}
  const thinkingLevelMap: ThinkingLevelMap = { off: defaultLevel === 'off' ? null : defaultLevel }
  for (const effort of supported) {
    const level = thinkingLevel(effort, 'off')
    if (level === 'off') continue
    thinkingLevelMap[level] = thinkingLevel(effortMap[String(effort).toLowerCase()], level) as ThinkingLevel
  }
  const budgets: ThinkingBudgets = {}
  for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
    const budget = positiveInt(record(raw['budgets'])?.[level])
    if (budget !== undefined) budgets[level] = budget
  }
  const format = text(raw['compatFormat']).toLowerCase()
  const supportedFormat = ['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template'].includes(format)
    ? format === 'qwen-chat-template' ? 'qwen-chat-template' : format
    : undefined
  const compat = {
    supportsDeveloperRole: raw['supportsDeveloperRole'] === true,
    ...(supportedFormat === undefined ? {} : { thinkingFormat: supportedFormat }),
    supportsReasoningEffort: supported.length > 0,
  } as Model<Api>['compat']
  return {
    reasoning: true,
    defaultLevel,
    thinkingLevelMap,
    ...Object.keys(budgets).length === 0 ? {} : { thinkingBudgets: budgets },
    compat,
  }
}

function retryPolicy(instanceParam: Record<string, unknown>, route: string) {
  const maxRetries = positiveInt(instanceParam['maxRetries'])
  const retrySeconds = positiveInt(instanceParam['retryIntervalSec'])
  return resolveRetryPolicy({
    mode: 'normal',
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(retrySeconds === undefined ? {} : { backoff: {
      initialDelayMs: retrySeconds * 1_000,
      maxDelayMs: Math.max(10_000, retrySeconds * 1_000),
    } }),
  }, `byclaw-dsh: provider "${route}" retryPolicy`)
}

function idleTimeoutMs(): number {
  return (positiveInt(process.env['BYCLAW_LLM_IDLE_TIME']) ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1_000
}

function materialize(raw: AiModelRecord, modelId: string, resolution: 'explicit' | 'default'): MaterializedModel | undefined {
  if (numericFlag(raw.status) !== 1) return undefined
  const baseUrl = text(raw.url)
  const modelCode = text(raw.modelCode)
  const encryptedToken = text(raw.authToken)
  if (baseUrl === '' || modelCode === '' || encryptedToken === '') return undefined
  const instanceParam = record(raw.instanceParam) ?? {}
  const protocol = protocolOf(instanceParam)
  const route = byClawProviderKey(modelId)
  const contextWindow = positiveInt(raw.maxContentToken) ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = positiveInt(instanceParam['maxTokens']) ?? DEFAULT_MAX_TOKENS
  const abilities = Array.isArray(instanceParam['abilities'])
    ? instanceParam['abilities'].map(value => text(value)).filter(Boolean)
    : []
  const input: Array<'text' | 'image'> = abilities.includes('7') ? ['text', 'image'] : ['text']
  const reasoning = byClawReasoningFields(instanceParam)
  const model = {
    id: modelCode,
    name: text(raw.modelName) || modelCode,
    api: protocol,
    provider: route,
    baseUrl,
    reasoning: reasoning.reasoning,
    ...reasoning.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: reasoning.thinkingLevelMap },
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(protocol !== 'anthropic-messages' && reasoning.compat !== undefined) ? { compat: reasoning.compat } : {},
  } as Model<Api>
  const displayName = text(raw.modelName) || modelCode
  const piProvider = createProvider({
    id: route,
    name: displayName,
    baseUrl,
    auth: {
      apiKey: {
        name: route,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: route,
        }),
      },
    },
    models: [model],
    api: apiOf(protocol),
  })
  const profile: ResolvedPiAiProviderProfile = {
    provider: route,
    displayName,
    api: protocol,
    baseURL: baseUrl,
    defaultContextWindow: contextWindow,
    defaultMaxTokens: maxTokens,
    defaultInput: input,
    streamIdleTimeoutMs: idleTimeoutMs(),
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: retryPolicy(instanceParam, route),
    piProvider,
    configuredMaxTokens: new Map([[modelCode, maxTokens]]),
    ...reasoning.defaultLevel === undefined ? {} : { reasoning: reasoning.defaultLevel },
    ...reasoning.thinkingBudgets === undefined ? {} : { thinkingBudgets: reasoning.thinkingBudgets },
  }
  return {
    selection: { provider: route, model: modelCode, sourceModelId: modelId, protocol, resolution },
    profile,
    token: decryptByClawAuthToken(encryptedToken),
  }
}

function parseJson(value: string | null): unknown {
  if (value === null || value.trim() === '') return undefined
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function modelIdOf(raw: AiModelRecord): string {
  return text(raw.instanceId) || text(raw.modelCode)
}

function defaultRecord(value: unknown): { raw: AiModelRecord; modelId: string } | undefined {
  if (!Array.isArray(value)) return undefined
  const usable = value.filter((entry): entry is AiModelRecord => {
    const candidate = record(entry) as AiModelRecord | undefined
    if (candidate === undefined || numericFlag(candidate.status) !== 1) return false
    const modelType = text(candidate.modelType).toUpperCase()
    return modelType === '' || modelType === AIMODEL_TYPELIST_FIELD
  })
  const defaults = usable.filter(entry => numericFlag(entry.isDefault) === 1)
  if (defaults.length !== 1) throw new Error(`ByClaw default LLM requires exactly one usable default (found ${defaults.length})`)
  const selected = defaults[0]
  if (selected === undefined) return undefined
  const modelId = modelIdOf(selected)
  return modelId === '' ? undefined : { raw: selected, modelId }
}

/**
 * Resolve ByClaw model bindings on demand and expose them as hot-swappable DSH routes.
 * Secrets remain associated with immutable in-memory profile objects and are never serialized.
 */
export class ByClawDynamicModelRuntime {
  private profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map()
  private readonly tokens = new WeakMap<ResolvedPiAiProviderProfile, string>()
  private readonly lastGood = new Map<string, ByClawModelSelection>()
  private registration: AdapterRegistrationHandle | undefined
  private readonly adapter: PiAiAdapter
  private readonly fallback: ByClawModelSelection | undefined
  private readonly redisModelsEnabled: boolean

  constructor(
    private readonly ctx: Context,
    private readonly redis: ByClawModelRedis,
    options: ByClawModelRuntimeOptions,
  ) {
    const provider = options.provider?.trim() ?? ''
    const model = options.model?.trim() ?? ''
    if ((provider === '') !== (model === '')) throw new Error('byclaw-dsh fallback provider and model must be configured together')
    this.fallback = provider === '' ? undefined : { provider, model, resolution: 'fallback' }
    this.redisModelsEnabled = options.redisModelsEnabled ?? true
    if (!this.redisModelsEnabled && this.fallback === undefined) {
      throw new Error('byclaw-dsh requires a local provider and model when Redis model resolution is disabled')
    }
    this.adapter = new PiAiAdapter({
      profiles: () => this.profiles,
      resolveApiKey: async (_provider, profile) => this.tokens.get(profile),
      auth: {
        credentials: new InMemoryCredentialStore(),
        authContext: defaultProviderAuthContext(),
      },
    })
  }

  /** Resolve one root/template/member binding from the configured model source. */
  async resolve(bindingId: string, requestedModelId?: string): Promise<ByClawModelSelection> {
    if (!this.redisModelsEnabled) {
      const local = this.fallback
      if (local === undefined) throw new Error('byclaw-dsh local model configuration was lost after startup')
      return { provider: local.provider, model: local.model, resolution: 'local' }
    }
    const requested = requestedModelId?.trim() ?? ''
    if (requested !== '') {
      const explicit = await this.readExplicit(requested)
      if (explicit !== undefined) return this.publish(bindingId, explicit)
      throw new Error(`ByClaw requested AI model ${requested} is unavailable`)
    }
    const fallback = await this.readDefault()
    if (fallback !== undefined) return this.publish(bindingId, fallback)
    const previous = this.lastGood.get(bindingId)
    if (previous !== undefined) {
      this.ctx.logger.warn(`byclaw-dsh: Redis AI model resolution failed for ${bindingId}; retaining its last-good route`)
      return { ...previous, resolution: 'last-good' }
    }
    if (this.fallback !== undefined) {
      this.ctx.logger.warn(`byclaw-dsh: Redis AI model resolution failed for ${bindingId}; using the configured DSH fallback`)
      return { ...this.fallback }
    }
    throw new Error(`byclaw-dsh could not resolve an AI model for ${bindingId}, and no fallback is configured`)
  }

  private async hget(key: string, field: string): Promise<string | null> {
    try {
      return await this.redis.hget(key, field)
    } catch (error: unknown) {
      this.ctx.logger.warn(`byclaw-dsh: Redis AI model read failed for ${key}/${field}: ${String(error)}`)
      return null
    }
  }

  private async readExplicit(modelId: string): Promise<MaterializedModel | undefined> {
    const raw = record(parseJson(await this.hget(AIMODEL_CONFIG_KEY, modelId))) as AiModelRecord | undefined
    return raw === undefined ? undefined : materialize(raw, modelId, 'explicit')
  }

  private async readDefault(): Promise<MaterializedModel | undefined> {
    const selected = defaultRecord(parseJson(await this.hget(AIMODEL_TYPELIST_KEY, AIMODEL_TYPELIST_FIELD)))
    return selected === undefined ? undefined : materialize(selected.raw, selected.modelId, 'default')
  }

  private publish(bindingId: string, materialized: MaterializedModel): ByClawModelSelection {
    const next = new Map(this.profiles)
    next.set(materialized.selection.provider, materialized.profile)
    this.tokens.set(materialized.profile, materialized.token)
    this.profiles = next
    const routes = [...next.keys()].sort()
    if (this.registration === undefined) {
      // The local DSH workspace package and this integration's published peer can
      // carry distinct nominal brand symbols; the runtime adapter contract is structural.
      this.registration = this.ctx.llm.registerAdapter(routes, this.adapter as unknown as LlmAdapter)
    }
    else this.registration.replace(routes)
    this.lastGood.set(bindingId, materialized.selection)
    return { ...materialized.selection }
  }
}
