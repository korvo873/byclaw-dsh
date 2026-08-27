/** Durable DSH root-session runtime used by the BYCLAW_DSH Worker. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type TodoItem } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  EventType,
  type AgentContext,
  type AskAgentCommand,
  type GatewayDataEmitter,
  type ResumeCommand,
} from '@byclaw/by-framework'
import { createHash } from 'node:crypto'
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
  appendByClawInboundUserMessage,
  byClawInboundText,
  ensureByClawSessionWorkspace,
  registerByClawAgentWorkspacePolicy,
} from './session-workspace.ts'
import {
  ByClawQuestionBroker,
  askUserQuestionsCard,
  dshAgentTeamsSnapshotCard,
  dshSessionEventCard,
  extractByClawUserText,
  parseDshInteractionResponse,
  selectOwnedTeamSnapshots,
  taskPlanCard,
  type DshSessionEventKind,
  type DshSessionStatus,
} from './protocol.ts'

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
  announcedChildren: Set<string>
  emittedTeamSnapshots: Set<string>
  bufferedReasoning: Map<string, { sequence: number; text: string }>
  bufferedChildOutput: Map<string, { sequence: number; text: string }>
  toolNames: Map<string, string>
}

/** Prevent a direct ByClaw turn from waking the main Agent on child settlement. */
export function shouldSuppressDirectSettlement(
  direct: boolean,
  messages: readonly UserMessage[],
): boolean {
  return direct
    && messages.length > 0
    && messages.every(message => message.source.kind === 'subagent-settled')
}

interface RootHandle {
  handle: AgentHandle
  selection: ModelSelectionRef
  mode: 'reuse' | 'resume' | 'create'
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

/** Build a stable child identity for one direct ByClaw resource conversation. */
export function byClawDirectTemplateSessionId(
  userCode: string,
  externalSessionId: string,
  templateId: string,
): SessionId {
  const suffix = createHash('sha256')
    .update(userCode)
    .update('\0')
    .update(externalSessionId)
    .update('\0')
    .update(templateId)
    .digest('hex')
    .slice(0, 32)
  return SessionId(`byclaw-dsh-direct-v1-${suffix}`)
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
  failure: string | undefined
  completion: Promise<void> = Promise.resolve()
  private kind: 'team' | 'template' | undefined
  private teamActive = false
  private deleteCallId: string | undefined
  private templateCallId: string | undefined
  private templateReported = false
  private resolveCompletion: (() => void) | undefined

  observe(event: SessionEvent): void {
    if (event.type === 'tool/call' && event.data.name === 'agent_teams_start') {
      if (!this.waiting) {
        this.waiting = true
        this.kind = 'team'
        this.teamActive = true
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
      }
      return
    }
    if (event.type === 'tool/call' && event.data.name === 'byclaw_instantiate_template') {
      if (!this.waiting) {
        this.waiting = true
        this.kind = 'template'
        this.templateReported = false
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
      }
      this.templateCallId = event.data.callId
      return
    }
    if (event.type === 'tool/call' && event.data.name === 'agent_teams_delete') {
      this.deleteCallId = event.data.callId
      return
    }
    if (event.type === 'tool/result' && this.deleteCallId !== undefined) {
      const result = event.data.message.content.find(block => (
        block.type === 'tool-result' && block.toolCallId === this.deleteCallId
      ))
      if (result?.type === 'tool-result' && result.isError !== true) this.teamActive = false
      this.deleteCallId = undefined
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
      ? !this.teamActive
      : this.templateReported && event.data.reason.kind === 'completed'
    if (event.data.reason.kind === 'completed' && !completed && this.kind === 'team') {
      this.failure = 'AgentTeams turn completed before agent_teams_delete settled'
    }
    if (event.data.reason.kind === 'error' || completed || this.failure !== undefined) {
      this.waiting = false
      this.kind = undefined
      this.resolveCompletion?.()
      this.resolveCompletion = undefined
    }
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
    const directChildSessionId = directTarget === undefined
      ? undefined
      : byClawDirectTemplateSessionId(command.header.userCode, route.externalRootSessionId, directTarget.templateId)
    console.info(
      `[byclaw-dsh] 📥 收到命令: type=AskAgentCommand, message_id=${command.header.messageId}, trace_id=${context.traceId}, session_id=${command.header.sessionId}`,
    )
    const selection = await this.options.resolveModel(`root:${command.header.userCode}:${route.externalRootSessionId}`)
    const diagnostic = selection as ModelSelection & {
      sourceModelId?: string
      protocol?: string
      resolution?: string
    }
    const entry = await this.handleFor(command, selection)
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
    const responseSessionId = String(directChildSessionId ?? route.targetDshSessionId ?? rootAgent.id)
    if (directTarget !== undefined && directChildSessionId !== undefined) {
      console.info(
        `[byclaw-dsh] 🎯 入站直达 (resource=${directTarget.resourceId}, kind=${directTarget.kind}, template=${directTarget.templateId}, dsh_session=${directChildSessionId}, scope=direct)`,
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
      announcedChildren: new Set(),
      emittedTeamSnapshots: new Set(),
      bufferedReasoning: new Map(),
      bufferedChildOutput: new Map(),
      toolNames: new Map(),
    }
    this.active.set(String(rootAgent.id), turn)
    try {
      if (directTarget !== undefined) appendByClawInboundUserMessage(rootAgent.session, text)
      const agent = directTarget === undefined
        ? await this.deliverToSelectedAgent(rootAgent, route, byClawInboundText(text))
        : await this.deliverToInboundTarget(rootAgent, directTarget, directChildSessionId as SessionId)
      this.messageAgents.set(command.header.messageId, agent)
      await agent.whenIdle()
      await turn.forwarding
      if (turn.teamGate.waiting) await turn.teamGate.completion
      await turn.forwarding
      if (turn.teamGate.failure !== undefined) throw new Error(`DSH async settlement failed: ${turn.teamGate.failure}`)
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

  private async deliverToInboundTarget(
    rootAgent: Agent,
    target: ByClawInboundTarget,
    childSessionId: SessionId,
  ): Promise<Agent> {
    if (this.options.templateRuntime === undefined) {
      throw new Error('ByClaw direct template routing is not configured')
    }
    return this.options.templateRuntime.deliver(
      rootAgent,
      target.templateId,
      target.text,
      childSessionId,
      new AbortController().signal,
    )
  }

  private async handleFor(command: AskAgentCommand, selected: ModelSelection): Promise<RootHandle> {
    const route = byClawCommandSessionRoute(command)
    const externalRootSessionId = route.externalRootSessionId
    const key = `${command.header.userCode}\0${externalRootSessionId}`
    const existing = this.handles.get(key)
    if (existing !== undefined && this.ctx.agents.get(existing.handle.agent.id) === existing.handle.agent) {
      assertStableSessionCwd(externalRootSessionId, existing.handle.agent.session.header.cwd, route.cwd)
      return { ...existing, mode: 'reuse' }
    }
    const sessionId = byClawRootSessionId(externalRootSessionId, command.header.userCode)
    const selection: ModelSelectionRef = { current: selected, assembled: undefined }
    const setup = async (agentCtx: Context): Promise<void> => {
        await this.ctx.agentPresets.mount(agentCtx, this.options.agentPreset)
        installModelSelection(agentCtx, selection)
        installByClawTaskPlanTool(agentCtx)
        registerByClawAgentWorkspacePolicy(agentCtx)
        agentCtx.on('agent/pre-step', ({ agent, messages }, next) => {
          const active = this.activeTurnFor(agent.session)
          return shouldSuppressDirectSettlement(active?.direct === true, messages)
            ? Promise.resolve({ kind: 'reject' as const })
            : next()
        })
        agentCtx.systemPrompt.section({
          name: 'byclaw-dsh:authorized-resources',
          order: 116,
          text: this.options.rosterPrompt,
        })
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
      sessionPersistence: { list(): Promise<ReadonlyArray<{ id: string; cwd?: string }>> }
    }).sessionPersistence
    if (live !== undefined) assertStableSessionCwd(externalRootSessionId, live.session.header.cwd, route.cwd)
    const persistedHeader = live === undefined
      ? (await persistence.list()).find(header => header.id === sessionId)
      : undefined
    if (persistedHeader !== undefined) {
      assertStableSessionCwd(externalRootSessionId, persistedHeader.cwd, route.cwd)
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
    const entry = { handle, selection, mode }
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
    const messageId = this.externalMessageId(turn, sessionId)
    const parentSessionId = String(session.header.parentSession ?? turn.rootSessionId)
    const parentMessageId = this.externalMessageId(turn, parentSessionId)
    const presentation = sessionId === turn.rootSessionId
      ? { label: '主 Agent' }
      : dshChildPresentation(session, this.options.agentTemplateDir)
    const card = dshSessionEventCard({
      eventId: `${sessionId}:${sequence}`,
      eventKind,
      sessionId,
      parentSessionId,
      depth: session.header.delegationDepth ?? 0,
      ...presentation,
      status,
      occurredAt: new Date().toISOString(),
      summary,
      ...details,
    })
    await this.options.emitter.emitEvent({
      sessionId: turn.context.sessionId,
      traceId: turn.context.traceId,
      eventType: EventType.REASONING_LOG_DELTA,
      sourceAgentType: this.options.sourceAgentType,
      messageId: `${messageId}:event:${sequence}`,
      parentMessageId,
      data: {
        choices: [{ delta: { content: card.content } }],
        content_type: card.contentType,
        status: '_DONE_',
        order_id: `${messageId}:event:${sequence}`,
        parent_order_id: parentMessageId,
      },
      metadata: {
        dsh_event: 'subagent/session',
        dsh_session_id: sessionId,
        parent_dsh_session_id: parentSessionId,
        delegation_depth: session.header.delegationDepth ?? 0,
      },
    })
  }

  private async emitPlan(turn: ActiveTurn, todos: TodoItem[]): Promise<void> {
    const card = taskPlanCard(todos)
    await this.options.emitter.emitChunk(turn.context.sessionId, turn.context.traceId, card.content, {
      eventType: EventType.ANSWER_DELTA,
      contentType: card.contentType as never,
      sourceAgentType: this.options.sourceAgentType,
      messageId: `${turn.rootMessageId}:plan`,
      parentMessageId: turn.rootMessageId,
      metadata: { dsh_event: 'todo/write', dsh_session_id: turn.rootSessionId },
    })
  }

  private async emitTeamSnapshots(turn: ActiveTurn): Promise<void> {
    const ownsCaptain = (captainSessionId: string): boolean => (
      captainSessionId === turn.rootSessionId || turn.announcedChildren.has(captainSessionId)
    )
    const roots = [{
      workspace: this.options.workspace,
      stateRoot: join(this.options.workspace, this.options.stateDir),
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
        const card = dshAgentTeamsSnapshotCard(team, {
          archived: isArchived,
          capturedAt: new Date().toISOString(),
        })
        if (turn.emittedTeamSnapshots.has(card.eventId)) continue
        turn.emittedTeamSnapshots.add(card.eventId)
        await this.options.emitter.emitEvent({
          sessionId: turn.context.sessionId,
          traceId: turn.context.traceId,
          eventType: EventType.REASONING_LOG_DELTA,
          sourceAgentType: this.options.sourceAgentType,
          messageId: `${turn.rootMessageId}:team:${card.eventId}`,
          parentMessageId: turn.rootMessageId,
          data: {
            choices: [{ delta: { content: card.content } }],
            content_type: card.contentType,
            status: '_DONE_',
            order_id: `${turn.rootMessageId}:team:${card.eventId}`,
            parent_order_id: turn.rootMessageId,
          },
          metadata: {
            dsh_event: 'agent-teams/snapshot',
            dsh_session_id: team.captainSessionId,
            team_id: team.teamId,
            archived: isArchived,
          },
        })
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
