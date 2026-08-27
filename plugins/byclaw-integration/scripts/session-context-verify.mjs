import assert from 'node:assert/strict'
import {
  appendByClawContext,
  appendByClawInboundUserMessage,
  byClawInboundText,
  registerByClawSessionEventType,
} from '../lib/index.js'
import * as dshSession from '@deepseek-ai/dsh-session'

const workspace = {
  externalSessionId: '350860623218590448',
  cwd: '/workspace/byclaw',
}
const businessText = '帮我找架构助手，重新研究 ByClaw 前后端的架构。'

assert.equal(byClawInboundText(businessText), businessText)
assert.equal(byClawInboundText(businessText).includes('<user-request>'), false)
assert.equal(byClawInboundText(businessText).includes('<byclaw-session-workspace>'), false)

const recordedInbound = []
appendByClawInboundUserMessage({
  append(type, data, options) {
    recordedInbound.push({ type, data, options })
  },
}, businessText)
assert.equal(recordedInbound.length, 1)
assert.equal(recordedInbound[0].type, 'user/message')
assert.equal(recordedInbound[0].data.source.kind, 'user')
assert.equal(recordedInbound[0].data.content[0].text, businessText)
assert.deepEqual(recordedInbound[0].options, { surfaceOp: 'append' })

registerByClawSessionEventType()
assert.equal(dshSession.KNOWN_SESSION_EVENT_TYPES.has('byclaw/session-workspace'), true)

const userMessage = {
  id: 'user-message',
  role: 'user',
  content: [{ type: 'text', text: businessText }],
  source: { kind: 'user' },
}
const workspaceEvent = {
  id: 'workspace-event',
  timestamp: 1,
  type: 'byclaw/session-workspace',
  data: workspace,
}
const session = {
  header: {},
  events: [workspaceEvent],
}

const first = appendByClawContext(session, [userMessage])
assert.equal(first.length, 2)
assert.equal(first[0], userMessage)
assert.deepEqual(first[1].source, { kind: 'plugin', plugin: 'byclaw-context' })
assert.match(first[1].content[0].text, /session_id: 350860623218590448/u)
assert.match(first[1].content[0].text, /cwd: \/workspace\/byclaw/u)
assert.doesNotMatch(first[1].content[0].text, /<user-request>/u)
assert.doesNotMatch(first[1].content[0].text, /byclaw-runtime-capabilities/u)
assert.doesNotMatch(first[1].content[0].text, /CodeGraph/u)

const persistedContextEvent = {
  id: 'context-event',
  timestamp: 2,
  type: 'user/message',
  data: first[1],
}
const resumed = appendByClawContext({
  header: {},
  events: [workspaceEvent, persistedContextEvent],
}, [userMessage])
assert.deepEqual(resumed, [userMessage])

const delegated = appendByClawContext({
  header: { parentSession: 'parent', seedLength: 2 },
  events: [workspaceEvent, persistedContextEvent, workspaceEvent],
}, [userMessage])
assert.equal(delegated.length, 2)
assert.deepEqual(delegated[1].source, { kind: 'plugin', plugin: 'byclaw-context' })

console.info('ByClaw session context verification passed')
