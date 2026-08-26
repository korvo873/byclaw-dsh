/** Dynamic ByClaw AI-model loading verification without model network calls. */

import { createCipheriv } from 'node:crypto'
import * as ModelRuntime from '../lib/model-runtime.js'

const {
  ByClawDynamicModelRuntime,
  byClawReasoningFields,
  byClawPrologueModelId,
  decryptByClawAuthToken,
} = ModelRuntime

const explicitRecord = {
  instanceId: '20010925',
  modelCode: 'deepseek-v4-flash',
  modelName: 'DeepSeek V4 Flash Anthropic',
  status: 1,
  url: 'https://model.example/anthropic',
  authToken: 'model-secret',
  maxContentToken: 128000,
  instanceParam: {
    providerName: 'Anthropic',
    modelProtocol: 'Anthropic',
    maxTokens: 8192,
    maxRetries: 3,
    abilities: ['3'],
    reasoningConfig: { enabled: true, capability: 'effort', defaultLevel: 'high', supportedEfforts: ['high', 'max'] },
  },
}
const defaultRecord = {
  instanceId: '10000482',
  modelCode: 'MiniMax-M3',
  modelName: 'MiniMax M3',
  modelType: 'LLM',
  status: 1,
  isDefault: 1,
  url: 'https://model.example/v1',
  authToken: 'default-secret',
  instanceParam: { providerName: 'OpenAI', modelProtocol: 'OpenAI', maxTokens: 4096, abilities: ['3', '7'] },
}

const defaultReasoningCompatibility = byClawReasoningFields({
  reasoningConfig: {
    enabled: true,
    capability: 'effort',
    defaultLevel: 'high',
    supportedEfforts: ['high'],
  },
}).compat
if (defaultReasoningCompatibility?.supportsDeveloperRole !== false) {
  throw new Error('ByClaw OpenAI-compatible models must default to the portable system role')
}
const explicitReasoningCompatibility = byClawReasoningFields({
  reasoningConfig: {
    enabled: true,
    capability: 'effort',
    defaultLevel: 'high',
    supportedEfforts: ['high'],
    supportsDeveloperRole: true,
  },
}).compat
if (explicitReasoningCompatibility?.supportsDeveloperRole !== true) {
  throw new Error('ByClaw model metadata did not enable the developer role explicitly')
}
const values = new Map([
  ['byai:aimodel:config\0' + explicitRecord.instanceId, JSON.stringify(explicitRecord)],
  ['byai:aimodel:typelist\0LLM', JSON.stringify([defaultRecord])],
])
let redisReads = 0
const redis = {
  async hget(key, field) {
    redisReads += 1
    return values.get(`${key}\0${field}`) ?? null
  },
}
const registrations = []
const warnings = []
const ctx = {
  logger: { warn(message) { warnings.push(message) } },
  llm: {
    registerAdapter(routes, adapter) {
      const registration = { routes: [...routes], adapter }
      registrations.push(registration)
      const dispose = () => undefined
      dispose.replace = next => { registration.routes = [...next] }
      return dispose
    },
  },
}

if (byClawPrologueModelId({ prologue: JSON.stringify({ modelId: 20010925 }) }) !== '20010925') {
  throw new Error('string prologue model id was not normalized')
}
if (typeof ModelRuntime.resolveByClawRedisModelsEnabled !== 'function') {
  throw new Error('Redis model environment switch was not implemented')
}
for (const value of [undefined, '', 'true', '1', 'on', 'yes']) {
  if (ModelRuntime.resolveByClawRedisModelsEnabled(value) !== true) {
    throw new Error(`Redis model switch did not enable ${String(value)}`)
  }
}
for (const value of ['false', '0', 'off', 'no']) {
  if (ModelRuntime.resolveByClawRedisModelsEnabled(value) !== false) {
    throw new Error(`Redis model switch did not disable ${value}`)
  }
}
try {
  ModelRuntime.resolveByClawRedisModelsEnabled('sometimes')
  throw new Error('invalid Redis model switch was accepted')
} catch (error) {
  if (!String(error).includes('BYCLAW_REDIS_MODEL_ENABLED')) throw error
}

const readsBeforeLocal = redisReads
const localRuntime = new ByClawDynamicModelRuntime(ctx, redis, {
  provider: 'local-provider',
  model: 'local-model',
  redisModelsEnabled: false,
})
const localEmployee = await localRuntime.resolve('employee:local', '20010925')
const localRoot = await localRuntime.resolve('root:local')
if (localEmployee.provider !== 'local-provider' || localEmployee.model !== 'local-model'
  || localEmployee.resolution !== 'local'
  || localRoot.provider !== 'local-provider' || localRoot.model !== 'local-model'
  || localRoot.resolution !== 'local'
  || redisReads !== readsBeforeLocal) {
  throw new Error('disabled Redis model resolution did not use the local model exclusively')
}
try {
  new ByClawDynamicModelRuntime(ctx, redis, { redisModelsEnabled: false })
  throw new Error('disabled Redis models accepted missing local provider/model')
} catch (error) {
  if (!String(error).includes('local provider and model')) throw error
}

const runtime = new ByClawDynamicModelRuntime(ctx, redis, { provider: 'static-fallback', model: 'fallback-model' })
const employee = await runtime.resolve('employee:1', '20010925')
if (employee.provider !== 'baiying-m-20010925' || employee.model !== 'deepseek-v4-flash'
  || employee.protocol !== 'anthropic-messages' || employee.resolution !== 'explicit') {
  throw new Error('explicit employee model did not become its Anthropic DSH route')
}
const main = await runtime.resolve('root:user')
if (main.provider !== 'baiying-m-10000482' || main.model !== 'MiniMax-M3'
  || main.protocol !== 'openai-completions' || main.resolution !== 'default') {
  throw new Error('root Agent did not resolve the Redis default LLM')
}
if (registrations[0]?.routes.join(',') !== 'baiying-m-10000482,baiying-m-20010925') {
  throw new Error('dynamic DSH provider routes were not atomically expanded')
}
if (JSON.stringify({ employee, main }).includes('model-secret') || JSON.stringify({ employee, main }).includes('default-secret')) {
  throw new Error('model credentials leaked into selections')
}

values.delete(`byai:aimodel:config${String.fromCharCode(0)}20010925`)
values.delete(`byai:aimodel:typelist${String.fromCharCode(0)}LLM`)
const retained = await runtime.resolve('employee:1')
if (retained.provider !== employee.provider || retained.resolution !== 'last-good') {
  throw new Error('resource binding did not retain its last-good model')
}
const emptyRuntime = new ByClawDynamicModelRuntime(ctx, redis, { provider: 'static-fallback', model: 'fallback-model' })
const fallback = await emptyRuntime.resolve('root:new')
if (fallback.provider !== 'static-fallback' || fallback.model !== 'fallback-model' || fallback.resolution !== 'fallback') {
  throw new Error('configured static route was not used as the final fallback')
}

for (const records of [[], [defaultRecord, { ...defaultRecord, instanceId: 'other-default', modelCode: 'other', isDefault: 1 }]]) {
  values.set('byai:aimodel:typelist\0LLM', JSON.stringify(records))
  const strict = new ByClawDynamicModelRuntime(ctx, redis, {})
  try {
    await strict.resolve('root:strict')
    throw new Error('ambiguous or absent default model was accepted')
  } catch (error) {
    if (!String(error).includes('default LLM')) throw error
  }
}
values.set('byai:aimodel:typelist\0LLM', JSON.stringify([defaultRecord]))
const strict = new ByClawDynamicModelRuntime(ctx, redis, {})
try {
  await strict.resolve('employee:missing', 'does-not-exist')
  throw new Error('missing explicit model was accepted')
} catch (error) {
  if (!String(error).includes('does-not-exist')) throw error
}

const previousKey = process.env.BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX
try {
  const keyHex = '00112233445566778899aabbccddeeff'
  process.env.BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX = keyHex
  const cipher = createCipheriv('sm4-ecb', Buffer.from(keyHex, 'hex'), null)
  const encrypted = Buffer.concat([cipher.update('decrypted-secret', 'utf8'), cipher.final()]).toString('base64')
  if (decryptByClawAuthToken(encrypted) !== 'decrypted-secret') throw new Error('SM4 model token was not decrypted')
} finally {
  if (previousKey === undefined) delete process.env.BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX
  else process.env.BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX = previousKey
}

console.log('ByClaw dynamic AI-model loading checks passed')
