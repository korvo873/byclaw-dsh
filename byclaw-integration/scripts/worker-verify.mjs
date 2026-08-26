/** BYCLAW_DSH command bridge verification without Redis or a model. */

import {
  AskAgentCommand,
  MessageHeader,
  ResumeCommand,
} from '@byclaw/by-framework'
import {
  BYCLAW_DSH_AGENT_TYPE,
  ByClawQuestionBroker,
  askUserQuestionsCard,
  extractByClawUserText,
  taskPlanCard,
} from '../lib/protocol.js'
import * as dshProtocol from '../lib/protocol.js'
import {
  ByClawAsyncTeamGate,
  ByClawDshSessionRuntime,
  byClawCommandSessionRoute,
  byClawRootSessionId,
  dshChildLabel,
  describeDshSessionEvent,
  installByClawTaskPlanTool,
  shouldForwardIncrementalChunk,
  resolveRootSessionOpenMode,
  turnFailureMessage,
} from '../lib/session-runtime.js'
import { Config, resolveWorkerAgentTypes, rosterPrompt } from '../lib/index.js'
import { concludeParentForTemplateInstance } from '../lib/template-runtime.js'
import { superviseWorker } from '../lib/worker-runtime.js'
import { ByClawDshCommandHandler } from '../lib/worker.js'

if (BYCLAW_DSH_AGENT_TYPE !== 'BYCLAW_DSH') throw new Error('worker type is not BYCLAW_DSH')
const defaultAgentTypes = resolveWorkerAgentTypes(undefined, 'adminvip')
if (defaultAgentTypes.join(',') !== 'BYCLAW_DSH,BYCLAW_DSH_adminvip') {
  throw new Error(`default Worker AgentTypes changed: ${defaultAgentTypes.join(',')}`)
}
const normalizedDefaultConfig = Config({})
if (normalizedDefaultConfig.agentTypes !== undefined) {
  throw new Error('omitted config.agentTypes must remain undefined after schema normalization')
}
const takeoverAgentTypes = resolveWorkerAgentTypes(
  [' BY_SUPER ', 'BY_SUPER'],
  'adminvip',
)
if (takeoverAgentTypes.join(',') !== 'BY_SUPER') {
  throw new Error(`super-assistant takeover AgentTypes were not normalized: ${takeoverAgentTypes.join(',')}`)
}
let scopedSessionListeners = 0
let rootSessionListeners = 0
let disposedRootListener = false
const rootContext = {
  sessions: {
    get(sessionId) {
      if (sessionId === 'leader') return { id: 'leader', header: { parentSession: 'root' } }
      if (sessionId === 'root') return { id: 'root', header: {} }
      return undefined
    },
  },
  on(eventName) {
    if (eventName !== 'session/event') throw new Error(`unexpected root event ${eventName}`)
    rootSessionListeners += 1
    return () => { disposedRootListener = true }
  },
}
const scopedContext = {
  root: rootContext,
  sessions: { get() { return undefined } },
  on() {
    scopedSessionListeners += 1
    return () => undefined
  },
}
const scopedRuntime = new ByClawDshSessionRuntime(scopedContext, {})
if (rootSessionListeners !== 1 || scopedSessionListeners !== 0) {
  throw new Error('ByClaw session runtime did not observe delegated sessions from the root event carrier')
}
const activeTurnMarker = { rootSessionId: 'root' }
scopedRuntime.active.set('root', activeTurnMarker)
const resolvedTurn = scopedRuntime.activeTurnFor({ id: 'member', header: { parentSession: 'leader' } })
if (resolvedTurn !== activeTurnMarker) {
  throw new Error('ByClaw session runtime did not resolve nested delegated sessions through the root session store')
}
await scopedRuntime.close()
if (!disposedRootListener) throw new Error('ByClaw root session listener was not disposed')
const taskPlanTools = []
const taskPlanEvents = []
installByClawTaskPlanTool({
  inject() {},
  tools: { register(tool) { taskPlanTools.push(tool) } },
})
const taskPlanTool = taskPlanTools.find(tool => tool.name === 'todo_write')
const taskPlanAlias = taskPlanTools.find(tool => tool.name === 'task_plan')
if (!taskPlanTool) throw new Error('ByClaw root Agent did not receive todo_write')
if (!taskPlanAlias) throw new Error('ByClaw root Agent did not receive task_plan compatibility alias')
await taskPlanTool.execute({ todos: [
  { content: '已完成项', status: 'completed' },
  { content: '进行中项', status: 'in_progress' },
] }, { agent: { session: { append(type, data) { taskPlanEvents.push({ type, data }) } } } })
if (taskPlanEvents[0]?.type !== 'todo/write' || taskPlanEvents[0]?.data.todos.length !== 2) {
  throw new Error('ByClaw root Agent todo_write did not append a task-plan event')
}
await taskPlanAlias.execute({ todos: [
  { content: '兼容工具项', status: 'in_progress' },
] }, { agent: { session: { append(type, data) { taskPlanEvents.push({ type, data }) } } } })
if (taskPlanEvents[1]?.type !== 'todo/write' || taskPlanEvents[1]?.data.todos[0]?.content !== '兼容工具项') {
  throw new Error('ByClaw task_plan compatibility alias did not append a task-plan event')
}
if (!String(byClawRootSessionId('external-session', 'adminvip')).startsWith('byclaw-dsh-v2-')) {
  throw new Error('ByClaw root session identity does not isolate pre-takeover sessions')
}
if (resolveRootSessionOpenMode(true, true) !== 'reuse'
  || resolveRootSessionOpenMode(false, true) !== 'resume'
  || resolveRootSessionOpenMode(false, false) !== 'create') {
  throw new Error('ByClaw root Agent create/resume decision is incorrect')
}
if (shouldForwardIncrementalChunk('reasoning') || !shouldForwardIncrementalChunk('answer')) {
  throw new Error('DSH reasoning chunks must be aggregated while answer chunks remain incremental')
}
if (dshChildLabel('agent-teams:rd-team:架构舵手', '/missing') !== '架构舵手') {
  throw new Error('AgentTeams member descriptor did not produce the visible member name')
}
try {
  resolveWorkerAgentTypes([], 'adminvip')
  throw new Error('empty Worker AgentType override was accepted')
} catch (error) {
  if (!String(error).includes('at least one')) throw error
}
if (extractByClawUserText([{ role: 'assistant', content: 'old' }, { role: 'user', content: { text: 'latest' } }]) !== 'latest') {
  throw new Error('AskAgent user text extraction failed')
}
const card = taskPlanCard([{ content: '分析', status: 'in_progress' }])
const cardPayload = JSON.parse(card.content)
if (card.contentType !== '2008'
  || cardPayload.source !== 'DSH'
  || cardPayload.schemaVersion !== 1
  || typeof cardPayload.planId !== 'string'
  || cardPayload.task_description !== 'DSH 任务计划'
  || cardPayload.steps?.[0]?.sub_steps?.[0]?.step_description !== '分析'
  || cardPayload.steps?.[0]?.sub_steps?.[0]?.tool_metadata?.dsh_status !== 'in_progress') {
  throw new Error('todo plan card mapping failed')
}
const questionCard = askUserQuestionsCard([{
  id: 'choice', question: '选择结果', options: [{ label: '通过' }, { label: '不通过' }],
}], 'interaction-1', { sessionId: 'leader', parentSessionId: 'root', depth: 1 })
const questionPayload = JSON.parse(questionCard.content)
if (questionCard.contentType !== '3014'
  || questionPayload.source !== 'DSH'
  || questionPayload.schemaVersion !== 1
  || questionPayload.interactionId !== 'interaction-1'
  || questionPayload.eventId !== 'ask:interaction-1'
  || questionPayload.sessionId !== 'leader'
  || questionPayload.parentSessionId !== 'root'
  || questionPayload.questions?.[0]?.id !== 'choice'
  || questionPayload.questions?.[0]?.question !== '选择结果'
  || questionPayload.questions?.[0]?.options?.[0]?.label !== '通过') {
  throw new Error('ask_user question card mapping failed')
}
const sessionEventCard = dshProtocol.dshSessionEventCard({
  eventId: 'child:7',
  eventKind: 'session.status',
  sessionId: 'child',
  parentSessionId: 'root',
  depth: 1,
  status: 'running',
  occurredAt: '2026-08-20T12:00:00.000Z',
  summary: '子 Agent 正在处理任务',
})
const sessionEventPayload = JSON.parse(sessionEventCard.content)
if (sessionEventCard.contentType !== '3015'
  || sessionEventPayload.source !== 'DSH'
  || sessionEventPayload.eventId !== 'child:7'
  || sessionEventPayload.parentSessionId !== 'root') {
  throw new Error('DSH session event mapping failed')
}
const contextProjection = describeDshSessionEvent({
  type: 'user/message',
  data: {
    source: { kind: 'plugin', plugin: 'skill-loader', form: 'catalog' },
    content: [{ type: 'text', text: 'Loaded Spring Boot skills' }],
  },
})
const toolCallProjection = describeDshSessionEvent({
  type: 'tool/call',
  data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
})
const toolResultProjection = describeDshSessionEvent({
  type: 'tool/result',
  data: { message: { content: [{
    type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }],
  }] } },
})
const planProjection = describeDshSessionEvent({
  type: 'todo/write',
  data: { todos: [{ content: '验证事件映射', status: 'in_progress' }] },
})
if (contextProjection?.eventKind !== 'context'
  || contextProjection.contextSource !== 'plugin:skill-loader'
  || contextProjection.text !== 'Loaded Spring Boot skills'
  || toolCallProjection?.eventKind !== 'tool.call'
  || toolCallProjection.toolCallId !== 'call-1'
  || toolCallProjection.arguments !== '{"path":"README.md"}'
  || toolResultProjection?.eventKind !== 'tool.result'
  || toolResultProjection.result !== 'file body'
  || planProjection?.eventKind !== 'plan'
  || planProjection.plan?.[0]?.content !== '验证事件映射') {
  throw new Error('complete DSH context/Tool/plan event projection failed')
}
const teamSnapshots = [
  { teamId: 'owned', name: '研发专家团', captainSessionId: 'child', members: [], tasks: [], messageCount: 0, captainInbox: [] },
  { teamId: 'other', name: '其他团队', captainSessionId: 'unrelated', members: [], tasks: [], messageCount: 0, captainInbox: [] },
]
const ownedSnapshots = dshProtocol.selectOwnedTeamSnapshots(teamSnapshots, sessionId => ['root', 'child'].includes(sessionId))
if (ownedSnapshots.length !== 1 || ownedSnapshots[0]?.teamId !== 'owned') {
  throw new Error('AgentTeams snapshots escaped the active DSH session tree')
}
const liveTeamCard = dshProtocol.dshAgentTeamsSnapshotCard(ownedSnapshots[0], {
  archived: false, capturedAt: '2026-08-20T12:00:00.000Z',
})
const repeatedTeamCard = dshProtocol.dshAgentTeamsSnapshotCard(ownedSnapshots[0], {
  archived: false, capturedAt: '2026-08-20T12:01:00.000Z',
})
const archivedTeamCard = dshProtocol.dshAgentTeamsSnapshotCard(ownedSnapshots[0], {
  archived: true, capturedAt: '2026-08-20T12:02:00.000Z',
})
const liveTeamPayload = JSON.parse(liveTeamCard.content)
const archivedTeamPayload = JSON.parse(archivedTeamCard.content)
if (liveTeamCard.contentType !== '3016'
  || liveTeamPayload.source !== 'DSH'
  || liveTeamPayload.sessionId !== 'child'
  || liveTeamPayload.team.teamId !== 'owned'
  || liveTeamCard.eventId !== repeatedTeamCard.eventId
  || archivedTeamCard.eventId === liveTeamCard.eventId
  || archivedTeamPayload.archived !== true) {
  throw new Error('AgentTeams snapshot card mapping or content dedupe identity failed')
}
const routedCommand = new AskAgentCommand(new MessageHeader('route-message', 'child-session', 'route-trace', {
  userCode: 'adminvip',
}), 'follow up', false, {
  byclaw_root_session_id: 'root-session',
  dsh_target_session_id: 'leader',
  dsh_parent_session_id: 'root',
})
const commandRoute = byClawCommandSessionRoute(routedCommand)
if (commandRoute.externalRootSessionId !== 'root-session'
  || commandRoute.targetDshSessionId !== 'leader'
  || commandRoute.parentDshSessionId !== 'root') {
  throw new Error('ByClaw child-session routing metadata was not resolved')
}
if (turnFailureMessage([{ type: 'turn/end', data: { turn: 1, reason: {
  kind: 'error', error: { message: 'route failed', code: 'UNKNOWN' },
} } }]) !== 'route failed') throw new Error('DSH turn errors are not propagated to ByClaw')
if (turnFailureMessage([{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]) !== undefined) {
  throw new Error('completed DSH turns must not fail the ByClaw command')
}
const routingPrompt = rosterPrompt({ employees: [], groups: [], directEmployeeIds: [] })
if (!routingPrompt.includes('single employee is one ordinary child Agent')
  || !routingPrompt.includes('group\'s own leader Agent')
  || !routingPrompt.includes('删除运行团队不删除 DSH 父子会话历史')) {
  throw new Error('template/team/session separation policy is absent from the main-agent prompt')
}
const supervisorAbort = new AbortController()
let runnerStarts = 0
await superviseWorker(() => ({
  async start() {
    runnerStarts += 1
    if (runnerStarts === 2) supervisorAbort.abort()
  },
  stop() {},
}), supervisorAbort.signal, 0)
if (runnerStarts !== 2) throw new Error('Worker supervisor did not restart an unexpectedly exited runner')
let templateConclusions = 0
concludeParentForTemplateInstance({ concludeTurn() { templateConclusions += 1 } })
if (templateConclusions !== 1) {
  throw new Error('template dispatch did not conclude its successful tool result')
}
const asyncTeamGate = new ByClawAsyncTeamGate()
asyncTeamGate.observe({ type: 'tool/call', data: { name: 'agent_teams_start' } })
asyncTeamGate.observe({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
await asyncTeamGate.completion
if (asyncTeamGate.waiting || !asyncTeamGate.failure?.includes('delete')) {
  throw new Error('completed captain turn without team cleanup did not settle as a failure')
}
asyncTeamGate.observe({ type: 'tool/call', data: { name: 'agent_teams_delete', callId: 'delete-call' } })
asyncTeamGate.observe({ type: 'tool/result', data: { message: { content: [{
  type: 'tool-result', toolCallId: 'delete-call', isError: false, content: [],
}] } } })
asyncTeamGate.observe({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
await asyncTeamGate.completion
if (asyncTeamGate.waiting) throw new Error('deleted temporary team did not complete the ByClaw turn')

const templateGate = new ByClawAsyncTeamGate()
templateGate.observe({ type: 'tool/call', data: { name: 'byclaw_instantiate_template', callId: 'instantiate-call' } })
templateGate.observe({ type: 'tool/result', data: { message: { content: [{
  type: 'tool-result', toolCallId: 'instantiate-call', isError: false, content: [],
}] } } })
templateGate.observe({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
if (!templateGate.waiting) throw new Error('template dispatch conclusion incorrectly completed the ByClaw turn')
templateGate.observe({ type: 'user/message', data: {
  source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' }, content: [],
} })
templateGate.observe({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
await templateGate.completion
if (templateGate.waiting) throw new Error('child report did not complete the template-instantiation ByClaw turn')

const broker = new ByClawQuestionBroker()
let emitted
const waiting = broker.ask({
  sessionId: 'external-session',
  questions: [{ id: 'choice', question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] }],
  emit: async event => { emitted = event },
})
await new Promise(resolve => setImmediate(resolve))
if (!emitted?.metadata?.interaction_id || !emitted.prompt.includes('选择方案')) {
  throw new Error('ask_user request did not emit a correlated interaction')
}
if (!broker.resume('external-session', '问题 1: B', emitted.metadata.interaction_id)) {
  throw new Error('Resume did not resolve the pending ask_user interaction')
}
const answer = await waiting
if (answer.answers[0]?.selected[0] !== 'B') throw new Error('Resume answer did not map to the selected option')

let structuredEmitted
const structuredWaiting = broker.ask({
  sessionId: 'structured-session',
  questions: [
    { id: 'choice', question: '选择方案', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'note', question: '补充说明' },
  ],
  emit: async event => { structuredEmitted = event },
})
await new Promise(resolve => setImmediate(resolve))
const structuredCommand = new ResumeCommand(
  new MessageHeader('m-structured', 'structured-session', 'trace-structured', { targetAgentType: 'BYCLAW_DSH' }),
  '可读回答',
  'RESUMED',
  null,
  {
    dshInteraction: {
      source: 'DSH',
      schemaVersion: 1,
      interactionId: structuredEmitted.metadata.interaction_id,
      outcome: 'answered',
      answers: [
        { id: 'choice', selected: ['B'], custom: '', skipped: false },
        { id: 'note', selected: [], custom: '', skipped: true },
      ],
    },
  },
)
const structured = dshProtocol.parseDshInteractionResponse(structuredCommand)
if (structured?.answers[0]?.selected[0] !== 'B' || structured?.answers[1]?.skipped !== true) {
  throw new Error('structured DSH interaction response was not parsed')
}
if (!broker.resumeStructured('structured-session', structured)) {
  throw new Error('structured DSH interaction did not resolve its matching question')
}
const structuredAnswer = await structuredWaiting
if (structuredAnswer.answers[0]?.selected[0] !== 'B' || structuredAnswer.answers[1]?.skipped !== true) {
  throw new Error('structured DSH interaction answer lost selected or skipped fields')
}

const calls = []
const sessions = {
  async ask(command, context) {
    calls.push({ kind: 'ask', content: extractByClawUserText(command.content), sessionId: context.sessionId })
    return { answer: 'child answer', dshSessionId: 'dsh-root' }
  },
  resume(command) {
    calls.push({ kind: 'resume', content: extractByClawUserText(command.content) })
    return true
  },
  cancel() {},
}
const handler = new ByClawDshCommandHandler(sessions)
const header = new MessageHeader('m1', 'external-session', 'trace-1', { targetAgentType: 'BYCLAW_DSH' })
const askContext = { sessionId: 'external-session', setStreamFinished() {} }
const askResult = await handler.process(new AskAgentCommand(header, 'hello'), askContext)
if (askResult.content !== '' || askResult.replyData !== null
  || askResult.metadata?.dshSessionId !== 'dsh-root' || calls[0]?.kind !== 'ask') {
  throw new Error('AskAgent did not stream through DSH without duplicating its final answer')
}
const resumeContext = { sessionId: 'external-session', setStreamFinished(value) { this.finished = value } }
await handler.process(new ResumeCommand(header, 'B', 'RESUMED', null, {
  interaction_id: emitted.metadata.interaction_id,
}), resumeContext)
if (calls[1]?.kind !== 'resume' || resumeContext.finished !== true) throw new Error('Resume was not correlated to DSH ask_user')

console.log('BYCLAW_DSH command bridge checks passed')
