/** Durable ByClaw session namespace and model-facing workspace policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolve } from 'node:path'

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
    if (event?.type === 'byclaw/session-workspace') return event.data
  }
  return undefined
}

/** Append the root workspace once and reject any later namespace mutation. */
export function ensureByClawSessionWorkspace(
  session: Session,
  requested: ByClawSessionWorkspace,
): ByClawSessionWorkspace {
  const workspace = { ...requested, cwd: resolve(requested.cwd) }
  const current = foldByClawSessionWorkspace(session.events)
  if (current === undefined) {
    session.append('byclaw/session-workspace', workspace)
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

/** Render the durable namespace carried by ByClaw inbound messages and system policy. */
export function byClawSessionWorkspaceDeclaration(workspace: ByClawSessionWorkspace): string {
  return [
    '<byclaw-session-workspace>',
    `session_id: ${workspace.externalSessionId}`,
    `cwd: ${workspace.cwd}`,
    '</byclaw-session-workspace>',
  ].join('\n')
}

/** Frame one inbound business request with its durable ByClaw session workspace. */
export function byClawInboundPrompt(workspace: ByClawSessionWorkspace, task: string): string {
  return [
    byClawSessionWorkspaceDeclaration(workspace),
    '<user-request>',
    task,
    '</user-request>',
  ].join('\n\n')
}

function workspacePolicy(agent: Agent): string {
  const workspace = foldByClawSessionWorkspace(agent.session.events)
  if (workspace === undefined) return ''
  return [
    '## ByClaw session workspace',
    byClawSessionWorkspaceDeclaration(workspace),
    'The cwd above is the authoritative default project workspace for this ByClaw session lineage.',
    'Keep project discovery, file operations, delegated work, and deliverables in that cwd unless the direct user explicitly names another target.',
    'Do not substitute the DSH process directory, plugin source directory, or another checkout for this workspace.',
    'Descendants inherit the external session_id as their shared runtime namespace while retaining distinct internal DSH session ids.',
  ].join('\n\n')
}

const CODEGRAPH_TOOL_PREFIX = 'mcp__codegraph__codegraph_'

/** Return the CodeGraph MCP tools visible to one Agent's exact runtime scope. */
export function byClawCodeGraphToolNames(agent: Agent): string[] {
  return agent.ctx.tools.schemas(agent)
    .map(tool => tool.name)
    .filter(name => name.startsWith(CODEGRAPH_TOOL_PREFIX))
    .sort()
}

const CODEGRAPH_TOOL_RULES = [
  ['context', 'For architecture, onboarding, or broad project context, call codegraph_context first.'],
  ['explore', 'After codegraph_context, use one codegraph_explore call when several related symbols need source inspection.'],
  ['trace', 'For an end-to-end call path, call codegraph_trace first, then at most one codegraph_explore for the returned hops.'],
  ['search', 'Use codegraph_search to locate a symbol by name; do not grep for structural symbol lookup.'],
  ['callers', 'Use codegraph_callers to find what invokes one symbol.'],
  ['callees', 'Use codegraph_callees to find what one symbol invokes.'],
  ['impact', 'Use codegraph_impact to evaluate the change radius of a symbol.'],
  ['node', 'Use codegraph_node for one symbol signature, source, or docstring; do not loop it over many symbols.'],
  ['files', 'Use codegraph_files to inspect a directory structurally.'],
  ['status', 'Use codegraph_status to check whether the selected project index is ready.'],
] as const

function codeGraphPolicy(agent: Agent): string {
  const workspace = foldByClawSessionWorkspace(agent.session.events)
  if (workspace === undefined) return ''
  const visible = new Set(byClawCodeGraphToolNames(agent))
  const rules = CODEGRAPH_TOOL_RULES.flatMap(([suffix, rule]) => (
    visible.has(`${CODEGRAPH_TOOL_PREFIX}${suffix}`) ? [`- ${rule}`] : []
  ))
  if (rules.length === 0) return ''
  return [
    '## CodeGraph',
    `CodeGraph is available for the current ByClaw workspace. Every CodeGraph call must set projectPath=${workspace.cwd}; never rely on the MCP process directory.`,
    'Use CodeGraph for structural questions such as definitions, call relationships, execution paths, architecture, and change impact. Use native text search only for literal strings, comments, or log messages.',
    ...rules,
    'Trust returned structural results instead of repeating the same lookup with text search. Allow about one second for the index watcher after writes.',
    'If CodeGraph reports that this project is not initialized, ask the user before running codegraph init -i unless an explicitly authorized initialization Skill owns that operation.',
  ].join('\n')
}

/** Register the root Agent's workspace policy in its scoped system prompt. */
export function registerByClawAgentWorkspacePolicy(agentCtx: Context): () => void {
  const disposeWorkspace = agentCtx.systemPrompt.section({
    name: 'byclaw:session-workspace',
    order: 4,
    text: () => agentCtx.agent === undefined ? '' : workspacePolicy(agentCtx.agent),
  })
  const disposeCodeGraph = agentCtx.systemPrompt.section({
    name: 'byclaw:codegraph-policy',
    order: 117,
    text: () => agentCtx.agent === undefined ? '' : codeGraphPolicy(agentCtx.agent),
  })
  return () => {
    disposeCodeGraph()
    disposeWorkspace()
  }
}
