/** Durable DSH root-session runtime used by the BYCLAW_DSH Worker. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  EventType,
  type AgentContext,
  type AskAgentCommand,
  type GatewayDataEmitter,
  type ResumeCommand,
} from '@byclaw/by-framework'
import { isAbsolute, join, resolve } from 'node:path'
import {
  collectArchivedTeamsActivity,
  collectTeamsActivity,
  type TeamActivitySnapshot,
} from '@byclaw/dsh-agent-teams/snapshot'
import type { ByClawDshSessionPort } from './worker.ts'
import { readAgentTemplateSync } from './agent-template.ts'
import type { ByClawInboundTarget } from './inbound-routing.ts'
import type { ByClawTemplateInstanceRuntime } from './template-runtime.ts'
import {
  assertByClawRootBinding,
  byClawInboundText,
  ensureByClawRootBinding,
  ensureByClawSessionWorkspace,
  isLegacyByClawRootBindingCandidate,
  registerByClawAgentWorkspacePolicy,
  type ByClawRootBinding,
} from './session-workspace.ts'
import {
  ByClawQuestionBroker,
  askUserQuestionsCard,
  dshAgentTeamsSnapshotEventId,
  extractByClawUserText,
  parseDshInteractionResponse,
  selectOwnedTeamSnapshots,
  taskPlanCard,
  type DshSessionEventKind,
  type DshSessionStatus,
} from './protocol.ts'
import {
  childOutputProjection,
  reasoningProjection,
  sessionStatusProjection,
  teamSnapshotProjection,
  toolCallProjection,
  type ByClawProjection,
  type DshProjectionContext,
} from './byclaw-presentation.ts'

export interface ByClawDshSessionRuntimeOptions {
  workspace: string
  stateDir: string
  agentTemplateDir: string
  agentPreset: string
  resolveModel: (bindingId: string) => Promise<ModelSelection>
  rosterPrompt: string | (() => string)
  sourceAgentType: string
  emitter: GatewayDataEmitter
  resolveInboundTarget?: (command: AskAgentCommand, text: string) => ByClawInboundTarget | undefined
  templateRuntime?: ByClawTemplateInstanceRuntime
}

interface ActiveTurn {
  context: AgentContext
  answer: string
  forwarding: Promise<void>
  teamGate: ByClawAsyncTeamGate
  rootSessionId: string
  responseSessionId: string
  rootMessageId: string
  direct: boolean
  rootLabel: string
  workspace: string
  announcedChildren: Set<string>
  emittedTeamSnapshots: Set<string>
  bufferedReasoning: Map<string, { sequence: number; text: string }>
  bufferedChildOutput: Map<string, { sequence: number; text: string }>
  toolNames: Map<string, string>
}

interface RootHandle {
  handle: AgentHandle
  selection: ModelSelectionRef
  mode: 'reuse' | 'resume' | 'create'
  templateId?: string
}

/** Root-worker and target-agent coordinates carried by one ByClaw command. */
export interface ByClawCommandSessionRoute {
  externalRootSessionId: string
  targetDshSessionId?: string
  parentDshSessionId?: string
  cwd?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function logText(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/** Resolve the stable outer conversation and optional selected DSH child. */
export function byClawCommandSessionRoute(command: AskAgentCommand): ByClawCommandSessionRoute {
  const requestedCwd = nonEmptyString(command.extraPayload['cwd'])
  if (requestedCwd !== undefined && !isAbsolute(requestedCwd)) {
    throw new Error(`ByClaw inbound cwd must be absolute: "${requestedCwd}"`)
  }
  return {
    externalRootSessionId: nonEmptyString(command.extraPayload['byclaw_root_session_id'])
      ?? command.header.sessionId,
    ...nonEmptyString(command.extraPayload['dsh_target_session_id']) === undefined ? {} : {
      targetDshSessionId: nonEmptyString(command.extraPayload['dsh_target_session_id']),
    },
    ...nonEmptyString(command.extraPayload['dsh_parent_session_id']) === undefined ? {} : {
      parentDshSessionId: nonEmptyString(command.extraPayload['dsh_parent_session_id']),
    },
    ...(requestedCwd === undefined ? {} : { cwd: resolve(requestedCwd) }),
  }
}

function assertStableSessionCwd(
  sessionId: string,
  currentCwd: string | undefined,
  requestedCwd: string | undefined,
): void {
  if (requestedCwd === undefined || (currentCwd !== undefined && resolve(currentCwd) === requestedCwd)) return
  throw new Error(
    `ByClaw session "${sessionId}" cannot change cwd from "${currentCwd ?? '<unset>'}" to "${requestedCwd}"`,
  )
}

/**
 * Keep the durable DSH root identity equal to ByClaw's inbound session id.
 *
 * ByClaw already owns the conversation namespace, so hashing it here only
 * makes cross-system tracing and resume unnecessarily difficult. The user
 * code remains part of the in-process handle map and Worker AgentType.
 */
export function byClawRootSessionId(externalSessionId: string, userCode: string): SessionId {
  void userCode
  return SessionId(externalSessionId)
}

/** Label the inbound root as the actual direct target rather than a relay Agent. */
export function byClawRootPresentationLabel(
  directTarget: Pick<ByClawInboundTarget, 'name'> | undefined,
): string {
  return directTarget?.name ?? '主 Agent'
}

/** Decide whether a ByClaw root Agent is reused, resumed, or created. */
export function resolveRootSessionOpenMode(
  live: boolean,
  persisted: boolean,
): 'reuse' | 'resume' | 'create' {
  if (live) return 'reuse'
  return persisted ? 'resume' : 'create'
}

function interactionId(command: ResumeCommand): string | undefined {
  for (const source of [command.extraPayload, command.header.metadata]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() === 'interaction_id' && typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return undefined
}

function chunkText(event: SessionEvent): { kind: 'answer' | 'reasoning'; text: string } | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  const chunk = event.data.chunk as unknown as Record<string, unknown>
  const text = typeof chunk['text'] === 'string' ? chunk['text'] : ''
  if (text === '') return undefined
  return { kind: String(chunk['type']).includes('reasoning') ? 'reasoning' : 'answer', text }
}

/** Keep answer streaming responsive while emitting reasoning once as a complete Think event. */
export function shouldForwardIncrementalChunk(kind: 'answer' | 'reasoning'): boolean {
  return kind === 'answer'
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const item = block as Record<string, unknown>
    if ((item['type'] === 'text' || item['type'] === 'reasoning') && typeof item['text'] === 'string') {
      return [item['text']]
    }
    if (item['type'] === 'tool-result') return [contentText(item['content'])]
    if (item['type'] === 'image') return ['[图片]']
    return []
  }).filter(text => text !== '').join('\n')
}

function templateIdFromDescriptorLabel(label: string): string | undefined {
  const prefix = 'byclaw-template:'
  if (!label.startsWith(prefix)) return undefined
  const suffix = label.slice(prefix.length)
  const separator = suffix.lastIndexOf(':')
  return separator < 1 ? undefined : suffix.slice(0, separator)
}

/** Resolve durable child identity from its subagent descriptor and logged assignment. */
export function dshChildPresentation(session: Session, agentTemplateDir: string): { label: string; task?: string } {
  const descriptor = foldSubagentDescriptor(session.events.slice(session.header.seedLength ?? 0))
  const descriptorLabel = descriptor?.label?.trim()
  const label = dshChildLabel(descriptorLabel, agentTemplateDir)
  const assignment = session.events
    .filter(event => event.type === 'user/message')
    .map(event => event.type === 'user/message' ? contentText(event.data.content).trim() : '')
    .filter(Boolean)
    .at(-1)
    ?.replace(/^Delegated task from your direct parent:\s*/u, '')
    .trim()
  return { label, ...assignment === undefined || assignment === '' ? {} : { task: assignment } }
}

/** Resolve the visible child name without exposing an internal descriptor label. */
export function dshChildLabel(descriptorLabel: string | undefined, agentTemplateDir: string): string {
  let label = descriptorLabel || '子 Agent'
  const templateId = descriptorLabel === undefined ? undefined : templateIdFromDescriptorLabel(descriptorLabel)
  if (templateId !== undefined) {
    const template = readAgentTemplateSync(agentTemplateDir, templateId)
    if (template !== undefined) {
      label = template.kind === 'expert-team' && !template.name.endsWith('团长')
        ? `${template.name}团长`
        : template.name
    }
  } else if (descriptorLabel?.startsWith('agent-teams:')) {
    label = descriptorLabel.split(':').at(-1)?.trim() || label
  }
  return label
}

/** One display-level projection for a durable DSH event that is not streamed reasoning or answer text. */
export interface DshEventDescription {
  eventKind: DshSessionEventKind
  status: DshSessionStatus
  summary: string
  text?: string
  toolName?: string
  toolCallId?: string
  arguments?: string
  result?: string
  isError?: boolean
  contextSource?: string
  plan?: ReadonlyArray<{ content: string; status: string }>
}

/** Convert a durable DSH event to its ByClaw transcript meaning, omitting internal lifecycle records. */
export function describeDshSessionEvent(event: SessionEvent): DshEventDescription | undefined {
  if (event.type === 'user/message') {
    if (event.data.source.kind === 'user') return undefined
    const source = event.data.source as unknown as Record<string, unknown>
    const sourceName = source['kind'] === 'plugin' && typeof source['plugin'] === 'string'
      ? `plugin:${source['plugin']}`
      : String(source['kind'] ?? 'injected')
    const text = contentText(event.data.content)
    return {
      eventKind: 'context', status: 'running', summary: `上下文注入 · ${sourceName}`,
      contextSource: sourceName, ...(text === '' ? {} : { text }),
    }
  }
  if (event.type === 'request/context') {
    const contextSource = `${event.data.provider}/${event.data.model}`
    return {
      eventKind: 'context', status: 'running', summary: `模型上下文 · ${contextSource}`,
      contextSource, text: JSON.stringify(event.data),
    }
  }
  if (event.type === 'request/header') {
    return {
      eventKind: 'context', status: 'running', summary: `请求配置 · ${event.data.reason}`,
      contextSource: 'request/header', text: JSON.stringify(event.data.header),
    }
  }
  if (event.type === 'tool/call') {
    return {
      eventKind: 'tool.call', status: 'running', summary: `Tool call · ${event.data.name}`,
      toolName: event.data.name, toolCallId: String(event.data.callId), arguments: event.data.arguments,
    }
  }
  if (event.type === 'tool/result') {
    const block = event.data.message.content.find(item => item.type === 'tool-result')
    const toolCallId = block?.type === 'tool-result' ? String(block.toolCallId) : undefined
    const result = block?.type === 'tool-result' ? contentText(block.content) : ''
    const isError = event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true)
    return {
      eventKind: 'tool.result', status: isError ? 'failed' : 'running',
      summary: isError ? 'Tool result · 调用失败' : 'Tool result · 调用完成',
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(result === '' ? {} : { result }), isError,
    }
  }
  if (event.type === 'tool/code-dispatch-start') {
    return {
      eventKind: 'tool.call', status: 'running', summary: `Tool call · ${event.data.name}`,
      toolName: event.data.name, toolCallId: String(event.data.subCallId),
      arguments: JSON.stringify(event.data.arguments),
    }
  }
  if (event.type === 'tool/code-dispatch') {
    const result = contentText(event.data.content)
    return {
      eventKind: 'tool.result', status: event.data.isError ? 'failed' : 'running',
      summary: event.data.isError ? `Tool result · ${event.data.name} 调用失败` : `Tool result · ${event.data.name} 调用完成`,
      toolName: event.data.name, toolCallId: String(event.data.subCallId),
      ...(result === '' ? {} : { result }), isError: event.data.isError,
    }
  }
  if (event.type === 'todo/write') {
    return {
      eventKind: 'plan', status: 'running', summary: `更新任务清单 · ${event.data.todos.length} 项`,
      plan: event.data.todos,
    }
  }
  return undefined
}

/** Return the latest completed turn's failure message, when DSH ended in error. */
export function turnFailureMessage(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    return event.data.reason.kind === 'error' ? event.data.reason.error.message : undefined
  }
  return undefined
}

const TASK_PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const

/** Install the canonical DSH task-plan tool and the ByClaw-facing compatibility name. */
export function installByClawTaskPlanTool(ctx: Context): void {
  ToolTodo.apply(ctx, { allowParallelInProgress: true })
  ctx.tools.register(defineTool({
    name: 'task_plan',
    description: 'Create or replace the current task plan. Use this when a ByClaw user asks for a task plan or planning card.',
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The complete ordered task plan, replacing the previous plan.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'A short task step.' },
            status: {
              type: 'string',
              required: true,
              enum: [...TASK_PLAN_STATUSES],
              description: 'pending, in_progress, or completed.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...TASK_PLAN_STATUSES] },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated task plan with ${value.todos.length} steps.` }],
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('task_plan requires an owning agent session')
      const todos: TodoItem[] = args.todos.map(todo => ({ content: todo.content, status: todo.status }))
      exec.agent.session.append('todo/write', { todos })
      return Promise.resolve({ todos })
    },
    presentCall: args => ({ card: 'generic', title: 'Update task plan', kind: 'other', rawInput: args.todos }),
  }))
}

/** Hold one ByClaw command across captain pause/wake turns until its temporary team is deleted. */
export class ByClawAsyncTeamGate {
  waiting = false
  completion: Promise<void> = Promise.resolve()
  private kind: 'team' | 'template' | undefined
  private teamActive = false
  private startCallId: string | undefined
  private deleteCallId: string | undefined
  private templateCallId: string | undefined
  private templateReported = false
  private failure: Error | undefined
  private resolveCompletion: (() => void) | undefined
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly timeoutMs = 10 * 60 * 1000) {}

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure
  }

  cancel(reason: string): void {
    this.finish(new Error(`ByClaw async team/template gate was cancelled: ${reason}`))
  }

  private begin(kind: 'team' | 'template'): void {
    if (this.waiting) return
    this.waiting = true
    this.kind = kind
    this.failure = undefined
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
    this.timeout = setTimeout(() => {
      this.finish(new Error(`ByClaw ${kind} gate timed out after ${this.timeoutMs}ms without terminal cleanup`))
    }, this.timeoutMs)
    this.timeout.unref?.()
  }

  private finish(error?: Error): void {
    if (!this.waiting) return
    if (error !== undefined) this.failure = error
    this.waiting = false
    this.kind = undefined
    if (this.timeout !== undefined) clearTimeout(this.timeout)
    this.timeout = undefined
    this.resolveCompletion?.()
    this.resolveCompletion = undefined
  }

  private observeTeamCall(name: string, callId: string): boolean {
    if (name === 'agent_teams_start') {
      this.begin('team')
      this.startCallId = callId
      return true
    }
    if (name === 'agent_teams_delete') {
      this.deleteCallId = callId
      return true
    }
    return false
  }

  private observeTeamResult(name: string, callId: string, isError: boolean): boolean {
    if (name === 'agent_teams_start' && this.startCallId === callId) {
      this.startCallId = undefined
      if (isError) this.finish(new Error('agent_teams_start failed; no expert team was activated'))
      else this.teamActive = true
      return true
    }
    if (name === 'agent_teams_delete' && this.deleteCallId === callId) {
      this.deleteCallId = undefined
      if (isError) this.finish(new Error('agent_teams_delete failed; expert team cleanup did not complete'))
      else this.teamActive = false
      return true
    }
    return false
  }

  observe(event: SessionEvent): void {
    if (event.type === 'tool/call' && this.observeTeamCall(event.data.name, String(event.data.callId))) {
      return
    }
    if (event.type === 'tool/code-dispatch-start'
      && this.observeTeamCall(event.data.name, String(event.data.subCallId))) return
    if (event.type === 'tool/call' && event.data.name === 'byclaw_instantiate_template') {
      this.begin('template')
      this.templateReported = false
      this.templateCallId = event.data.callId
      return
    }
    if (event.type === 'tool/result') {
      const result = event.data.message.content.find(block => (
        block.type === 'tool-result'
        && (String(block.toolCallId) === this.startCallId || String(block.toolCallId) === this.deleteCallId)
      ))
      if (result?.type !== 'tool-result') return
      const callId = String(result.toolCallId)
      if (this.startCallId === callId) {
        this.observeTeamResult('agent_teams_start', callId, event.data.error !== undefined || result.isError === true)
        return
      }
      if (this.deleteCallId === callId) {
        this.observeTeamResult('agent_teams_delete', callId, event.data.error !== undefined || result.isError === true)
        return
      }
    }
    if (event.type === 'tool/code-dispatch'
      && this.observeTeamResult(event.data.name, String(event.data.subCallId), event.data.isError)) {
      return
    }
    if (event.type === 'tool/result' && this.templateCallId !== undefined) {
      const result = event.data.message.content.find(block => (
        block.type === 'tool-result' && block.toolCallId === this.templateCallId
      ))
      if (result?.type === 'tool-result' && result.isError === true) this.templateReported = true
      this.templateCallId = undefined
      return
    }
    if (event.type === 'user/message'
      && (event.data.source.kind === 'subagent-report' || event.data.source.kind === 'subagent-settled')) {
      this.templateReported = true
      return
    }
    if (event.type !== 'turn/end' || !this.waiting) return
    const completed = this.kind === 'team'
      ? this.startCallId === undefined && !this.teamActive
      : this.templateReported && event.data.reason.kind === 'completed'
    if (event.data.reason.kind === 'error') {
      this.finish(new Error(`ByClaw ${this.kind ?? 'async'} turn failed: ${event.data.reason.error.message}`))
    } else if (completed) this.finish()
  }
}

/** Owns DSH root handles and maps their event logs onto one by-framework turn. */
export class ByClawDshSessionRuntime implements ByClawDshSessionPort {
  readonly questions = new ByClawQuestionBroker()
  private readonly handles = new Map<string, RootHandle>()
  private readonly active = new Map<string, ActiveTurn>()
  private readonly messageAgents = new Map<string, Agent>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly disposeSessionEvents: () => void

  constructor(private readonly ctx: Context, private readonly options: ByClawDshSessionRuntimeOptions) {
    this.disposeSessionEvents = ctx.root.on('session/event', (session, event) => {
      const turn = this.activeTurnFor(session)
      if (turn === undefined) return
      turn.forwarding = turn.forwarding.then(() => this.forwardEvent(turn, session, event))
    })
  }

  async ask(command: AskAgentCommand, context: AgentContext): Promise<{ answer: string; dshSessionId: string }> {
    const route = byClawCommandSessionRoute(command)
    const key = `${command.header.userCode}\0${route.externalRootSessionId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.performAsk(command, context))
    this.queues.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.queues.get(key) === operation) this.queues.delete(key)
    }
  }

  resume(command: ResumeCommand): boolean {
    const structured = parseDshInteractionResponse(command)
    if (structured !== undefined) {
      return this.questions.resumeStructured(command.header.sessionId, structured)
    }
    return this.questions.resume(
      command.header.sessionId,
      extractByClawUserText(command.content),
      interactionId(command),
    )
  }

  cancel(messageId: string, reason: string): void {
    const agent = this.messageAgents.get(messageId)
    if (agent !== undefined) this.activeTurnFor(agent.session)?.teamGate.cancel(reason)
    agent?.cancel({ kind: 'hook', reason })
    if (agent !== undefined) this.questions.cancelSession(this.externalSessionOf(agent), reason)
  }

  async close(): Promise<void> {
    this.disposeSessionEvents()
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(entry => entry.handle.dispose()))
  }

  private async performAsk(command: AskAgentCommand, context: AgentContext): Promise<{ answer: string; dshSessionId: string }> {
    const route = byClawCommandSessionRoute(command)
    const text = extractByClawUserText(command.content)
    const directTarget = route.targetDshSessionId === undefined
      ? this.options.resolveInboundTarget?.(command, text)
      : undefined
    if (directTarget?.text.trim() === '') {
      throw new Error(`ByClaw direct target "${directTarget.name}" requires a non-empty task`)
    }
    console.info(
      `[byclaw-dsh] 📥 收到命令: type=AskAgentCommand, message_id=${command.header.messageId}, trace_id=${context.traceId}, session_id=${command.header.sessionId}`,
    )
    if (directTarget !== undefined && this.options.templateRuntime === undefined) {
      throw new Error('ByClaw direct template routing is not configured')
    }
    const preparedRoot = directTarget === undefined
      ? undefined
      : await this.options.templateRuntime?.prepareRoot(directTarget.templateId)
    const selection = preparedRoot?.selection
      ?? await this.options.resolveModel(`root:${command.header.userCode}:${route.externalRootSessionId}`)
    const diagnostic = selection as ModelSelection & {
      sourceModelId?: string
      protocol?: string
      resolution?: string
    }
    const entry = await this.handleFor(command, selection, preparedRoot)
    entry.selection.current = selection
    const rootAgent = entry.handle.agent
    const sessionWorkspace = ensureByClawSessionWorkspace(rootAgent.session, {
      externalSessionId: route.externalRootSessionId,
      cwd: rootAgent.session.header.cwd ?? resolve(this.options.workspace),
    })
    console.info(
      `[byclaw-dsh] 🧭 会话空间 (session=${route.externalRootSessionId}, dsh_session=${rootAgent.id}, cwd=${sessionWorkspace.cwd}, scope=root)`,
    )
    const sessionAction = entry.mode === 'create' ? '🆕 新会话' : entry.mode === 'resume' ? '♻️ 恢复会话' : '🔁 继续会话'
    console.info(
      `[byclaw-dsh] ${sessionAction} (session=${command.header.sessionId}, dsh_session=${rootAgent.id}, cwd=${rootAgent.session.header.cwd})`,
    )
    console.info(
      `[byclaw-dsh] [ModelConfig] 已解析模型配置 (source=${diagnostic.resolution ?? 'configured'}, baiyingModelId=${diagnostic.sourceModelId ?? '-'}, provider=${selection.provider}, model=${selection.model}, protocol=${diagnostic.protocol ?? '-'})`,
    )
    console.info(
      `[byclaw-dsh] 🚀 启动任务 (session=${command.header.sessionId}, cwd=${rootAgent.session.header.cwd}): ${logText(text)}`,
    )
    const responseSessionId = String(route.targetDshSessionId ?? rootAgent.id)
    if (directTarget !== undefined) {
      console.info(
        `[byclaw-dsh] 🎯 入站直达 (resource=${directTarget.resourceId}, kind=${directTarget.kind}, template=${directTarget.templateId}, dsh_session=${rootAgent.id}, scope=direct-root)`,
      )
    }
    const turn: ActiveTurn = {
      context,
      answer: '',
      forwarding: Promise.resolve(),
      teamGate: new ByClawAsyncTeamGate(),
      rootSessionId: String(rootAgent.id),
      responseSessionId,
      rootMessageId: command.header.messageId,
      direct: directTarget !== undefined,
      rootLabel: byClawRootPresentationLabel(directTarget),
      workspace: sessionWorkspace.cwd,
      announcedChildren: new Set(),
      emittedTeamSnapshots: new Set(),
      bufferedReasoning: new Map(),
      bufferedChildOutput: new Map(),
      toolNames: new Map(),
    }
    this.active.set(String(rootAgent.id), turn)
    try {
      const agent = directTarget === undefined
        ? await this.deliverToSelectedAgent(rootAgent, route, byClawInboundText(text))
        : (() => {
            rootAgent.followup(createUserMessage({ content: [{ type: 'text', text: directTarget.text }], source: { kind: 'user' } }))
            return rootAgent
          })()
      this.messageAgents.set(command.header.messageId, agent)
      await agent.whenIdle()
      await turn.forwarding
      if (turn.teamGate.waiting) await turn.teamGate.completion
      turn.teamGate.assertHealthy()
      await turn.forwarding
      const failure = turnFailureMessage(agent.session.events)
      if (failure !== undefined) throw new Error(`DSH turn failed: ${failure}`)
      return {
        answer: turn.answer || this.lastAssistantText(agent),
        // The ByClaw-facing DSH session is always the inbound conversation.
        // Direct target children retain their own internal ids for lineage and
        // event projection, but callers resume by the ByClaw session id.
        dshSessionId: route.externalRootSessionId,
      }
    } finally {
      this.active.delete(String(rootAgent.id))
      this.messageAgents.delete(command.header.messageId)
    }
  }

  private async deliverToSelectedAgent(
    rootAgent: Agent,
    route: ByClawCommandSessionRoute,
    text: string,
  ): Promise<Agent> {
    const targetSessionId = route.targetDshSessionId
    if (targetSessionId === undefined || targetSessionId === String(rootAgent.id)) {
      rootAgent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      return rootAgent
    }
    const parentSessionId = route.parentDshSessionId
    if (parentSessionId === undefined) {
      throw new Error(`ByClaw target DSH session "${targetSessionId}" has no parent identity`)
    }
    const parent = parentSessionId === String(rootAgent.id)
      ? rootAgent
      : this.ctx.agents.get(SessionId(parentSessionId))
    if (parent === undefined) {
      throw new Error(`ByClaw target DSH session "${targetSessionId}" requires live parent "${parentSessionId}"`)
    }
    await this.ctx.subagents.followup(
      parent,
      SessionId(targetSessionId),
      [{ type: 'text', text }],
      { source: { kind: 'user' }, signal: new AbortController().signal },
    )
    const target = this.ctx.agents.get(SessionId(targetSessionId))
    if (target === undefined) {
      throw new Error(`ByClaw target DSH session "${targetSessionId}" was accepted but is not live`)
    }
    return target
  }

  private async handleFor(
    command: AskAgentCommand,
    selected: ModelSelection,
    preparedRoot?: Awaited<ReturnType<ByClawTemplateInstanceRuntime['prepareRoot']>>,
  ): Promise<RootHandle> {
    const route = byClawCommandSessionRoute(command)
    const externalRootSessionId = route.externalRootSessionId
    const requestedBinding: ByClawRootBinding = preparedRoot === undefined
      ? { kind: 'main' }
      : { kind: 'template', templateId: preparedRoot.templateId }
    const key = `${command.header.userCode}\0${externalRootSessionId}`
    const existing = this.handles.get(key)
    if (existing !== undefined && this.ctx.agents.get(existing.handle.agent.id) === existing.handle.agent) {
      assertStableSessionCwd(externalRootSessionId, existing.handle.agent.session.header.cwd, route.cwd)
      ensureByClawRootBinding(existing.handle.agent.session, requestedBinding, {
        requireExisting: true,
        allowLegacyMigration: true,
        sessionId: externalRootSessionId,
      })
      return { ...existing, mode: 'reuse' }
    }
    const sessionId = byClawRootSessionId(externalRootSessionId, command.header.userCode)
    const selection: ModelSelectionRef = { current: selected, assembled: undefined }
    const setup = async (agentCtx: Context): Promise<void> => {
        await this.ctx.agentPresets.mount(agentCtx, this.options.agentPreset)
        installModelSelection(agentCtx, selection)
        installByClawTaskPlanTool(agentCtx)
        registerByClawAgentWorkspacePolicy(agentCtx)
        preparedRoot?.setup(agentCtx)
        if (preparedRoot === undefined) {
          agentCtx.systemPrompt.section({
            name: 'byclaw-dsh:authorized-resources',
            order: 116,
            text: this.options.rosterPrompt,
          })
        }
        agentCtx.tools.register(defineTool({
          name: 'ask_user_question',
          description: 'Ask the ByClaw user one or more concise questions and wait for the Resume answer.',
          parameters: {
            questions: {
              type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {
                id: { type: 'string', required: true }, question: { type: 'string', required: true },
                header: { type: 'string' }, multi_select: { type: 'boolean' },
                options: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
                  label: { type: 'string', required: true }, description: { type: 'string' },
                } } },
              } },
            },
          },
          output: {
            schema: {
              type: 'object', additionalProperties: false, properties: {
                answers: { type: 'array', required: true, items: {
                  type: 'object', additionalProperties: false, properties: {
                    id: { type: 'string', required: true },
                    selected: { type: 'array', required: true, items: { type: 'string' } },
                    custom: { type: 'string' },
                    skipped: { type: 'boolean' },
                  },
                } },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            const active = exec.agent === undefined ? undefined : this.activeTurnFor(exec.agent.session)
            if (active === undefined) throw new Error('ask_user_question is available only during a BYCLAW_DSH turn')
            const questions = args.questions.map(question => ({
              id: question.id,
              question: question.question,
              ...question.header === undefined ? {} : { header: question.header },
              ...question.multi_select === undefined ? {} : { multiSelect: question.multi_select },
              ...question.options === undefined ? {} : { options: question.options },
            }))
            const result = await this.questions.ask({
              sessionId: active.context.sessionId,
              questions,
              emit: async event => {
                const askingSession = exec.agent?.session
                const card = askUserQuestionsCard(
                  questions,
                  String(event.metadata?.interaction_id ?? ''),
                  askingSession === undefined ? undefined : {
                    sessionId: String(askingSession.id),
                    ...(askingSession.header.parentSession === undefined ? {} : {
                      parentSessionId: String(askingSession.header.parentSession),
                    }),
                    depth: askingSession.header.delegationDepth ?? 0,
                  },
                )
                await this.options.emitter.emitState(
                  active.context.sessionId,
                  active.context.traceId,
                  { state: card.content, metadata: event.metadata },
                  {
                    sourceAgentType: this.options.sourceAgentType,
                    messageId: active.rootMessageId,
                    eventType: EventType.ANSWER_DELTA,
                    contentType: card.contentType,
                  },
                )
              },
              signal: exec.signal,
            })
            return {
              answers: result.answers.map(answer => ({
                id: answer.id,
                selected: answer.selected,
                ...answer.custom === undefined ? {} : { custom: answer.custom },
                ...answer.skipped === undefined ? {} : { skipped: answer.skipped },
              })),
            }
          },
        }))
    }
    const live = this.ctx.agents.get(sessionId)
    const persistence = (this.ctx as Context & {
      sessionPersistence: {
        list(): Promise<ReadonlyArray<{ id: string; cwd?: string }>>
        load(id: SessionId): Promise<{ events: readonly SessionEvent[] }>
      }
    }).sessionPersistence
    if (live !== undefined) {
      assertStableSessionCwd(externalRootSessionId, live.session.header.cwd, route.cwd)
      ensureByClawRootBinding(live.session, requestedBinding, {
        requireExisting: true,
        allowLegacyMigration: true,
        sessionId: externalRootSessionId,
      })
    }
    const persistedHeader = live === undefined
      ? (await persistence.list()).find(header => header.id === sessionId)
      : undefined
    if (persistedHeader !== undefined) {
      assertStableSessionCwd(externalRootSessionId, persistedHeader.cwd, route.cwd)
      const persistedSession = await persistence.load(sessionId)
      const legacyBinding = isLegacyByClawRootBindingCandidate(persistedSession.events)
      if (legacyBinding && requestedBinding.kind === 'template') {
        throw new Error(`ByClaw legacy session ${externalRootSessionId} cannot safely infer a template binding; start a new ByClaw session`)
      }
      if (!legacyBinding) {
        assertByClawRootBinding(persistedSession.events, requestedBinding, externalRootSessionId)
      }
    }
    const persisted = persistedHeader !== undefined
    const mode = resolveRootSessionOpenMode(live !== undefined, persisted)
    const handle = mode === 'reuse'
      ? { agent: live as Agent, dispose: () => Promise.resolve() }
      : mode === 'resume'
        ? await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: selected.provider, model: selected.model },
            setup,
          })
        : await this.ctx.agents.create({
            sessionId,
            meta: { cwd: route.cwd ?? resolve(this.options.workspace), agentPreset: this.options.agentPreset },
            agentOptions: { provider: selected.provider, model: selected.model },
            setup,
          })
    ensureByClawRootBinding(handle.agent.session, requestedBinding, {
      requireExisting: mode !== 'create',
      allowLegacyMigration: mode !== 'create',
      sessionId: externalRootSessionId,
    })
    const entry = {
      handle,
      selection,
      mode,
      ...preparedRoot === undefined ? {} : { templateId: preparedRoot.templateId },
    }
    this.handles.set(key, entry)
    return entry
  }

  private async forwardEvent(turn: ActiveTurn, session: Session, event: SessionEvent): Promise<void> {
    const root = String(session.id) === turn.rootSessionId
    const response = String(session.id) === turn.responseSessionId
    const chunk = chunkText(event)
    if (chunk !== undefined && event.type === 'assistant/chunk') {
      const key = `${session.id}:${event.data.turn}:${event.data.step}`
      if (chunk.kind === 'reasoning') {
        const buffered = turn.bufferedReasoning.get(key)
        turn.bufferedReasoning.set(key, {
          sequence: buffered?.sequence ?? event.seq,
          text: `${buffered?.text ?? ''}${chunk.text}`,
        })
      } else if (response && shouldForwardIncrementalChunk(chunk.kind)) {
        turn.answer += chunk.text
        await turn.context.emitChunk(chunk.text, EventType.ANSWER_DELTA)
      } else {
        const buffered = turn.bufferedChildOutput.get(key)
        turn.bufferedChildOutput.set(key, {
          sequence: buffered?.sequence ?? event.seq,
          text: `${buffered?.text ?? ''}${chunk.text}`,
        })
      }
      return
    }

    if (event.type === 'assistant/message') {
      await this.flushStepBuffers(turn, session, event.data.turn, event.data.step)
    } else if (event.type === 'tool/call') {
      await this.flushStepBuffers(turn, session, event.data.turn, event.data.step)
    } else if (event.type === 'step/end') {
      await this.flushStepBuffers(turn, session, event.data.turn, event.data.step)
    }
    if (event.type === 'turn/end') await this.flushSessionBuffers(turn, session)

    if (response) turn.teamGate.observe(event)
    if (!turn.announcedChildren.has(String(session.id)) && !root) {
      turn.announcedChildren.add(String(session.id))
      await this.emitSessionEvent(turn, session, `${event.seq}:created`, 'session.created', 'ready', '子 Agent 已实例化')
    }

    if (event.type === 'tool/call') turn.toolNames.set(`${session.id}:${event.data.callId}`, event.data.name)
    if (event.type === 'tool/code-dispatch-start') {
      turn.toolNames.set(`${session.id}:${event.data.subCallId}`, event.data.name)
    }

    if (event.type === 'todo/write' && response) await this.emitPlan(turn, event.data.todos)
    const description = describeDshSessionEvent(event)
    if (description !== undefined) {
      const { eventKind, status, summary, ...details } = description
      const toolName = details.toolName ?? (details.toolCallId === undefined
        ? undefined
        : turn.toolNames.get(`${session.id}:${details.toolCallId}`))
      await this.emitSessionEvent(turn, session, event.seq, eventKind, status, summary, {
        ...details,
        ...(toolName === undefined ? {} : { toolName }),
      })
    }

    if (!root) await this.forwardChildLifecycle(turn, session, event)
    await this.emitTeamSnapshots(turn)
  }

  private activeTurnFor(session: Session): ActiveTurn | undefined {
    let cursor: Session | undefined = session
    const visited = new Set<string>()
    while (cursor !== undefined && !visited.has(String(cursor.id))) {
      const id = String(cursor.id)
      visited.add(id)
      const active = this.active.get(id)
      if (active !== undefined) return active
      const parentId: SessionId | undefined = cursor.header.parentSession
      cursor = parentId === undefined ? undefined : this.ctx.root.sessions.get(parentId)
    }
    return undefined
  }

  private externalMessageId(turn: ActiveTurn, sessionId: string): string {
    return sessionId === turn.rootSessionId ? turn.rootMessageId : `dsh:${sessionId}`
  }

  private async forwardChildLifecycle(turn: ActiveTurn, session: Session, event: SessionEvent): Promise<void> {
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') {
        await this.emitSessionEvent(turn, session, `${event.seq}:status`, 'session.status', 'running', '子 Agent 正在处理任务')
      }
      return
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'aborted') {
        await this.emitSessionEvent(turn, session, event.seq, 'session.status', 'waiting', '子 Agent 等待异步事件')
      } else {
        await this.emitSessionEvent(
          turn,
          session,
          event.seq,
          event.data.reason.kind === 'completed' ? 'session.status' : 'session.error',
          event.data.reason.kind === 'completed' ? 'completed' : 'failed',
          event.data.reason.kind === 'completed' ? '子 Agent 本轮处理完成' : '子 Agent 本轮处理失败',
        )
      }
    }
  }

  private async flushStepBuffers(
    turn: ActiveTurn,
    session: Session,
    turnNumber: number,
    stepNumber: number,
  ): Promise<void> {
    const key = `${session.id}:${turnNumber}:${stepNumber}`
    const reasoning = turn.bufferedReasoning.get(key)
    if (reasoning !== undefined) {
      turn.bufferedReasoning.delete(key)
      await this.emitSessionEvent(turn, session, `${reasoning.sequence}:think`, 'think', 'running', 'Think', {
        text: reasoning.text,
      })
    }
    const output = turn.bufferedChildOutput.get(key)
    if (output !== undefined) {
      turn.bufferedChildOutput.delete(key)
      await this.emitSessionEvent(turn, session, `${output.sequence}:output`, 'session.output', 'running', '子 Agent 输出', {
        text: output.text,
      })
    }
  }

  private async flushSessionBuffers(turn: ActiveTurn, session: Session): Promise<void> {
    const prefix = `${session.id}:`
    const keys = new Set([
      ...[...turn.bufferedReasoning.keys()].filter(key => key.startsWith(prefix)),
      ...[...turn.bufferedChildOutput.keys()].filter(key => key.startsWith(prefix)),
    ])
    for (const key of keys) {
      const parts = key.split(':')
      const step = Number(parts.pop())
      const turnNumber = Number(parts.pop())
      await this.flushStepBuffers(turn, session, turnNumber, step)
    }
  }

  private async emitSessionEvent(
    turn: ActiveTurn,
    session: Session,
    sequence: number | string,
    eventKind: DshSessionEventKind,
    status: DshSessionStatus,
    summary: string,
    details: {
      text?: string
      toolName?: string
      toolCallId?: string
      arguments?: string
      result?: string
      isError?: boolean
      contextSource?: string
      plan?: ReadonlyArray<{ content: string; status: string }>
    } = {},
  ): Promise<void> {
    const sessionId = String(session.id)
    const root = sessionId === turn.rootSessionId
    const messageId = this.externalMessageId(turn, sessionId)
    const parentSessionId = root ? undefined : String(session.header.parentSession ?? turn.rootSessionId)
    const parentMessageId = root
      ? turn.rootMessageId
      : this.externalMessageId(turn, parentSessionId ?? turn.rootSessionId)
    const presentation = root
      ? { label: turn.rootLabel }
      : dshChildPresentation(session, this.options.agentTemplateDir)
    const projectionContext = (detailParentMessageId: string): DshProjectionContext => ({
      eventKind,
      sessionId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      rootSessionId: turn.rootSessionId,
      externalParentSessionId: turn.context.sessionId,
      scope: root ? 'parent' : 'child',
      depth: session.header.delegationDepth ?? 0,
      sequence,
      status,
      ...(root ? {} : { childName: presentation.label }),
      ...(root || presentation.task === undefined ? {} : { childTask: presentation.task }),
      parentMessageId: detailParentMessageId,
      messageIdPrefix: messageId,
    })
    let projection: ByClawProjection
    if (eventKind === 'session.created' || eventKind === 'session.status' || eventKind === 'session.error') {
      projection = sessionStatusProjection({
        title: `${presentation.label} · ${summary}`,
        status,
      }, projectionContext(parentMessageId))
    } else if (eventKind === 'tool.call' || eventKind === 'tool.result') {
      projection = toolCallProjection({
        phase: eventKind === 'tool.call' ? 'start' : details.isError === true ? 'error' : 'success',
        toolCallId: details.toolCallId ?? `${messageId}:tool:${sequence}`,
        toolName: details.toolName,
        ...(eventKind === 'tool.call' && details.arguments !== undefined ? { input: details.arguments } : {}),
        ...(eventKind === 'tool.result' && details.result !== undefined ? { output: details.result } : {}),
        description: summary,
      }, projectionContext(messageId))
    } else if (eventKind === 'session.output') {
      projection = childOutputProjection(details.text ?? summary, projectionContext(messageId))
    } else {
      const text = eventKind === 'context' && details.text !== undefined
        ? `${summary}\n${details.text}`
        : details.text ?? summary
      projection = reasoningProjection(text, projectionContext(messageId))
    }
    await this.options.emitter.emitChunk(
      turn.context.sessionId,
      turn.context.traceId,
      projection.content,
      {
        ...projection.options,
        sourceAgentType: this.options.sourceAgentType,
      },
    )
  }

  private async emitPlan(turn: ActiveTurn, todos: TodoItem[]): Promise<void> {
    const card = taskPlanCard(todos)
    await this.options.emitter.emitChunk(turn.context.sessionId, turn.context.traceId, card.content, {
      eventType: EventType.ANSWER_DELTA,
      contentType: card.contentType as never,
      sourceAgentType: this.options.sourceAgentType,
      messageId: `${turn.rootMessageId}:plan`,
      parentMessageId: turn.rootMessageId,
      metadata: {
        dsh_event: 'todo/write',
        dsh_scope: 'parent',
        dsh_session_id: turn.rootSessionId,
        root_dsh_session_id: turn.rootSessionId,
        external_parent_session_id: turn.context.sessionId,
      },
    })
  }

  private async emitTeamSnapshots(turn: ActiveTurn): Promise<void> {
    const ownsCaptain = (captainSessionId: string): boolean => (
      captainSessionId === turn.rootSessionId || turn.announcedChildren.has(captainSessionId)
    )
    const roots = [{
      workspace: turn.workspace,
      stateRoot: join(turn.workspace, this.options.stateDir),
    }]
    let live: TeamActivitySnapshot[]
    let archived: TeamActivitySnapshot[]
    try {
      ;[live, archived] = await Promise.all([
        collectTeamsActivity(this.ctx, roots),
        collectArchivedTeamsActivity(this.ctx, roots),
      ])
    } catch (error: unknown) {
      this.ctx.logger.warn(`byclaw-dsh AgentTeams snapshot collection failed: ${String(error)}`)
      return
    }
    for (const [snapshots, isArchived] of [[live, false], [archived, true]] as const) {
      for (const team of selectOwnedTeamSnapshots(snapshots, ownsCaptain)) {
        const eventId = dshAgentTeamsSnapshotEventId(team, isArchived)
        if (turn.emittedTeamSnapshots.has(eventId)) continue
        turn.emittedTeamSnapshots.add(eventId)
        const projection = teamSnapshotProjection(team, {
          archived: isArchived,
          capturedAt: new Date().toISOString(),
        }, {
          sessionId: team.captainSessionId,
          ...(team.captainSessionId === turn.rootSessionId ? {} : { parentSessionId: turn.rootSessionId }),
          rootSessionId: turn.rootSessionId,
          externalParentSessionId: turn.context.sessionId,
          scope: 'team',
          depth: team.captainSessionId === turn.rootSessionId ? 0 : 1,
          sequence: eventId,
          eventKind: 'agent-teams/snapshot',
          status: isArchived ? 'completed' : 'running',
          parentMessageId: turn.rootMessageId,
          messageIdPrefix: turn.rootMessageId,
        })
        await this.options.emitter.emitChunk(
          turn.context.sessionId,
          turn.context.traceId,
          projection.content,
          {
            ...projection.options,
            sourceAgentType: this.options.sourceAgentType,
          },
        )
      }
    }
  }

  private lastAssistantText(agent: Agent): string {
    for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
      const event = agent.session.events[index]
      if (event?.type !== 'assistant/message') continue
      return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    }
    return ''
  }

  private externalSessionOf(agent: Agent): string {
    for (const [key, entry] of this.handles) {
      if (entry.handle.agent === agent) return key.split('\0')[1] ?? ''
    }
    return ''
  }
}
