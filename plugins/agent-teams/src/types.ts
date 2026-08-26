/**
 * Durable AgentTeams state types.
 *
 * A team is one directory under the state root holding `team.json` plus an
 * `inbox/` of per-agent JSONL mailboxes. Members are continuable subagents
 * whose durable child session ids are recorded in the team file, so a team
 * survives harness restarts.
 * @module dsh-agent-teams/types
 */

/** Task lifecycle statuses in progression order. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Team-level execution gate. Controlled teams remain draft until validated. */
export type TeamLifecycle = 'draft' | 'running'

/** One successful real tool invocation associated with the current task attempt. */
export interface ToolReceipt {
  /** Completion-policy key (`tool:<name>` or `skill:<name>`). */
  key: string
  tool: string
  callId: string
  recordedAt: number
}

/** Serializable terminal model-request failure attached to the affected task. */
export interface TaskFailure {
  code: string
  message: string
  status?: number
  provider: string
  recordedAt: number
}

/** One task of a team's task list. */
export interface TeamTask {
  /** Stable task id within the team (`t1`, `t2`, …). */
  id: string
  /** Brief title for the task. */
  subject: string
  /** What needs to be done. */
  description?: string
  status: TaskStatus
  /** Member name (or `captain`) the task is assigned to; unassigned tasks await a claim. */
  assignee?: string
  /** External session that appended this independent work item, when any. */
  requesterSessionId?: string
  /** Task ids that must reach `completed` before this task can be claimed. */
  dependencies: string[]
  /** Human-readable, non-empty completion contract in controlled mode. */
  acceptanceCriteria?: string
  /** Successful tool/skill receipt keys required before controlled completion. */
  requiredTools?: string[]
  /** Receipts recorded from the real Harness tool pipeline for the current attempt. */
  receipts?: ToolReceipt[]
  /** Last terminal model-request failure, when the attempt ended before a task update. */
  lastFailure?: TaskFailure
  /** The worker's written result, set when the task completes or fails. */
  output?: string
  /** Monotonic execution generation. Reassignment/retry invalidates every older attempt. */
  attempt?: number
  /** Capability for the current claimed/in-progress attempt. Members must present it when updating. */
  attemptId?: string
  /** Opaque generation for a revocation/handoff that has not started its next attempt yet. */
  handoffId?: string
  /** A handoff is quiescing the old owner; the scheduler must not dispatch it yet. */
  reassigning?: boolean
  createdAt: number
  updatedAt: number
}

/** Member lifecycle status. */
export type MemberStatus = 'idle' | 'working' | 'removed'

/** Frozen ByClaw employee facts attached to a materialized member. */
export interface ByClawMemberSource {
  kind: 'byclaw-digital-employee'
  employeeId: string
  employeeCode: string
  workerAgentType: string
  /** Authoritative ByClaw AI-model instance id used to derive this frozen member route. */
  modelId?: string
  version?: string
  description?: string
  capabilities?: string
  persona?: string
  skills: Array<{ code: string; path: string }>
}

/** One team member: a continuable subagent plus its team-side record. */
export interface TeamMember {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display name inside the team. */
  name: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this member was created. */
  provider?: string
  /** Resolved model captured when this member was created. */
  model?: string
  /** Resolved reasoning effort captured from the captain's current session. */
  reasoningEffort?: string
  /** Member execution runtime: `in-process` (default) or `claude-code` (external CLI bridge). */
  runtime?: 'in-process' | 'claude-code'
  /** Optional frozen enterprise resource snapshot used to compose this member. */
  source?: ByClawMemberSource
  joinedAt: number
  status: MemberStatus
}

/** One mailbox message. */
export interface TeamMessage {
  id: string
  /** `captain` or a member name. */
  from: string
  /** `captain` or a member name. */
  to: string
  content: string
  ts: number
  /** Process-local delivery lease; prevents fallback and direct delivery racing. */
  deliveryClaimedAt?: number
  /** Set after the durable message was accepted by the recipient's live Harness inbox. */
  deliveredAt?: number
  /** Set once the recipient has consumed or been shown the durable fallback. */
  readAt?: number
}

/** The full durable team record. */
export interface TeamState {
  /** Original team name. */
  name: string
  /** Sanitized directory id; the team's stable identity. */
  id: string
  /** Team purpose/goal. */
  description?: string
  /** Session id of the captain agent that owns this team. */
  captainSessionId: string
  createdAt: number
  /** Whether deterministic workflow gates are enabled for this team generation. */
  controlledWorkflow?: boolean
  /** Controlled workflow dispatch gate; legacy records without this field behave as running. */
  lifecycle?: TeamLifecycle
  /** Teammates only; the captain is implicit (the owning session). */
  members: TeamMember[]
  tasks: TeamTask[]
  /** Monotonic task id counter. */
  taskSeq: number
}
