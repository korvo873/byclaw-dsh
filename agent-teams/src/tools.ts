/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import {
  acknowledgeMailbox,
  appendMailbox,
  archiveTeamDir,
  beginTaskAttempt,
  CAPTAIN_KEY,
  createMessage,
  createTeamDir,
  findTeamByCaptain,
  findTeamByParticipant,
  invalidateTaskAttempt,
  readUnreadMailbox,
  validateControlledTaskGraph,
  recordRetiredMemberIds,
  releaseMailboxDelivery,
  readTeam,
  sanitizeKey,
  transitionError,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
} from './state.ts'
import {
  deliverToMember,
  installAgentTeamsReportDeliveryGuard,
  installRetiredMemberGuard,
  installMemberSelectionRuntime,
  interruptMember,
  memberActivity,
  resolveMemberLlmSelection,
  spawnMember,
  type MemberRuntimeConfig,
} from './members.ts'
import { TERMINAL_TASK_STATUSES, type TeamMember, type TeamMessage, type TeamState, type TeamTask } from './types.ts'
import { installTeamScheduler } from './scheduler.ts'
import {
  type ExpertTeamTemplate,
  type RuntimeInstanceView,
  listRuntimeInstances,
  listTeamTemplates,
  readRuntimeInstance,
  readTeamTemplate,
  registerRuntimeInstance,
  unregisterRuntimeInstance,
  writeTeamTemplate,
} from './catalog.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Member subagent provider name. */
  memberProvider: string
  /** Optional member model override. */
  memberModel?: string
  /** Member delegation depth cap. */
  memberMaxDepth?: number
  /** Team size cap (members). */
  maxMembers: number
  /** Enable deterministic draft/start and completion gates. */
  controlledWorkflow?: boolean
  /** Maximum automatic generations for one task. */
  maxTaskAttempts: number
  /** Machine-global reusable expert-team catalog. */
  catalogDir?: string
}

interface CatalogGenerationCoordinator {
  read<T>(catalogDir: string, operation: () => Promise<T>): Promise<T>
  write<T>(catalogDir: string, operation: () => Promise<T>): Promise<T>
}

/** Coordinate one templates-catalog operation when ByClaw integration is installed. */
async function withCatalogGeneration<T>(
  ctx: Context,
  catalogDir: string | undefined,
  mode: 'read' | 'write',
  operation: () => Promise<T>,
): Promise<T> {
  if (catalogDir === undefined) return operation()
  // A non-strict read keeps an unloading provider authoritative until its
  // ordered disposer has closed admission, drained work, and removed it.
  const coordinator = ctx.get('byclawGenerationLease', false) as unknown as CatalogGenerationCoordinator | undefined
  if (coordinator === undefined) return operation()
  return mode === 'read'
    ? coordinator.read(catalogDir, operation)
    : coordinator.write(catalogDir, operation)
}

/** Register one AgentTeams tool for the lifetime of the current plugin fiber. */
export function registerAgentTeamsTool(ctx: Context, tool: ToolDefinition): void {
  ctx.effect(() => ctx.tools.register(tool), `agent-teams: ${tool.name} tool`)
}

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The captain's workspace directory (team state root parent). */
function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** Resolved absolute state root. */
function stateRootOf(workspace: string, config: ToolsConfig): string {
  return join(workspace, config.stateDir)
}

/** Process-local lock key scoped by workspace state root and team id. */
function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

/** Process-local lock key enforcing one active team per captain session. */
function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/** The team this captain currently leads, or a loud failure. */
async function requireCaptainTeam(workspace: string, config: ToolsConfig, captain: Agent): Promise<TeamState> {
  const team = await findTeamByCaptain(stateRootOf(workspace, config), captain.id)
  if (team === undefined) {
    throw new Error('you are not leading any team yet — call agent_teams_create first')
  }
  return team
}

/** The team this captain or active member currently participates in. */
async function requireParticipantTeam(workspace: string, config: ToolsConfig, caller: Agent): Promise<TeamState> {
  const team = await findTeamByParticipant(stateRootOf(workspace, config), caller.id)
  if (team === undefined) {
    throw new Error('you do not lead or belong to any active team yet — use agent_teams_list_instances for global team metadata, then agent_teams_submit_task to append independent work')
  }
  return team
}

/** Resolve one discoverable runtime team without granting participant rights. */
async function requireGlobalInstance(config: ToolsConfig, id: string): Promise<RuntimeInstanceView> {
  if (config.catalogDir === undefined) throw new Error('global expert-team catalog is not configured')
  const instance = await readRuntimeInstance(config.catalogDir, id)
  if (instance === undefined) throw new Error(`global Agent Teams instance "${id}" was not found`)
  if (instance.status !== 'active') throw new Error(`global Agent Teams instance "${id}" is stale; its runtime state no longer exists`)
  return instance
}

type ParticipantIdentity =
  | { kind: 'captain'; name: typeof CAPTAIN_KEY }
  | { kind: 'member'; name: string }

/** Re-derive a caller's role from fresh state while holding the team lock. */
function participantIdentityOf(team: TeamState, agentId: string): ParticipantIdentity | undefined {
  if (team.captainSessionId === agentId) return { kind: 'captain', name: CAPTAIN_KEY }
  const member = team.members.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return member === undefined ? undefined : { kind: 'member', name: member.name }
}

/** Fresh state for a team that still exists; never falls back to stale lookup data. */
async function requireFreshTeam(stateRoot: string, teamId: string): Promise<TeamState> {
  const fresh = await readTeam(stateRoot, teamId)
  if (fresh === undefined) throw new Error(`team "${teamId}" is no longer active`)
  return fresh
}

/** Fresh state with captain authorization rechecked inside the lock. */
async function requireFreshCaptainTeam(
  stateRoot: string,
  teamId: string,
  captainId: string,
): Promise<TeamState> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  if (fresh.captainSessionId !== captainId) {
    throw new Error(`only the captain of team "${fresh.name}" may perform this operation`)
  }
  return fresh
}

/** Fresh state and caller identity rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  teamId: string,
  callerId: string,
): Promise<{ team: TeamState; identity: ParticipantIdentity }> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer an active participant in team "${fresh.name}"`)
  return { team: fresh, identity }
}

/** Look up one live (non-removed) member by display name. */
function requireMember(team: TeamState, name: string): TeamMember {
  const member = team.members.find((candidate) => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) {
    throw new Error(`no active member named "${name}" in team "${team.name}"`)
  }
  return member
}

/** Look up one task by id. */
function requireTask(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) {
    throw new Error(`no task "${taskId}" in team "${team.name}" — use agent_teams_status to list tasks`)
  }
  return task
}

function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

async function waitForMemberIdle(ctx: Context, member: TeamMember, signal: AbortSignal): Promise<void> {
  if (member.id === '') return
  const live = ctx.agents.get(member.id as SessionId)
  if (live === undefined) return
  if (signal.aborted) throw signal.reason
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('task reassignment was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([live.whenIdle(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Deliver a durable member report at the captain's nearest model boundary.
 *
 * `Agent.steer()` targets the next step while the captain is running, wakes a
 * new turn when it is idle, and lets the Agent runtime reclassify an aborted
 * activity to `next-turn`. This prevents reports from waiting behind the
 * captain's entire orchestration turn.
 */
export function steerCaptainReport(captain: Pick<Agent, 'steer'>, from: string, content: string): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text: `AgentTeams message from member ${from}:\n\n${content}` }],
      source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
    }))
    return true
  } catch {
    // The plugin mailbox was persisted before this best-effort live delivery.
    return false
  }
}

/** Coalesce concurrent member reports into at most one scheduled captain turn. */
export class CaptainWakeCoalescer {
  private readonly pending = new Set<string>()

  claim(captainSessionId: string): boolean {
    if (this.pending.has(captainSessionId)) return false
    this.pending.add(captainSessionId)
    return true
  }

  release(captainSessionId: string): void {
    this.pending.delete(captainSessionId)
  }

  has(captainSessionId: string): boolean {
    return this.pending.has(captainSessionId)
  }
}

/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export function registerAgentTeamsTools(ctx: Context, config: ToolsConfig): void {
  installRetiredMemberGuard(ctx, config.stateDir)
  installAgentTeamsReportDeliveryGuard(ctx, config.stateDir)
  const memberSelections = installMemberSelectionRuntime(ctx, config.stateDir)
  const scheduler = installTeamScheduler(ctx, {
    stateDir: config.stateDir,
    maxTaskAttempts: config.maxTaskAttempts,
  })
  const captainWakes = new CaptainWakeCoalescer()

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !captainWakes.has(agent.id)) return
    void (async () => {
      captainWakes.release(agent.id)
      const workspace = workspaceOf(agent)
      const stateRoot = stateRootOf(workspace, config)
      const team = await findTeamByCaptain(stateRoot, agent.id)
      if (team === undefined) return
      const unread = await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY)
      if (unread.length === 0 || !captainWakes.claim(agent.id)) return
      const accepted = steerCaptainReport(
        agent,
        'team event coalescer',
        `${unread.length} additional member event(s) arrived while you handled the previous event. Inspect team status once.`,
      )
      if (!accepted) {
        captainWakes.release(agent.id)
        return
      }
      await withTeamLock(teamLockKey(stateRoot, team.id), () => (
        acknowledgeMailbox(stateRoot, team.id, CAPTAIN_KEY, unread.map(message => message.id))
      ))
    })().catch((error: unknown) => {
      captainWakes.release(agent.id)
      ctx.logger.warn(`agent-teams: captain wake coalescing failed for ${agent.id}: ${String(error)}`)
    })
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || result.isError || exec.agent === undefined) return decision
    const workspace = workspaceOf(exec.agent)
    const stateRoot = stateRootOf(workspace, config)
    const located = await findTeamByParticipant(stateRoot, exec.agent.id)
    if (located === undefined || located.controlledWorkflow !== true
      || located.captainSessionId === exec.agent.id) return decision
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id)
      const member = fresh?.members.find(candidate => candidate.id === exec.agent?.id && candidate.status !== 'removed')
      const task = member === undefined ? undefined : fresh?.tasks.find(candidate => candidate.assignee === member.name
        && (candidate.status === 'claimed' || candidate.status === 'in_progress'))
      if (fresh === undefined || task === undefined) return
      const skillName = exec.name === 'skill' && typeof exec.arguments === 'object' && exec.arguments !== null
        && 'name' in exec.arguments && typeof exec.arguments.name === 'string'
        ? exec.arguments.name.trim()
        : undefined
      const keys = skillName === undefined || skillName === ''
        ? [
            `tool:${exec.name}`,
            ...exec.name.startsWith('mcp__') && exec.name.includes('__')
              ? [`tool:${exec.name.split('__').at(-1)}`]
              : [],
          ]
        : [`skill:${skillName}`]
      const receipts = task.receipts ?? []
      const receiptCountBefore = receipts.length
      const recordedAt = Date.now()
      for (const key of new Set(keys)) {
        if (key.endsWith(':undefined')) continue
        if (!receipts.some(receipt => receipt.key === key && receipt.callId === String(exec.callId))) {
          receipts.push({ key, tool: exec.name, callId: String(exec.callId), recordedAt })
        }
      }
      if (receipts.length !== receiptCountBefore) {
        task.receipts = receipts
        task.updatedAt = Date.now()
        await writeTeam(stateRoot, fresh)
      }
    })
    return decision
  })

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_list_instances',
    description: 'Read-only: list machine-global Agent Teams runtime metadata across sessions, including lifecycle, workspace, roster composition, member routes/status, and task counts. This does not join, attach to, or control any team.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderRuntimeInstances(value) }],
    },
    async execute(_args, exec) {
      requireCaptain(exec)
      if (config.catalogDir === undefined) throw new Error('global expert-team catalog is not configured')
      const instances = await listRuntimeInstances(config.catalogDir)
      return { instances: instances.map(runtimeInstanceMetadata) }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_get_instance',
    description: 'Read-only: inspect one globally discoverable runtime team by instance id or team id. Returns team composition and aggregate task metadata without task outputs or mailboxes. This does not grant membership or task access.',
    parameters: {
      team_id: { type: 'string', required: true, description: 'Global instance id or team id returned by agent_teams_list_instances.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderRuntimeInstance(value) }],
    },
    async execute(args, exec) {
      requireCaptain(exec)
      const instance = await requireGlobalInstance(config, args.team_id)
      return runtimeInstanceMetadata(instance)
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_list_templates',
    description: 'Read-only: list machine-global reusable expert-team templates and their member roles/routes. Templates contain no runtime tasks, messages, outputs, or ownership.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderTeamTemplates(value) }],
    },
    async execute(_args, exec) {
      requireCaptain(exec)
      if (config.catalogDir === undefined) throw new Error('global expert-team catalog is not configured')
      const catalogDir = config.catalogDir
      return withCatalogGeneration(ctx, catalogDir, 'read', async () => {
        const templates = await listTeamTemplates(catalogDir)
        return { templates: templates.map(teamTemplateMetadata) }
      })
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_submit_task',
    description: 'Append one independent task to a globally discovered team without joining it or changing existing work. The assigned member finishes its current task first; this tool never reassigns, cancels, retries, or edits an existing task.',
    parameters: {
      team_id: { type: 'string', required: true, description: 'Global instance id or team id returned by agent_teams_list_instances.' },
      subject: { type: 'string', required: true, description: 'Brief title for the new independent task.' },
      description: { type: 'string', required: true, description: 'Detailed work request. Must be non-empty.' },
      assignee: { type: 'string', required: true, description: 'Existing active member name selected from the team metadata.' },
      acceptance_criteria: { type: 'string', required: true, description: 'Non-empty completion contract.' },
      required_tools: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Successful receipt keys required for completion (tool:<name> or skill:<name>); pass [] when none are required.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          dispatch: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} appended to ${value.team_id} for ${value.assignee} (${value.status}; ${value.dispatch}). Existing tasks were not changed.`,
      }],
    },
    async execute(args, exec) {
      const requester = requireCaptain(exec)
      const instance = await requireGlobalInstance(config, args.team_id)
      const subject = args.subject.trim()
      const description = args.description.trim()
      const acceptanceCriteria = args.acceptance_criteria.trim()
      const assignee = args.assignee.trim()
      if (subject === '') throw new Error('submitted task subject must not be empty')
      if (description === '') throw new Error('submitted task description must not be empty')
      if (acceptanceCriteria === '') throw new Error('submitted task acceptance_criteria must not be empty')
      if (assignee === '') throw new Error('submitted task assignee must not be empty')

      const created = await withTeamLock(teamLockKey(instance.stateRoot, instance.teamId), async () => {
        const fresh = await requireFreshTeam(instance.stateRoot, instance.teamId)
        requireMember(fresh, assignee)
        if (fresh.controlledWorkflow === true && fresh.lifecycle === 'draft' && fresh.tasks.length > 0) {
          throw new Error(`team "${fresh.name}" has a non-empty draft task graph; only its captain may finish and start that graph`)
        }
        const task: TeamTask = {
          id: `t${fresh.taskSeq + 1}`,
          subject,
          description,
          status: 'pending',
          assignee,
          requesterSessionId: requester.id,
          dependencies: [],
          acceptanceCriteria,
          requiredTools: args.required_tools,
          receipts: [],
          attempt: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        fresh.taskSeq += 1
        fresh.tasks.push(task)
        if (fresh.controlledWorkflow === true && fresh.lifecycle === 'draft') {
          const errors = validateControlledTaskGraph(fresh)
          if (errors.length > 0) throw new Error(`submitted task failed controlled validation: ${errors.join('; ')}`)
          fresh.lifecycle = 'running'
        }
        await writeTeam(instance.stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, requester.session), 'agent-teams/task-created', {
          teamId: fresh.id,
          taskId: task.id,
          subject: task.subject,
          dependencies: task.dependencies,
          assignee: task.assignee,
        })
        return { team: fresh, task }
      })

      await scheduler.kickTeam(instance.workspace, instance.teamId)
      const current = await readTeam(instance.stateRoot, instance.teamId)
      const task = current?.tasks.find(candidate => candidate.id === created.task.id) ?? created.task
      const captainOnline = ctx.agents.get(created.team.captainSessionId as SessionId) !== undefined
      const dispatch = task.status === 'claimed' || task.status === 'in_progress'
        ? 'dispatched'
        : captainOnline ? 'queued_until_assignee_idle' : 'queued_until_captain_session_is_online'
      return {
        team_id: created.team.id,
        task_id: task.id,
        subject: task.subject,
        assignee,
        status: task.status,
        dispatch,
      }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_get_submitted_task',
    description: 'Read the status and eventual output of a task submitted by this same requester session through agent_teams_submit_task. This does not grant access to other team tasks.',
    parameters: {
      team_id: { type: 'string', required: true, description: 'Global instance id or team id.' },
      task_id: { type: 'string', required: true, description: 'Task id returned by agent_teams_submit_task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          output: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Submitted task ${value.task_id} is ${value.status}${value.output === undefined ? '' : `\nOutput: ${value.output}`}`,
      }],
    },
    async execute(args, exec) {
      const requester = requireCaptain(exec)
      const instance = await requireGlobalInstance(config, args.team_id)
      const team = await requireFreshTeam(instance.stateRoot, instance.teamId)
      const task = requireTask(team, args.task_id)
      if (task.requesterSessionId !== requester.id) {
        throw new Error(`task ${task.id} was not submitted by this requester session`)
      }
      return {
        team_id: team.id,
        task_id: task.id,
        subject: task.subject,
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.output === undefined ? {} : { output: task.output },
      }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_create',
    description: 'Create a new AgentTeams team: you (the calling agent) become the captain. A captain leads one team at a time; create tasks and members afterwards with agent_teams_add_member and agent_teams_create_task.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
      description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
      template_id: { type: 'string', description: 'Optional global expert-team template whose member roster should be instantiated.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
          template_id: { type: 'string' },
          member_count: { type: 'number', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`,
      }],
    },
    async execute(args, exec) {
      return withCatalogGeneration(ctx, args.template_id === undefined ? undefined : config.catalogDir, 'read', async () => {
        const captain = requireCaptain(exec)
        const workspace = workspaceOf(captain)
        const stateRoot = stateRootOf(workspace, config)
        const teamName = args.name.trim()
        if (teamName === '') throw new Error('team name must not be empty')
        const teamId = sanitizeKey(teamName)
        if (args.template_id !== undefined && config.catalogDir === undefined) {
          throw new Error('global expert-team catalog is not configured')
        }
        const template = args.template_id === undefined
          ? undefined
          : await readTeamTemplate(config.catalogDir ?? '', args.template_id)
        if (args.template_id !== undefined && template === undefined) {
          throw new Error(`global expert-team template "${args.template_id}" was not found`)
        }
        if ((template?.members.length ?? 0) > config.maxMembers) {
          throw new Error(`template "${template?.id}" has ${template?.members.length} members, above the configured cap ${config.maxMembers}`)
        }
        const created = await withTeamLock(captainLockKey(stateRoot, captain.id), async () => {
          const current = await findTeamByParticipant(stateRoot, captain.id)
          if (current !== undefined) {
            const relationship = current.captainSessionId === captain.id ? 'lead' : 'belong to'
            throw new Error(`you already ${relationship} team "${current.name}" — end or leave it before creating another`)
          }
          return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
            const existing = await readTeam(stateRoot, teamId)
            if (existing !== undefined) {
              throw new Error(`team id "${teamId}" is taken by another captain — pick a different team name`)
            }
            const state: TeamState = {
              name: teamName,
              id: teamId,
              description: args.description,
              captainSessionId: captain.id,
              createdAt: Date.now(),
              controlledWorkflow: config.controlledWorkflow === true,
              lifecycle: config.controlledWorkflow === true ? 'draft' : 'running',
              members: [],
              tasks: [],
              taskSeq: 0,
            }
            await createTeamDir(stateRoot, state)
            if (config.catalogDir !== undefined) {
              await registerRuntimeInstance(config.catalogDir, stateRoot, workspace, state)
            }
            appendTeamEvent(ctx, captain.session, 'agent-teams/team-created', {
              teamId: state.id,
              captainSessionId: captain.id,
              name: state.name,
              ...state.description !== undefined ? { description: state.description } : {},
            })
            return state
          })
        })
        if (template !== undefined) {
          for (const specification of template.members) {
            await withTeamLock(teamLockKey(stateRoot, created.id), async () => {
              const fresh = await requireFreshCaptainTeam(stateRoot, created.id, captain.id)
              const selection = await resolveMemberLlmSelection(ctx, captain, {
                provider: specification.provider,
                model: specification.model,
                defaultModel: config.memberModel,
              }, exec.signal)
              const member: TeamMember = {
                id: '',
                name: specification.name,
                role: specification.role,
                provider: selection.provider,
                model: selection.model,
                reasoningEffort: selection.reasoningEffort,
                ...specification.source === undefined ? {} : { source: structuredClone(specification.source) },
                joinedAt: Date.now(),
                status: 'idle',
              }
              await spawnMember(ctx, memberRuntime(config), memberSelections, selection, captain, fresh, member, config.stateDir, exec.signal)
              fresh.members.push(member)
              await writeTeam(stateRoot, fresh)
              appendTeamEvent(ctx, captain.session, 'agent-teams/member-added', {
                teamId: fresh.id,
                memberId: member.id,
                name: member.name,
                ...member.role === undefined ? {} : { role: member.role },
              })
            })
          }
        }
        return {
          team_id: created.id,
          team_name: created.name,
          state_dir: join(stateRoot, created.id),
          ...template === undefined ? {} : { template_id: template.id },
          member_count: template?.members.length ?? 0,
        }
      })
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_save_template',
    description: 'Save the current active expert roster to the machine-global catalog for reuse by future teams. Task state, messages, outputs, and receipts are never copied.',
    parameters: {
      template_id: { type: 'string', description: 'Stable global template id; defaults to the current team name.' },
      name: { type: 'string', description: 'Display name; defaults to the current team name.' },
      description: { type: 'string', description: 'Reusable roster description; defaults to the current team description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template_id: { type: 'string', required: true },
          template_name: { type: 'string', required: true },
          member_count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Global expert-team template "${value.template_name}" saved (${value.template_id}, ${value.member_count} members).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      if (config.catalogDir === undefined) throw new Error('global expert-team catalog is not configured')
      const catalogDir = config.catalogDir
      return withCatalogGeneration(ctx, catalogDir, 'write', async () => {
        const workspace = workspaceOf(captain)
        const team = await requireCaptainTeam(workspace, config, captain)
        const template = await writeTeamTemplate(catalogDir, {
          id: args.template_id,
          name: args.name ?? team.name,
          description: args.description ?? team.description,
          members: team.members.filter(member => member.status !== 'removed').map(member => ({
            name: member.name,
            ...member.role === undefined ? {} : { role: member.role },
            provider: member.provider,
            model: member.model,
            ...member.source === undefined ? {} : { source: structuredClone(member.source) },
          })),
        })
        return { template_id: template.id, template_name: template.name, member_count: template.members.length }
      })
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_add_member',
    description: 'Add a durable continuable member. By default it snapshots the captain\'s current LLM provider, model, and reasoning effort with no user prompt. Supply provider/model only for an explicitly requested role-specific route. The member waits for messages, works on assigned tasks, and can message the team.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique member name inside the team.' },
      role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer).' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the configured memberModel default).' },
      runtime: { type: 'string', enum: ['in-process', 'claude-code'], description: 'Member execution runtime. Default in-process (a Harness continuable subagent). Set claude-code to run the member through the external claude CLI bridge (local claude executable, session continuity via --resume).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          member_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
          status: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const memberName = args.name.trim()
        if (memberName === '') throw new Error('member name must not be empty')
        const memberKey = sanitizeKey(memberName)
        if (memberKey === CAPTAIN_KEY) {
          throw new Error(`member name "${args.name}" is reserved for the captain`)
        }
        if (fresh.members.some((candidate) => sanitizeKey(candidate.name) === memberKey)) {
          throw new Error(`member name "${args.name}" has already been used in team "${fresh.name}"`)
        }
        if (fresh.members.filter((candidate) => candidate.status !== 'removed').length >= config.maxMembers) {
          throw new Error(`team "${fresh.name}" is at its member cap (${config.maxMembers})`)
        }
        const selection = await resolveMemberLlmSelection(ctx, captain, {
          provider: args.provider,
          model: args.model,
          defaultModel: config.memberModel,
        }, exec.signal)
        const member: TeamMember = {
          id: '',
          name: memberName,
          role: args.role,
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          runtime: args.runtime === 'claude-code' ? 'claude-code' : 'in-process',
          joinedAt: Date.now(),
          status: 'idle',
        }
        await spawnMember(
          ctx,
          memberRuntime(config),
          memberSelections,
          selection,
          captain,
          fresh,
          member,
          config.stateDir,
          exec.signal,
        )
        fresh.members.push(member)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-added', {
          teamId: fresh.id,
          memberId: member.id,
          name: member.name,
          ...member.role !== undefined ? { role: member.role } : {},
        })
        return {
          member_name: member.name,
          member_id: member.id,
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: selection.reasoningEffort },
          status: member.status,
        }
      })
      await scheduler.kickMember(workspace, team.id, created.member_name, captain)
      return created
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const member = requireMember(fresh, args.name)
        const requeued: string[] = []
        for (const task of fresh.tasks) {
          if (task.assignee !== member.name || task.status === 'completed') continue
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued.push(task.id)
        }
        member.status = 'removed'
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-removed', {
          teamId: fresh.id,
          memberId: member.id,
        })
        return { member: { ...member }, requeued }
      })
      if (revoked.member.id !== '') {
        await recordRetiredMemberIds(stateRoot, [revoked.member.id])
        interruptMember(ctx, captain, revoked.member.id)
        await waitForMemberIdle(ctx, revoked.member, exec.signal)
      }
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        member_name: revoked.member.name,
        status: revoked.member.status,
        requeued_tasks: revoked.requeued,
      }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_create_task',
    description: 'Create a task in your team\'s task list. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Brief title for the task.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (must be completed before this task can be claimed).',
      },
      assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
      acceptance_criteria: { type: 'string', description: 'Non-empty completion contract; required in controlled mode.' },
      required_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Successful receipt keys required for completion (tool:<name> or skill:<name>); required explicitly in controlled mode.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee ? `, assigned to ${value.assignee}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        if (fresh.controlledWorkflow === true) {
          const missing: string[] = []
          if (args.description === undefined || args.description.trim() === '') missing.push('description')
          if (args.dependencies === undefined) missing.push('dependencies')
          if (args.assignee === undefined || args.assignee.trim() === '') missing.push('assignee')
          if (args.acceptance_criteria === undefined || args.acceptance_criteria.trim() === '') missing.push('acceptance_criteria')
          if (args.required_tools === undefined) missing.push('required_tools')
          if (missing.length > 0) throw new Error(`controlled task requires explicit ${missing.join(', ')}`)
          if (fresh.lifecycle !== 'draft') throw new Error('controlled workflow is already running; its task graph is immutable')
        }
        const dependencies = args.dependencies ?? []
        for (const dependency of dependencies) {
          if (!fresh.tasks.some((task) => task.id === dependency)) {
            throw new Error(`dependency "${dependency}" does not exist in team "${fresh.name}"`)
          }
        }
        if (args.assignee !== undefined) requireMember(fresh, args.assignee)
        const task: TeamTask = {
          id: `t${fresh.taskSeq + 1}`,
          subject: args.subject,
          description: args.description,
          status: 'pending',
          assignee: args.assignee,
          dependencies,
          acceptanceCriteria: args.acceptance_criteria,
          requiredTools: args.required_tools,
          receipts: [],
          attempt: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        fresh.taskSeq += 1
        fresh.tasks.push(task)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/task-created', {
          teamId: fresh.id,
          taskId: task.id,
          subject: task.subject,
          dependencies: task.dependencies,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
        })
        return {
          task_id: task.id,
          subject: task.subject,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
        }
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return created
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_start',
    description: 'Validate the complete controlled task DAG and atomically open its execution gate. Controlled teams remain draft and dispatch no work until this succeeds.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          lifecycle: { type: 'string', required: true },
          task_count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Team ${value.team_id} workflow validated and started (${value.task_count} tasks).` }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      let opened = false
      const result = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        if (fresh.controlledWorkflow !== true) throw new Error('agent_teams_start is only available for controlled teams')
        if (fresh.lifecycle === 'running') {
          return { team_id: fresh.id, lifecycle: fresh.lifecycle, task_count: fresh.tasks.length }
        }
        const errors = validateControlledTaskGraph(fresh)
        if (errors.length > 0) throw new Error(`controlled workflow validation failed: ${errors.join('; ')}`)
        fresh.lifecycle = 'running'
        opened = true
        await writeTeam(stateRoot, fresh)
        return { team_id: fresh.id, lifecycle: fresh.lifecycle, task_count: fresh.tasks.length }
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      if (opened) exec.concludeTurn()
      return result
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_reassign_task',
    description: 'Atomically retry, reassign, or let the captain take over any unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" for captain takeover.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          previous_assignee: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const target = args.assignee.trim()
      if (target === '') throw new Error('reassignment assignee must not be empty')

      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.status === 'completed') throw new Error(`completed task ${task.id} is immutable and cannot be reassigned`)
        if (task.reassigning === true) throw new Error(`task ${task.id} is already being reassigned`)
        const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(fresh, target)
        if (targetMember !== undefined) {
          const busy = memberOpenTask(fresh, targetMember.name, task.id)
          if (busy !== undefined) {
            throw new Error(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`)
          }
        }
        const previousAssignee = task.assignee ?? ''
        const previousMember = (task.status !== 'claimed' && task.status !== 'in_progress')
          || task.assignee === undefined || task.assignee === CAPTAIN_KEY
          ? undefined
          : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        invalidateTaskAttempt(task, target, true)
        await writeTeam(stateRoot, fresh)
        return {
          previousAssignee,
          previousMember: previousMember === undefined ? undefined : { ...previousMember },
          handoffId: task.handoffId,
        }
      })

      let quiescenceError: unknown
      if (revoked.previousMember !== undefined) {
        interruptMember(ctx, captain, revoked.previousMember.id)
        try {
          await waitForMemberIdle(ctx, revoked.previousMember, exec.signal)
        } catch (error: unknown) {
          quiescenceError = error
        }
      }

      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.handoffId !== revoked.handoffId || task.assignee !== target || task.reassigning !== true) {
          throw new Error(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`)
        }
        task.reassigning = false
        if (quiescenceError === undefined && target === CAPTAIN_KEY) beginTaskAttempt(task, CAPTAIN_KEY)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captain.session, 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
          ...args.reason === undefined ? {} : { output: `Reassigned: ${args.reason}` },
        })
      })
      if (quiescenceError !== undefined) throw quiescenceError
      if (target !== CAPTAIN_KEY) await scheduler.kickMember(workspace, team.id, target, captain)
      const current = await readTeam(stateRoot, team.id)
      const task = current === undefined ? undefined : requireTask(current, args.task_id)
      if (task === undefined) throw new Error(`team "${team.name}" ended during reassignment`)
      return {
        task_id: task.id,
        previous_assignee: revoked.previousAssignee,
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
      }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_claim_task',
    description: 'Claim one ready task for a member (or yourself). A member cannot own a second unfinished task. The returned attempt_id is required for that member\'s updates and becomes stale after retry/reassignment.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Member to claim for (captain only; defaults to the task\'s assignee).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (task.reassigning === true) {
          throw new Error(`task ${task.id} is being reassigned; wait for the handoff to finish`)
        }
        let assignee = task.assignee
        if (identity.kind === 'captain') {
          if (args.assignee !== undefined) {
            requireMember(fresh, args.assignee)
            assignee = args.assignee
          }
        } else {
          if (args.assignee !== undefined) {
            throw new Error('members cannot set assignee when claiming a task')
          }
          if (assignee !== undefined && assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${assignee}", not you`)
          }
          assignee = identity.name
        }
        // Authorization must happen before the idempotent return: another
        // member must not receive a false success for somebody else's task.
        if (task.status === 'claimed' || task.status === 'in_progress') {
          if (assignee === undefined || task.assignee !== assignee) {
            throw new Error(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`)
          }
          return {
            task_id: task.id,
            status: task.status,
            assignee,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          }
        }
        const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies)
        if (pending.length > 0) {
          throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first`)
        }
        const transition = transitionError(task.status, 'claimed')
        if (transition !== undefined) throw new Error(transition)
        if (assignee === undefined) {
          throw new Error('claiming an unassigned task needs an assignee (claim on behalf of a member)')
        }
        const busy = memberOpenTask(fresh, assignee, task.id)
        if (busy !== undefined) {
          throw new Error(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`)
        }
        const attemptId = beginTaskAttempt(task, assignee)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
        })
        return {
          task_id: task.id,
          status: task.status,
          assignee: task.assignee ?? '',
          attempt: task.attempt ?? 0,
          attempt_id: attemptId,
        }
      })
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'cancelled'],
        description: 'New status (in_progress, completed, failed, cancelled).',
      },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      attempt_id: { type: 'string', description: 'Current execution capability returned by claim_task (required for members when present on the task).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          output: { type: 'string' },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const updated = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (identity.kind === 'captain'
          && task.assignee !== undefined
          && task.assignee !== CAPTAIN_KEY) {
          throw new Error(`task ${task.id} is owned by member "${task.assignee}"; call agent_teams_reassign_task with assignee="captain" before takeover`)
        }
        if (identity.kind === 'member') {
          if (task.assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`)
          }
          if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
            throw new Error(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`)
          }
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          const sameStatus = args.status === undefined || args.status === task.status
          const sameOutput = args.output === undefined || args.output === task.output
          if (!sameStatus || !sameOutput) {
            throw new Error(`terminal task ${task.id} is immutable; use agent_teams_reassign_task to retry failed/cancelled work`)
          }
          return {
            task_id: task.id,
            status: task.status,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
            ...task.output !== undefined ? { output: task.output } : {},
          }
        }
        if (args.status !== undefined) {
          const transition = transitionError(task.status, args.status)
          if (transition !== undefined) throw new Error(transition)
          if (fresh.controlledWorkflow === true && args.status === 'completed') {
            const output = args.output ?? task.output
            if (output === undefined || output.trim() === '') {
              throw new Error(`controlled task ${task.id} completion requires a non-empty output`)
            }
            const received = new Set((task.receipts ?? []).map(receipt => receipt.key))
            const missing = (task.requiredTools ?? []).filter(key => !received.has(key))
            if (missing.length > 0) {
              throw new Error(`controlled task ${task.id} is missing required tool receipts: ${missing.join(', ')}`)
            }
          }
          task.status = args.status
        }
        if (args.output !== undefined) task.output = args.output
        task.updatedAt = Date.now()
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.output !== undefined ? { output: task.output } : {},
        })
        return {
          task_id: task.id,
          status: task.status,
          attempt: task.attempt ?? 0,
          ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          ...task.output !== undefined ? { output: task.output } : {},
        }
      })
      await scheduler.kickTeam(workspace, team.id, team.captainSessionId === caller.id ? caller : undefined)
      return updated
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_send_message',
    description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at the nearest model step). No relay is involved: teammates talk to each other directly, exactly like the Claude Code AgentTeams mailbox model.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller)
      const to = args.to.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const from = identity.name
        // `from` may only be the caller's own identity: impersonating another
        // member (or the captain) would poison the mailbox and event records.
        if (args.from !== undefined && args.from !== from) {
          throw new Error(`agent_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`)
        }
        if (to === CAPTAIN_KEY) {
          const message = { ...createMessage(from, CAPTAIN_KEY, args.content), deliveryClaimedAt: Date.now() }
          await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message)
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
            teamId: fresh.id,
            messageId: message.id,
            from,
            to: CAPTAIN_KEY,
            content: args.content,
            ts: message.ts,
          })
          return { kind: 'captain' as const, fresh, identity, message, from }
        }
        const recipient = requireMember(fresh, to)
        // External-process (claude-code) members execute through the claude
        // CLI bridge synchronously per message; they have no in-process task
        // scheduler dependency, so the controlled-workflow "active task"
        // gate (which exists to keep in-process members from being woken
        // without dispatcher consent) does not apply to them. Skipping the
        // gate lets the captain/teammates talk to external members directly;
        // the delivery branch below routes their replies through the CLI.
        if (fresh.controlledWorkflow === true && recipient.runtime !== 'claude-code') {
          const hasActiveTask = fresh.tasks.some(task => task.assignee === recipient.name
            && (task.status === 'claimed' || task.status === 'in_progress'))
          if (!hasActiveTask) {
            throw new Error(`controlled team member "${recipient.name}" has no active task; put guidance in the task contract or wait until the scheduler dispatches it`)
          }
        }
        const message = { ...createMessage(from, recipient.name, args.content), deliveryClaimedAt: Date.now() }
        await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
          teamId: fresh.id,
          messageId: message.id,
          from,
          to: recipient.name,
          content: args.content,
          ts: message.ts,
        })
        return { kind: 'member' as const, fresh, identity, message, from, recipient }
      })

      // Resolve the exact live captain only after releasing the state lock.
      // The plugin mailbox is already durable if live delivery cannot proceed.
      const captain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      if (prepared.kind === 'captain') {
        let delivered: 'live' | 'mailbox' = 'mailbox'
        if (captain !== undefined && prepared.identity.kind === 'member'
          && captainWakes.claim(prepared.fresh.captainSessionId)) {
          delivered = steerCaptainReport(captain, prepared.from, args.content) ? 'live' : 'mailbox'
          if (delivered === 'mailbox') captainWakes.release(prepared.fresh.captainSessionId)
        }
        if (delivered === 'live') {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            acknowledgeMailbox(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        } else {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            releaseMailboxDelivery(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        }
        return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered }
      }
      let delivered: 'wake' | 'mailbox' = 'mailbox'
      if (captain !== undefined && prepared.recipient.id !== '') {
        const senderText = prepared.from === CAPTAIN_KEY
          ? args.content
          : `Message from team member ${prepared.from}:\n\n${args.content}`
        const text = `AgentTeams state policy: inspect ${config.stateDir}/${prepared.fresh.id}/ read-only; never edit team.json or inbox files directly. Use agent_teams_* tools for team state.\n\n${senderText}`
        // External-process (claude-code) members execute messages through the
        // claude CLI bridge asynchronously: send_message persists the message
        // into the member's mailbox and returns immediately, then the shared
        // scheduler (kickMember mailbox fallback) runs the claude turn and
        // writes the reply back into the sender's mailbox. This keeps the
        // tool call non-blocking (a claude turn can take up to the bridge
        // timeout) and mirrors how in-process member delivery is fire-and-
        // forget from the tool's perspective.
        if (prepared.recipient.runtime === 'claude-code') {
          // The message was already persisted to the member's mailbox above
          // (appendMailbox for every recipient). For claude-code members the
          // scheduler asynchronously runs the claude turn and writes the
          // reply back; nothing more to do here.
          delivered = 'mailbox'
        } else {
          const accepted = await deliverToMember(ctx, captain, prepared.recipient.id, text, exec.signal)
          delivered = accepted ? 'wake' : 'mailbox'
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
              acknowledgeMailbox(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
            ))
          }
        }
      }
      if (delivered === 'mailbox') {
        await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
        ))
      }
      // External-process (claude-code) recipients were persisted to the
      // mailbox above; wake the scheduler so it asynchronously runs the
      // claude turn and delivers the reply back. Fire-and-forget: a scheduler
      // failure leaves the message in the mailbox for the next kick.
      if (prepared.recipient.runtime === 'claude-code') {
        void scheduler.kickMember(workspace, prepared.fresh.id, prepared.recipient.name, captain)
          .catch((error: unknown) => {
            ctx.logger.warn(
              `agent-teams: claude-code mailbox dispatch for ${prepared.recipient.name} failed: ` +
              (error instanceof Error ? error.message : String(error)),
            )
          })
      }
      return {
        message_id: prepared.message.id,
        from: prepared.from,
        to: prepared.recipient.name,
        delivered,
      }
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_status',
    description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Poll this to watch progress.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const located = await requireParticipantTeam(workspace, config, caller)
      if (located.captainSessionId === caller.id) {
        await scheduler.kickTeam(workspace, located.id, caller)
      }
      const { team, identity } = await withTeamLock(
        teamLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = await memberActivity(ctx, team.captainSessionId)
      const members = team.members
        .filter((member) => member.status !== 'removed')
        .map((member) => ({
          name: member.name,
          role: member.role ?? '',
          provider: member.provider ?? '',
          model: member.model ?? '',
          reasoning_effort: member.reasoningEffort ?? '',
          status: member.status,
          activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
        }))
      const tasks = team.tasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        assignee: task.assignee ?? '',
        dependencies: task.dependencies,
        attempt: task.attempt ?? 0,
        attempt_id: task.attemptId ?? '',
        reassigning: task.reassigning === true,
        ...task.output !== undefined ? { output: task.output } : {},
      }))
      const mailboxWarnings: string[] = []
      let mailboxWarningCount = 0
      const reportMalformed = (agentKey: string) => (lineNumber: number): void => {
        mailboxWarningCount += 1
        if (mailboxWarnings.length < 10) {
          mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`)
        }
      }
      const captainInbox = identity.kind === 'captain'
        ? await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY, reportMalformed(CAPTAIN_KEY))
        : []
      const memberInboxes: Record<string, { count: number; latest: string }> = {}
      const visibleMembers = identity.kind === 'captain'
        ? members
        : members.filter((member) => member.name === identity.name)
      for (const member of visibleMembers) {
        const messages = await readUnreadMailbox(
          stateRoot,
          team.id,
          member.name,
          reportMalformed(member.name),
        )
        if (messages.length > 0) {
          memberInboxes[member.name] = {
            count: messages.length,
            latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
          }
        }
      }
      const result = {
        team_id: team.id,
        team_name: team.name,
        description: team.description ?? '',
        viewer: identity.name,
        members,
        tasks,
        captain_inbox: captainInbox.slice(-10).map((message) => ({
          from: message.from,
          content: message.content,
          ts: message.ts,
        })),
        member_inboxes: memberInboxes,
        mailbox_warnings: mailboxWarnings,
        mailbox_warning_count: mailboxWarningCount,
      }
      const acknowledged = identity.kind === 'captain'
        ? captainInbox.map(message => message.id)
        : await readUnreadMailbox(stateRoot, team.id, identity.name).then(messages => messages.map(message => message.id))
      if (acknowledged.length > 0) {
        await withTeamLock(teamLockKey(stateRoot, team.id), () => (
          acknowledgeMailbox(stateRoot, team.id, identity.kind === 'captain' ? CAPTAIN_KEY : identity.name, acknowledged)
        ))
      }
      return result
    },
  }))

  registerAgentTeamsTool(ctx, defineTool({
    name: 'agent_teams_delete',
    description: 'End your team: interrupts all members (best effort) and deletes the team\'s state directory (team file, tasks, mailboxes). Use when the team\'s work is done or abandoned.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          team_name: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" deleted.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain)
      const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        // Include previously removed members so deleting a pre-fix team also
        // retires durable catalog entries left behind by remove_member.
        const roster = fresh.members.map(member => ({ ...member }))
        for (const member of fresh.members) {
          if (member.status === 'removed') continue
          member.status = 'removed'
          for (const task of fresh.tasks) {
            if (task.assignee === member.name && task.status !== 'completed') invalidateTaskAttempt(task)
          }
        }
        await writeTeam(stateRoot, fresh)
        return roster
      })
      await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
      for (const member of members) {
        if (member.id === '') continue
        interruptMember(ctx, captain, member.id)
      }
      const quiescence = await Promise.allSettled(members.map(member => waitForMemberIdle(ctx, member, exec.signal)))
      for (const result of quiescence) {
        if (result.status === 'rejected') {
          ctx.logger.warn(`agent-teams: member did not quiesce cleanly before team archive: ${String(result.reason)}`)
        }
      }
      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-deleted', {
          teamId: fresh.id,
        })
        // Archive, not delete: tasks (with their dependency graph) and the
        // mailboxes stay on disk for later review and dependency rebuilds.
        await archiveTeamDir(stateRoot, fresh.id)
        if (config.catalogDir !== undefined) {
          await unregisterRuntimeInstance(config.catalogDir, stateRoot, fresh.id, fresh.captainSessionId)
        }
      })
      return { deleted: true, team_name: team.name }
    },
  }))
}

/** Build the `memberRuntime` config handed to member helpers. */
function memberRuntime(config: ToolsConfig): MemberRuntimeConfig {
  return {
    provider: config.memberProvider,
    maxDepth: config.memberMaxDepth,
  }
}

/** Stable model-facing projection of read-only global runtime metadata. */
function runtimeInstanceMetadata(instance: RuntimeInstanceView) {
  return {
    instance_id: instance.id,
    team_id: instance.teamId,
    team_name: instance.teamName,
    description: instance.description ?? '',
    status: instance.status,
    lifecycle: instance.lifecycle ?? '',
    controlled_workflow: instance.controlledWorkflow === true,
    workspace: instance.workspace,
    captain_session_id: instance.captainSessionId,
    member_count: instance.memberCount,
    task_count: instance.taskCount,
    task_status_counts: instance.taskStatusCounts,
    members: instance.members,
  }
}

/** Stable model-facing projection of a reusable roster template. */
function teamTemplateMetadata(template: ExpertTeamTemplate) {
  return {
    template_id: template.id,
    template_name: template.name,
    description: template.description ?? '',
    member_count: template.members.length,
    members: template.members.map(member => ({
      name: member.name,
      role: member.role ?? '',
      provider: member.provider ?? '',
      model: member.model ?? '',
    })),
  }
}

/** Render a compact global runtime list without implying team membership. */
function renderRuntimeInstances(value: JsonValue): string {
  const instances = (value as { instances: ReturnType<typeof runtimeInstanceMetadata>[] }).instances
  if (instances.length === 0) return 'No globally discoverable Agent Teams runtime instances.'
  return [
    'Global Agent Teams runtime metadata (read-only):',
    ...instances.map(instance => (
      `- ${instance.team_name} (${instance.team_id}; instance ${instance.instance_id}) `
      + `${instance.status}${instance.lifecycle ? `/${instance.lifecycle}` : ''} · `
      + `${instance.member_count} members · ${instance.task_count} tasks · ${instance.workspace}`
    )),
  ].join('\n')
}

/** Render one runtime roster without task outputs or mailbox content. */
function renderRuntimeInstance(value: JsonValue): string {
  const instance = value as ReturnType<typeof runtimeInstanceMetadata>
  return [
    `${instance.team_name} (${instance.team_id}; instance ${instance.instance_id})`,
    `status: ${instance.status}${instance.lifecycle ? `/${instance.lifecycle}` : ''}`,
    `workspace: ${instance.workspace}`,
    `captain: ${instance.captain_session_id}`,
    `members/tasks: ${instance.member_count}/${instance.task_count}`,
    ...instance.description === '' ? [] : [`description: ${instance.description}`],
    ...instance.members.map(member => (
      `- ${member.name}\t${member.role ?? ''}\t${member.status}\t${member.provider ?? ''}${member.model === undefined ? '' : `/${member.model}`}`
    )),
  ].join('\n')
}

/** Render globally reusable expert rosters. */
function renderTeamTemplates(value: JsonValue): string {
  const templates = (value as unknown as { templates: ReturnType<typeof teamTemplateMetadata>[] }).templates
  if (templates.length === 0) return 'No global expert-team templates.'
  return [
    'Global expert-team templates (read-only):',
    ...templates.map(template => `- ${template.template_name} (${template.template_id}) · ${template.member_count} experts`),
  ].join('\n')
}

/** Render the status snapshot as compact text for the model. */
function renderStatus(value: JsonValue): string {
  const team = value as {
    team_name: string
    description?: string
    viewer: string
    members: {
      name: string
      role: string
      provider: string
      model: string
      reasoning_effort: string
      status: string
      activity: string
    }[]
    tasks: { id: string; subject: string; status: string; assignee: string; dependencies: string[]; attempt: number; attempt_id: string; reassigning: boolean; output?: string }[]
    captain_inbox: { from: string; content: string }[]
    member_inboxes: Record<string, { count: number; latest: string }>
    mailbox_warnings: string[]
    mailbox_warning_count: number
  }
  const lines: string[] = [
    `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}`,
    `Viewing as: ${team.viewer}`,
    `Members (${team.members.length}):`,
    ...team.members.map((member) => {
      const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : ''
      const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : ''
      return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}`
    }),
    `Tasks (${team.tasks.length}):`,
    ...team.tasks.map((task) => {
      const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
      const handoff = task.reassigning ? ' (reassigning)' : ''
      return `  - ${task.id} [${task.status}] attempt ${task.attempt}${handoff} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${output}`
    }),
    `Captain inbox (${team.captain_inbox.length}):`,
    ...team.captain_inbox.map((message) => `  - [${message.from}] ${message.content.slice(0, 200)}`),
  ]
  for (const [name, inbox] of Object.entries(team.member_inboxes)) {
    lines.push(`Member inbox ${name} (${inbox.count}): latest — ${inbox.latest.slice(0, 120)}`)
  }
  if (team.mailbox_warning_count > 0) {
    lines.push(
      `Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`,
      ...team.mailbox_warnings.map((warning) => `  - ${warning}`),
    )
  }
  return lines.join('\n')
}
