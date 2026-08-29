/** Native ByClaw FE projection checks without Redis or a running DSH instance. */

import assert from 'node:assert/strict'
import { EventType } from '@byclaw/by-framework'
import {
  childOutputProjection,
  detailProjection,
  reasoningProjection,
  sessionStatusProjection,
  teamSnapshotProjection,
  toolCallProjection,
} from '../lib/byclaw-presentation.js'
import { ByClawDshSessionRuntime } from '../lib/session-runtime.js'

const childContext = {
  sessionId: 'child-session',
  parentSessionId: 'root-session',
  rootSessionId: 'root-session',
  externalParentSessionId: 'byclaw-session',
  scope: 'child',
  depth: 1,
  sequence: '17:think',
  eventKind: 'think',
  status: 'running',
  childName: '架构专家',
  childTask: '分析系统结构',
  parentMessageId: 'dsh:child-session',
}

const reasoning = reasoningProjection('正在分析系统结构', childContext)
assert.equal(reasoning.content, '正在分析系统结构')
assert.equal(reasoning.options.eventType, 'reasoningLogDelta')
assert.equal(reasoning.options.contentType, '1001')
assert.equal(reasoning.options.messageId, 'dsh:child-session:event:17:think')
assert.equal(reasoning.options.parentMessageId, 'dsh:child-session')
assert.deepEqual(reasoning.options.metadata, {
  event_source: 'dsh',
  event_kind: 'think',
  session_scope: 'child',
  external_session_id: 'child-session',
  external_parent_session_id: 'root-session',
  external_root_session_id: 'root-session',
  host_session_id: 'byclaw-session',
  delegation_depth: 1,
  event_sequence: '17:think',
  session_status: 'running',
  child_name: '架构专家',
  child_task: '分析系统结构',
})

const childOutput = childOutputProjection('我是架构专家。', {
  ...childContext,
  sequence: '18:output',
  eventKind: 'session.output',
})
assert.equal(childOutput.options.eventType, 'answerDelta')
assert.equal(childOutput.options.contentType, '1002')
assert.equal(childOutput.options.parentMessageId, 'dsh:child-session')
assert.equal(childOutput.options.metadata.session_scope, 'child')

const contextDetail = detailProjection({
  title: '上下文注入 · skill-catalog',
}, {
  ...childContext,
  sequence: '18:context',
  eventKind: 'context',
})
assert.equal(contextDetail.options.eventType, 'reasoningLogDelta')
assert.equal(contextDetail.options.contentType, '3015')
assert.equal(contextDetail.options.objectType, 'tool_call')
assert.equal(contextDetail.options.status, '_DONE_')
assert.deepEqual(JSON.parse(contextDetail.content), {
  title: '上下文注入 · skill-catalog',
  status: '_DONE_',
  source: 'runtime',
  eventKind: 'context',
})

const toolStart = toolCallProjection({
  phase: 'start',
  toolCallId: 'call-1',
  toolName: 'read_file',
  input: '{"path":"README.md"}',
  description: '读取项目说明',
}, {
  ...childContext,
  sequence: 19,
  eventKind: 'tool.call',
})
assert.equal(toolStart.options.eventType, 'reasoningLogDelta')
assert.equal(toolStart.options.contentType, '3015')
assert.equal(toolStart.options.objectType, 'tool_call')
assert.equal(toolStart.options.messageId, 'call-1')
assert.equal(toolStart.options.parentMessageId, 'dsh:child-session')
assert.equal(toolStart.options.status, '_START_')
assert.deepEqual(JSON.parse(toolStart.content), {
  title: 'read_file',
  input: '{"path":"README.md"}',
  status: '_START_',
  description: '读取项目说明',
})

const toolDone = toolCallProjection({
  phase: 'success',
  toolCallId: 'call-1',
  toolName: 'read_file',
  output: 'file body',
}, {
  ...childContext,
  sequence: 20,
  eventKind: 'tool.result',
})
assert.equal(toolDone.options.messageId, toolStart.options.messageId)
assert.equal(toolDone.options.status, '_DONE_')
assert.deepEqual(JSON.parse(toolDone.content), {
  title: 'read_file',
  output: 'file body',
  status: '_DONE_',
})

const toolError = toolCallProjection({
  phase: 'error',
  toolCallId: 'call-2',
  toolName: 'bash',
  output: 'permission denied',
}, {
  ...childContext,
  sequence: 21,
  eventKind: 'tool.result',
})
assert.equal(toolError.options.status, '_ERROR_')
assert.equal(JSON.parse(toolError.content).status, '_ERROR_')

const childStarted = sessionStatusProjection({
  title: '架构专家 · 正在处理任务',
  status: 'running',
}, {
  ...childContext,
  sequence: '22:status',
  eventKind: 'session.status',
})
assert.equal(childStarted.content, '架构专家 · 正在处理任务')
assert.equal(childStarted.options.contentType, '3009')
assert.equal(childStarted.options.objectType, 'tool_call')
assert.equal(childStarted.options.messageId, 'dsh:child-session')
assert.equal(childStarted.options.status, '_START_')

const childDone = sessionStatusProjection({ title: '架构专家 · 处理完成', status: 'completed' }, {
  ...childContext,
  sequence: 23,
  eventKind: 'session.status',
})
const childFailed = sessionStatusProjection({ title: '架构专家 · 处理失败', status: 'failed' }, {
  ...childContext,
  sequence: 24,
  eventKind: 'session.error',
})
assert.equal(childDone.options.messageId, childStarted.options.messageId)
assert.equal(childDone.options.status, '_DONE_')
assert.equal(childFailed.options.messageId, childStarted.options.messageId)
assert.equal(childFailed.options.status, '_ERROR_')

const teamRunning = teamSnapshotProjection({
  teamId: 'team-1',
  name: 'ByClaw研发专家团',
  captainSessionId: 'root-session',
  members: [{ id: 'member-1', name: '架构舵手 · 梁远图' }],
  tasks: [{ id: 'task-1', status: 'running' }],
}, {
  archived: false,
  capturedAt: '2026-08-28T08:00:00.000Z',
}, {
  ...childContext,
  sessionId: 'root-session',
  parentSessionId: undefined,
  rootSessionId: 'root-session',
  externalParentSessionId: 'byclaw-session',
  scope: 'team',
  depth: 0,
  sequence: 'team-1:running',
  eventKind: 'agent-teams/snapshot',
  parentMessageId: 'root-message',
  messageIdPrefix: 'root-message',
})
const teamPayload = JSON.parse(teamRunning.content)
assert.equal(teamRunning.options.contentType, '3015')
assert.equal(teamRunning.options.objectType, 'tool_call')
assert.equal(teamRunning.options.eventType, EventType.ANSWER_DELTA)
assert.equal(teamRunning.options.messageId, 'root-message:team:team-1')
assert.equal(teamRunning.options.parentMessageId, 'root-message')
assert.equal(teamRunning.options.status, '_START_')
assert.equal(teamPayload.title, 'Agent Team · ByClaw研发专家团')
assert.equal(teamPayload.status, '_START_')
assert.equal(teamPayload.eventKind, 'agent-teams/snapshot')
assert.equal(teamPayload.schemaVersion, 2)
assert.equal(teamPayload.team.teamId, 'team-1')
assert.equal(teamRunning.options.metadata.session_scope, 'team')

const teamDone = teamSnapshotProjection(teamPayload.team, {
  archived: true,
  capturedAt: '2026-08-28T08:01:00.000Z',
}, {
  ...childContext,
  sessionId: 'root-session',
  parentSessionId: undefined,
  rootSessionId: 'root-session',
  externalParentSessionId: 'byclaw-session',
  scope: 'team',
  depth: 0,
  sequence: 'team-1:archived',
  eventKind: 'agent-teams/snapshot',
  parentMessageId: 'root-message',
  messageIdPrefix: 'root-message',
})
assert.equal(teamDone.options.messageId, teamRunning.options.messageId)
assert.equal(teamDone.options.status, '_DONE_')
assert.equal(JSON.parse(teamDone.content).status, '_DONE_')

const emittedChunks = []
const runtime = new ByClawDshSessionRuntime({
  root: { on() { return () => undefined } },
}, {
  agentTemplateDir: '/missing',
  sourceAgentType: 'BYCLAW_DSH_0027024710',
  emitter: {
    async emitChunk(...args) { emittedChunks.push(args) },
    async emitEvent() { throw new Error('session runtime still emitted the legacy custom event envelope') },
  },
})
const runtimeTurn = {
  context: { sessionId: 'byclaw-session', traceId: 'trace-1' },
  rootSessionId: 'root-session',
  rootMessageId: 'root-message',
  rootLabel: '主 Agent',
}
const runtimeChild = {
  id: 'child-session',
  header: { parentSession: 'root-session', delegationDepth: 1, seedLength: 0 },
  events: [],
}
await runtime.emitSessionEvent(
  runtimeTurn,
  runtimeChild,
  '30:status',
  'session.status',
  'running',
  '子 Agent 正在处理任务',
)
await runtime.emitSessionEvent(
  runtimeTurn,
  runtimeChild,
  '31:think',
  'think',
  'running',
  'Think',
  { text: '分析依赖关系' },
)
assert.equal(emittedChunks.length, 2)
const [, , statusContent, statusOptions] = emittedChunks[0]
const [, , thinkContent, thinkOptions] = emittedChunks[1]
assert.equal(statusContent.content, '子 Agent · 子 Agent 正在处理任务')
assert.equal(statusContent.metadata.session_scope, 'child')
assert.equal(statusOptions.contentType, '3009')
assert.equal(statusOptions.messageId, 'dsh:child-session')
assert.equal(statusOptions.parentMessageId, 'root-message')
assert.equal(statusOptions.metadata.session_scope, 'child')
assert.equal(statusOptions.metadata.external_root_session_id, 'root-session')
assert.equal(statusOptions.metadata.host_session_id, 'byclaw-session')
assert.equal(statusOptions.metadata.session_status, 'running')
assert.equal(statusOptions.metadata.child_name, '子 Agent')
assert.equal(thinkContent.content, '分析依赖关系')
assert.equal(thinkContent.metadata.session_scope, 'child')
assert.equal(thinkOptions.eventType, 'reasoningLogDelta')
assert.equal(thinkOptions.contentType, '1001')
assert.equal(thinkOptions.objectType, undefined)
assert.equal(thinkOptions.status, undefined)
assert.equal(thinkOptions.parentMessageId, 'dsh:child-session')
await runtime.close()

console.log('ByClaw native presentation projection checks passed')
