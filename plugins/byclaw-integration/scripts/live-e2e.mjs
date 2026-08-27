/** Real ByClaw Gateway smoke for the BYCLAW_DSH worker. */

import { randomInt } from 'node:crypto'
import {
  GatewayClient,
  QueueNames,
  WorkerRegistry,
  createRedis,
} from '@byclaw/by-framework'
import {
  buildByClawInboundExtraPayload,
  parseByClawLiveE2eArgs,
} from '../lib/live-e2e-options.js'

const options = parseByClawLiveE2eArgs(process.argv.slice(2))
const prompts = options.prompts
const sessionId = process.env.E2E_SESSION_ID || snowflakeSessionId()
const cwd = process.env.E2E_CWD?.trim()
const targetAgentType = options.targetAgentType
const userCode = process.env.USER_CODE || 'adminvip'
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 10 * 60 * 1000)
const redis = createRedis()
const extraPayload = buildByClawInboundExtraPayload(cwd, options)

function snowflakeSessionId() {
  const epoch = 1704067200000n
  const timestamp = BigInt(Date.now()) - epoch
  const worker = BigInt(randomInt(0, 1024))
  const sequence = BigInt(randomInt(0, 4096))
  return ((timestamp << 22n) | (worker << 12n) | sequence).toString()
}

try {
  const registry = new WorkerRegistry(redis)
  const workerId = await registry.getTargetWorker(targetAgentType)
  if (!workerId) throw new Error(`no online ${targetAgentType} worker`)
  const gateway = new GatewayClient(registry, redis)
  console.log(JSON.stringify({ sessionId, targetAgentType, workerId, extraPayload }))
  for (const prompt of prompts) {
    const response = await gateway.sendMessage({
      targetAgentType,
      sessionId,
      content: prompt,
      userCode,
      extraPayload,
      requireOnlineWorker: true,
    })
    if (!response.success) throw new Error(response.error || response.status)
    console.log(JSON.stringify({ prompt, traceId: response.trace_id }))
    await streamUntilTerminal(response.trace_id)
  }
} finally {
  await redis.quit()
}

async function streamUntilTerminal(traceId) {
  const stream = QueueNames.session_data_stream(sessionId)
  const deadline = Date.now() + timeoutMs
  let cursor = '0-0'
  let answer = ''
  let reasoning = ''
  while (Date.now() < deadline) {
    const rows = await redis.xread('COUNT', 100, 'BLOCK', Math.min(5000, deadline - Date.now()), 'STREAMS', stream, cursor)
    for (const entry of parseStreamRows(rows)) {
      cursor = entry.id
      const event = JSON.parse(entry.data)
      if (String(event.trace_id || '') !== traceId) continue
      const eventType = String(event.event_type || '')
      const text = deltaText(event.data)
      if (text && eventType === 'answerDelta') answer += text
      if (text && eventType === 'reasoningLogDelta') reasoning += text
      if (eventType === 'error') throw new Error(String(event.metadata?.error || event.state_msg || 'worker error'))
      if (eventType === 'appStreamResponse') {
        console.log(JSON.stringify({ eventType, answer, reasoning, metadata: event.metadata }))
        return
      }
    }
  }
  throw new Error(`timed out waiting for trace ${traceId}`)
}

function parseStreamRows(rows) {
  const entries = []
  if (!Array.isArray(rows)) return entries
  for (const streamRow of rows) {
    if (!Array.isArray(streamRow?.[1])) continue
    for (const entry of streamRow[1]) {
      const fields = entry?.[1]
      if (!Array.isArray(fields)) continue
      for (let index = 0; index < fields.length - 1; index += 2) {
        if (fields[index] === 'data') entries.push({ id: String(entry[0]), data: String(fields[index + 1]) })
      }
    }
  }
  return entries
}

function deltaText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : []
  return typeof choices[0]?.delta?.content === 'string' ? choices[0].delta.content : ''
}
