/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * wakes it with {@link ctx.subagents.followup}, it works through its turn
 * (updating team state through the `agent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `agent_teams_status`.
 * @module dsh-agent-teams/members
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.subagents visible.
import { foldSubagentDescriptor, SubagentError, type SubagentReportDelivery } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { findTeamByParticipant, readRetiredMemberIds, readTeamSync } from './state.ts'
import type { TeamMember, TeamState } from './types.ts'

/** Captain-only AgentTeams tools hidden from newly spawned members. */
const MEMBER_DENIED_TOOLS = [
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_reassign_task',
  'agent_teams_create_task',
  'agent_teams_delete',
] as const

/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Runtime knobs for member spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Child delegation depth cap (0 forbids delegation entirely). */
  maxDepth?: number
}

/** Durable provider/model/reasoning snapshot for one member. */
export interface MemberLlmSelection {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit/default effort. */
  reasoningEffort?: string
}

/** Optional member-level route requested by the captain. */
export interface MemberLlmSelectionRequest {
  /** Explicit LLM provider route; requires an explicit model. */
  provider?: string
  /** Explicit model id; otherwise the plugin default or captain model is used. */
  model?: string
  /** Plugin-level member model default. */
  defaultModel?: string
}

/** Process-local bridge between spawn admission and synchronous child setup. */
export interface MemberSelectionRuntime {
  /** Make one selection visible while Harness materializes the fresh child. */
  withPending<T>(
    parentSessionId: string,
    label: string,
    selection: MemberLlmSelection,
    member: TeamMember,
    operation: () => Promise<T>,
  ): Promise<T>
}

const MEMBER_LABEL_PREFIX = 'agent-teams:'

function pendingSelectionKey(parentSessionId: string, label: string): string {
  return `${parentSessionId}\u0000${label}`
}

function selectionFromMember(member: TeamMember | undefined): MemberLlmSelection | undefined {
  if (member?.provider === undefined || member.model === undefined) return undefined
  const provider = member.provider.trim()
  const model = member.model.trim()
  if (provider === '' || model === '') return undefined
  const reasoningEffort = member.reasoningEffort?.trim()
  return {
    provider,
    model,
    ...reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort },
  }
}

function modelSelection(selection: MemberLlmSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
  }
}

interface RuntimeSkillRegistry {
  register(skill: {
    name: string
    description: string
    source: 'runtime'
    content: string
    path: string
    resourceBase: { kind: 'directory'; path: string }
  }): () => void
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.replace(/^\uFEFF/u, '').startsWith('---')) return undefined
  for (const line of content.split(/\r?\n/u).slice(1)) {
    if (line.trim() === '---' || line.trim() === '...') break
    const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'u').exec(line.trim())
    if (match?.[1] !== undefined) return match[1].trim().replace(/^(['"])(.*)\1$/u, '$2')
  }
  return undefined
}

function skillBody(content: string): string {
  const normalized = content.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---')) return normalized
  const lines = normalized.split(/\r?\n/u)
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---' || lines[index]?.trim() === '...') {
      return lines.slice(index + 1).join('\n').trimStart()
    }
  }
  return normalized
}

function installByClawMemberSkills(childCtx: Context, member: TeamMember): () => void {
  if (member.source === undefined || member.source.skills.length === 0) return () => undefined
  const skills = childCtx.get('skills') as unknown as RuntimeSkillRegistry | undefined
  if (skills === undefined) {
    throw new Error(`agent-teams: ByClaw member "${member.name}" has Skills but the DSH skill service is not mounted`)
  }
  const disposers: Array<() => void> = []
  try {
    for (const source of member.source.skills) {
      const skillFile = join(source.path, 'SKILL.md')
      const content = readFileSync(skillFile, 'utf8')
      const name = frontmatterValue(content, 'name') ?? source.code
      const description = frontmatterValue(content, 'description') ?? `ByClaw Skill ${source.code}`
      const definition = { name, description, content: skillBody(content), path: skillFile }
      disposers.push(skills.register({
        ...definition,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: dirname(skillFile) },
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** Force generic reports from live or retired AgentTeams children to stay non-waking. */
export function agentTeamsReportDelivery(
  activeMember: boolean,
  retiredMember: boolean,
  requested: SubagentReportDelivery,
): SubagentReportDelivery {
  return activeMember || retiredMember ? 'quiet' : requested
}

/** Keep AgentTeams member wakeups on the coalesced team-message path only. */
export function installAgentTeamsReportDeliveryGuard(ctx: Context, stateDir: string): void {
  const runtime = ctx.subagents
  ctx.effect(() => {
    const reportFrom = runtime.reportFrom
    const guardedReportFrom: typeof runtime.reportFrom = async (child, content, options) => {
      const stateRoot = join(child.session.header.cwd ?? process.cwd(), stateDir)
      const [team, retired] = await Promise.all([
        findTeamByParticipant(stateRoot, child.id),
        readRetiredMemberIds(stateRoot),
      ])
      return reportFrom.call(runtime, child, content, {
        ...options,
        delivery: agentTeamsReportDelivery(team !== undefined, retired.has(child.id), options.delivery),
      })
    }
    runtime.reportFrom = guardedReportFrom
    return () => {
      if (runtime.reportFrom === guardedReportFrom) runtime.reportFrom = reportFrom
    }
  }, 'agent-teams: quiet generic member reports')
}

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. An explicit member
 * provider/model or plugin-level model replaces only that route; the current
 * captain effort remains the inherited policy and is validated against the
 * target model before a child is created.
 */
export async function resolveMemberLlmSelection(
  ctx: Context,
  captain: Agent,
  request: MemberLlmSelectionRequest,
  signal?: AbortSignal,
): Promise<MemberLlmSelection> {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const defaultModel = request.defaultModel?.trim()
  if (request.provider !== undefined && explicitProvider === '') {
    throw new Error('member LLM provider must not be empty')
  }
  if (request.model !== undefined && explicitModel === '') {
    throw new Error('member model must not be empty')
  }
  if (request.defaultModel !== undefined && defaultModel === '') {
    throw new Error('configured memberModel must not be empty')
  }
  if (explicitProvider !== undefined && explicitModel === undefined) {
    throw new Error('an explicit member LLM provider requires an explicit member model')
  }

  const current = captain.session.requestHeader()?.config
  const provider = explicitProvider ?? current?.provider ?? captain.options.provider
  const model = explicitModel ?? defaultModel ?? current?.model ?? captain.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }

  const resolved = await ctx.llm.resolveCallConfig({
    provider,
    model,
    ...current?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: current.reasoningEffort },
  }, signal)
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(resolved.reasoningEffort) },
  }
}

/**
 * Install the member selection bridge for every fresh or cold-resumed
 * continuable child. Fresh creation reads the pending in-memory selection;
 * cold resume restores the same selection from the owning team's durable
 * record. Legacy members without a complete saved route retain Harness's
 * descriptor provider/model behavior.
 */
export function installMemberSelectionRuntime(ctx: Context, stateDir: string): MemberSelectionRuntime {
  const pending = new Map<string, MemberLlmSelection>()
  const pendingMembers = new Map<string, TeamMember>()
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const child = childCtx.agent
    if (child === undefined) return () => undefined
    const suffix = child.session.events.slice(child.session.header.seedLength ?? 0)
    const descriptor = foldSubagentDescriptor(suffix)
    if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
      return () => undefined
    }

    const parentSessionId = child.session.header.parentSession
    if (parentSessionId === undefined) return () => undefined
    const key = pendingSelectionKey(parentSessionId, descriptor.label)
    let selection = pending.get(key)
    if (selection === undefined) {
      const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
      const separator = identity.indexOf(':')
      if (separator < 1 || separator === identity.length - 1) return () => undefined
      const teamId = identity.slice(0, separator)
      const memberName = identity.slice(separator + 1)
      const workspace = child.session.header.cwd ?? process.cwd()
      const team = readTeamSync(join(workspace, stateDir), teamId)
      if (team?.captainSessionId !== parentSessionId) return () => undefined
      selection = selectionFromMember(team.members.find(member => member.name === memberName))
      // An old team record has no provider/reasoning snapshot. Its durable
      // Harness descriptor still restores provider/model, so leave it alone.
      if (selection === undefined) return () => undefined
      if (descriptor.agentProvider !== selection.provider || descriptor.agentModel !== selection.model) {
        throw new Error(
          `agent-teams: saved model route for member "${memberName}" does not match its subagent descriptor`,
        )
      }
    }

    const workspace = child.session.header.cwd ?? process.cwd()
    const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length)
    const separator = identity.indexOf(':')
    const team = separator < 1 ? undefined : readTeamSync(join(workspace, stateDir), identity.slice(0, separator))
    const member = pendingMembers.get(key)
      ?? (separator < 1 ? undefined : team?.members.find(candidate => candidate.name === identity.slice(separator + 1)))
    const disposeSkills = member === undefined ? () => undefined : installByClawMemberSkills(childCtx, member)
    const disposeByClawPreviewPrefix = member?.source?.kind === 'byclaw-digital-employee'
      ? childCtx.systemPrompt.variable('file_preview_prefix', () => '{{file_preview_prefix}}')
      : () => undefined
    const disposeReportPolicy = childCtx.systemPrompt.section({
      name: 'agent-teams:report-policy',
      order: 119,
      text: 'AgentTeams overrides the generic subagent report workflow. Persist task results with agent_teams_update_task and notify the captain with agent_teams_send_message(to=captain). Do not use the generic report tool; its delivery is quiet for AgentTeams members and does not wake the captain.',
    })
    const disposeSelection = installModelSelection(childCtx, {
      current: modelSelection(selection),
      assembled: undefined,
    })
    return () => {
      disposeReportPolicy()
      disposeByClawPreviewPrefix()
      disposeSkills()
      disposeSelection()
    }
  })

  return {
    async withPending<T>(
      parentSessionId: string,
      label: string,
      selection: MemberLlmSelection,
      member: TeamMember,
      operation: () => Promise<T>,
    ): Promise<T> {
      const key = pendingSelectionKey(parentSessionId, label)
      if (pending.has(key)) {
        throw new Error(`member model selection is already pending for "${label}"`)
      }
      pending.set(key, selection)
      pendingMembers.set(key, member)
      try {
        return await operation()
      } finally {
        pending.delete(key)
        pendingMembers.delete(key)
      }
    },
  }
}

/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 */
export function memberPersona(team: TeamState, member: TeamMember, stateDir: string): string {
  const enterprisePersona = member.source === undefined ? '' : `

ByClaw digital employee profile (frozen for this team generation):
- Resource id: ${member.source.employeeId}
- Description: ${member.source.description ?? 'not provided'}

Employee instructions:
${member.source.persona ?? member.source.capabilities ?? 'Follow the assigned role and team task contract.'}

Agent-scoped Skills: ${member.source.skills.length === 0 ? 'none' : member.source.skills.map(skill => skill.code).join(', ')}. When a task matches one, call the scoped \`skill\` tool before acting.`
  return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness AgentTeams. The captain leads the team; you are a worker member${member.role ? ` with the role: ${member.role}` : ''}.${enterprisePersona}

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the agent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Each message you receive is a new turn: act on it and end your turn with a concise reply.

Working rules:
1. When you receive a task assignment, call agent_teams_claim_task with the task id. Keep the returned attempt_id: include it in every agent_teams_update_task call for that execution attempt. Then mark the task in_progress.
2. Work thoroughly with your available tools; do not cut corners.
3. When finished, call agent_teams_update_task with the same attempt_id, status=completed, and a concise \`output\` summarizing what you did and the key results. A stale-attempt rejection means the captain reassigned or took over the task; stop touching that task and wait for new work.
4. Send a short report to the captain with agent_teams_send_message (to=captain) when you complete a task or hit a blocker.
5. To ask a teammate something, use agent_teams_send_message with to=<teammate name>; the message lands in their mailbox and wakes them directly — teammates talk to each other without the captain in the loop. The same applies to the captain (to=captain).
6. After your turn becomes idle, the shared task scheduler may assign your next ready task automatically. Never claim a second task while you still own unfinished work.
7. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain's job.`
}

/**
 * The initial user message delivered when the member is created.
 * @param team - the team the member joined.
 */
export function memberWelcome(team: TeamState): string {
  return `You have joined the team "${team.name}" as a member. The captain will send you tasks and messages; wait for instructions. Current team status: ${team.tasks.length} task(s), none assigned to you yet.`
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param selections - fresh/cold child model-selection bridge.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 */
export async function spawnMember(
  ctx: Context,
  config: MemberRuntimeConfig,
  selections: MemberSelectionRuntime,
  llmSelection: MemberLlmSelection,
  captain: Agent,
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  signal: AbortSignal,
): Promise<void> {
  // External-process member (claude-code bridge): the actual task execution
  // is routed through the claude CLI bridge by the scheduler (see
  // scheduler.ts). To make the member visible in the Harness session tree
  // (dsh UI subagent catalog, list_agents, click-to-open), we additionally
  // materialize a real continuable child "shell" session (origin: 'subagent')
  // through ctx.subagents.startContinuable: it carries the durable descriptor
  // and session so the member appears and is openable, while its LLM loop
  // stays idle (empty inbox, near-zero cost) because all task turns are
  // executed by the claude CLI bridge instead.
  if (member.runtime === 'claude-code') {
    const provider = ctx.subagents.getProvider(config.provider)
    if (provider === undefined || provider.prepareContinuable === undefined) {
      // No continuable provider available: fall back to the synthetic id so
      // the member still functions through the claude bridge, just without
      // Harness-session visibility.
      member.id = `claude-code:${member.name}`
      return
    }
    const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
    const shellWelcome =
      `你是一个 AgentTeams 外部成员壳会话（runtime: claude-code）。你的实际任务执行由 Claude Code CLI 桥完成，` +
      `本会话仅承载团队可见性（会话树/消息/历史）。团队: ${team.name}，成员: ${member.name}。` +
      `收到消息时无需执行任何工作，简短确认即可。`
    try {
      const start = await ctx.subagents.startContinuable({
        provider: config.provider,
        label,
        request: {
          prompt: [{ type: 'text', text: shellWelcome }],
          parent: captain,
          persona: memberPersona(team, member, stateDir),
          toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
          agentOptions: {
            provider: llmSelection.provider,
            model: llmSelection.model,
          },
          ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
        },
        signal,
      })
      member.id = start.childId
    } catch (error) {
      ctx.logger.warn(
        `agent-teams: claude-code member "${member.name}" shell session creation failed, ` +
        `falling back to synthetic id: ${error instanceof Error ? error.message : String(error)}`,
      )
      member.id = `claude-code:${member.name}`
    }
    return
  }
  // Fail loud at the first use: provider registration is a sibling plugin's
  // effect and may settle after this plugin mounts. Capability checks here
  // mirror what startContinuable would reject, with an actionable error.
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `agent-teams: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`agent-teams: provider "${config.provider}" does not support continuable members`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot apply a member persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`agent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`)
  }
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
  const start = await selections.withPending(captain.id, label, llmSelection, member, () => (
    ctx.subagents.startContinuable({
      provider: config.provider,
      label,
      request: {
        prompt: [{ type: 'text', text: memberWelcome(team) }],
        parent: captain,
        persona: memberPersona(team, member, stateDir),
        toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
        agentOptions: {
          provider: llmSelection.provider,
          model: llmSelection.model,
        },
        ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
      },
      signal,
    })
  ))
  member.id = start.childId
}

/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await ctx.subagents.followup(captain, brandedSessionId(childId), [{ type: 'text', text }], {
      source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
      signal,
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: followup to member ${childId} failed: ${String(error)}`)
    return false
  }
}

/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`)
  }
}

/** Resolve one live parent's workspace-scoped retirement index. */
async function retiredForParent(ctx: Context, parentId: SessionId, stateDir: string): Promise<Set<string>> {
  const parent = ctx.agents.get(parentId)
  return parent === undefined
    ? new Set()
    : readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
}

/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * AgentTeams index therefore guards all three public continuation boundaries:
 * retired rows disappear from `list_agents` (children and descendants), and a
 * direct `followup()` is rejected before it can cold-resume the member. Exact
 * ids keep unrelated subagents untouched; transcripts remain in persistence
 * for archived-team review.
 */
export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {
  const runtime = ctx.subagents
  ctx.effect(() => {
    const listChildren = runtime.listChildren
    const listDescendants = runtime.listDescendants
    const followup = runtime.followup

    const guardedChildren: typeof runtime.listChildren = async (parentId, signal) => {
      const [entries, retired] = await Promise.all([
        listChildren.call(runtime, parentId, signal),
        retiredForParent(ctx, parentId, stateDir),
      ])
      return entries.filter(entry => !retired.has(entry.id))
    }
    const guardedDescendants: typeof runtime.listDescendants = async (rootId, signal) => {
      const [entries, retired] = await Promise.all([
        listDescendants.call(runtime, rootId, signal),
        retiredForParent(ctx, rootId, stateDir),
      ])
      return entries.filter(entry => !retired.has(entry.id))
    }
    const guardedFollowup: typeof runtime.followup = async (parent, childId, content, options) => {
      const retired = await readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
      if (retired.has(childId)) {
        throw new SubagentError(
          `AgentTeams member "${childId}" was retired and cannot be resumed`,
          'NOT_RESUMABLE',
        )
      }
      return followup.call(runtime, parent, childId, content, options)
    }

    runtime.listChildren = guardedChildren
    runtime.listDescendants = guardedDescendants
    runtime.followup = guardedFollowup
    return () => {
      if (runtime.listChildren === guardedChildren) runtime.listChildren = listChildren
      if (runtime.listDescendants === guardedDescendants) runtime.listDescendants = listDescendants
      if (runtime.followup === guardedFollowup) runtime.followup = followup
    }
  }, 'agent-teams: retired member guard')
}

/**
 * Snapshot each direct continuable child's real driver activity under the
 * captain's session. `listChildren().activity` is only session residency, so
 * live children are refined through the Agent registry exactly like Harness's
 * shipped `list_agents` tool.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captainSessionId - the captain's session id.
 * @returns child id → activity, missing entries are unknown children.
 */
export async function memberActivity(
  ctx: Context,
  captainSessionId: string,
): Promise<Map<string, 'running' | 'idle' | 'ready'>> {
  const entries = await ctx.subagents.listChildren(brandedSessionId(captainSessionId))
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const entry of entries) {
    if (entry.kind !== 'child') continue
    const live = ctx.agents.get(entry.id)
    activity.set(entry.id, live === undefined ? 'ready' : live.status)
  }
  return activity
}
