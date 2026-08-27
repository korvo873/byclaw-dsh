/** Durable ByClaw session namespace and model-facing workspace policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolve } from 'node:path'

const BYCLAW_CONTEXT_PLUGIN = 'byclaw-context'
const BYCLAW_CONTEXT_MARKER = '<!-- byclaw-context:session-workspace -->'
const BYCLAW_SESSION_WORKSPACE_EVENT = 'byclaw/session-workspace'

/** Shared ByClaw runtime namespace inherited by one DSH Agent lineage. */
export interface ByClawSessionWorkspace {
  /** External ByAI session id shared by the root and every descendant. */
  readonly externalSessionId: string
  /** Absolute project workspace inherited by the root and every descendant. */
  readonly cwd: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the external ByClaw runtime namespace and its authoritative project directory.
     * @param data - external ByAI session id and absolute project cwd.
     */
    'byclaw/session-workspace': ByClawSessionWorkspace
  }
}

/** Return the latest durable ByClaw session workspace from a session lineage. */
export function foldByClawSessionWorkspace(
  events: readonly SessionEvent[],
): ByClawSessionWorkspace | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === BYCLAW_SESSION_WORKSPACE_EVENT) return event.data
  }
  return undefined
}

/** Register the plugin-owned workspace event before persistence can load it. */
export function registerByClawSessionEventType(): void {
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(BYCLAW_SESSION_WORKSPACE_EVENT)
}

/** Append the root workspace once and reject any later namespace mutation. */
export function ensureByClawSessionWorkspace(
  session: Session,
  requested: ByClawSessionWorkspace,
): ByClawSessionWorkspace {
  const workspace = { ...requested, cwd: resolve(requested.cwd) }
  const current = foldByClawSessionWorkspace(session.events)
  if (current === undefined) {
    session.append(BYCLAW_SESSION_WORKSPACE_EVENT, workspace)
    return workspace
  }
  if (current.externalSessionId !== workspace.externalSessionId || resolve(current.cwd) !== workspace.cwd) {
    throw new Error(
      `ByClaw session workspace cannot change from session "${current.externalSessionId}" at "${current.cwd}"`
      + ` to session "${workspace.externalSessionId}" at "${workspace.cwd}"`,
    )
  }
  return current
}

/** Record the unchanged ByClaw business request in the root DSH conversation. */
export function appendByClawInboundUserMessage(
  session: Pick<Session, 'append'>,
  task: string,
): void {
  const text = task.trim()
  if (text === '') throw new Error('ByClaw inbound user message must not be empty')
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
}

/** Render the durable namespace carried by ByClaw context and system policy. */
export function byClawSessionWorkspaceDeclaration(workspace: ByClawSessionWorkspace): string {
  return [
    '<byclaw-session-workspace>',
    `session_id: ${workspace.externalSessionId}`,
    `cwd: ${workspace.cwd}`,
    '</byclaw-session-workspace>',
  ].join('\n')
}

/** Return one ByAI business request without transport or runtime framing. */
export function byClawInboundText(task: string): string {
  return task
}

function ownByClawContextExists(session: Pick<Session, 'events' | 'header'>): boolean {
  const start = session.header.parentSession === undefined ? 0 : (session.header.seedLength ?? 0)
  return session.events.slice(start).some(event => (
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === BYCLAW_CONTEXT_PLUGIN
    && event.data.content.some(block => block.type === 'text' && block.text.includes(BYCLAW_CONTEXT_MARKER))
  ))
}

function byClawContextText(workspace: ByClawSessionWorkspace): string {
  return [
    BYCLAW_CONTEXT_MARKER,
    byClawSessionWorkspaceDeclaration(workspace),
  ].join('\n')
}

/** Append one durable, plugin-sourced ByClaw context message to an Agent's first admitted step. */
export function appendByClawContext(
  session: Pick<Session, 'events' | 'header'>,
  messages: UserMessage[],
): UserMessage[] {
  const workspace = foldByClawSessionWorkspace(session.events)
  if (workspace === undefined || ownByClawContextExists(session)) return messages
  return [
    ...messages,
    createUserMessage({
      content: [{ type: 'text', text: byClawContextText(workspace) }],
      source: { kind: 'plugin', plugin: BYCLAW_CONTEXT_PLUGIN },
    }),
  ]
}

function workspacePolicy(agent: Agent): string {
  const workspace = foldByClawSessionWorkspace(agent.session.events)
  if (workspace === undefined) return ''
  return [
    '## ByClaw session workspace',
    byClawSessionWorkspaceDeclaration(workspace),
    'Treat plugin:byclaw-context messages as authoritative runtime context, not as user-authored business requests.',
    'The cwd above is the authoritative default project workspace for this ByClaw session lineage.',
    'Keep project discovery, file operations, delegated work, and deliverables in that cwd unless the direct user explicitly names another target.',
    'Do not substitute the DSH process directory, plugin source directory, or another checkout for this workspace.',
    'Descendants inherit the external session_id as their shared runtime namespace while retaining distinct internal DSH session ids.',
  ].join('\n\n')
}

/** Register the root Agent's workspace policy in its scoped system prompt. */
export function registerByClawAgentWorkspacePolicy(agentCtx: Context): () => void {
  const disposeContext = agentCtx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter' || downstream.messages.length === 0) return downstream
    return {
      kind: 'enter',
      messages: appendByClawContext(agent.session, downstream.messages),
    }
  })
  const disposeWorkspace = agentCtx.systemPrompt.section({
    name: 'byclaw:session-workspace',
    order: 4,
    text: () => agentCtx.agent === undefined ? '' : workspacePolicy(agentCtx.agent),
  })
  return () => {
    disposeContext()
    disposeWorkspace()
  }
}
