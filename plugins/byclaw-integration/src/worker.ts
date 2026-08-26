/** by-framework command adapter for DSH-owned root sessions. */

import {
  AgentState,
  AgentTaskResult,
  CancelTaskCommand,
  GatewayWorker,
  WorkerRegistry,
  type AgentContext,
  AskAgentCommand,
  ResumeCommand,
  type GatewayCommand,
} from '@byclaw/by-framework'
import { extractByClawUserText } from './protocol.ts'

export interface ByClawDshSessionPort {
  ask(command: AskAgentCommand, context: AgentContext): Promise<{ answer: string; dshSessionId: string }>
  resume(command: ResumeCommand): boolean
  cancel(messageId: string, reason: string): void
}

export interface ByClawCommandContext {
  sessionId: string
  setStreamFinished(finished: boolean): void
}

/** Testable command dispatch separated from GatewayWorker's Redis lifecycle. */
export class ByClawDshCommandHandler {
  constructor(readonly sessions: ByClawDshSessionPort) {}

  async process(command: GatewayCommand, context: AgentContext): Promise<AgentTaskResult> {
    if (command instanceof ResumeCommand) {
      if (!this.sessions.resume(command)) throw new Error('BYCLAW_DSH Resume has no matching ask_user interaction')
      context.setStreamFinished(true)
      return new AgentTaskResult({ status: AgentState.COMPLETED, content: '', replyData: null })
    }
    if (!(command instanceof AskAgentCommand)) throw new Error(`Unsupported BYCLAW_DSH command: ${command.actionType}`)
    if (extractByClawUserText(command.content) === '') throw new Error('BYCLAW_DSH AskAgent content is empty')
    const result = await this.sessions.ask(command, context)
    return new AgentTaskResult({
      status: AgentState.COMPLETED,
      content: '',
      replyData: null,
      metadata: { dshSessionId: result.dshSessionId },
    })
  }
}

/** Redis-consuming by-framework Worker that delegates every command to DSH. */
export class ByClawDshGatewayWorker extends GatewayWorker {
  private readonly handler: ByClawDshCommandHandler

  constructor(options: {
    workerId: string
    agentTypes: string[]
    sessions: ByClawDshSessionPort
    redis: ConstructorParameters<typeof WorkerRegistry>[0]
    registry?: WorkerRegistry
  }) {
    super(options.workerId, options.registry ?? new WorkerRegistry(options.redis), options.redis)
    this.agentTypes = [...new Set(options.agentTypes)]
    this.handler = new ByClawDshCommandHandler(options.sessions)
  }

  private readonly agentTypes: string[]

  getAgentTypes(): ReadonlyArray<string> {
    return this.agentTypes
  }

  processCommand(command: GatewayCommand, context: AgentContext): Promise<AgentTaskResult> {
    return this.handler.process(command, context)
  }

  async onCancelTask(command: unknown): Promise<void> {
    if (command instanceof CancelTaskCommand) {
      this.sessions.cancel(command.targetMessageId, command.reason || 'ByClaw task cancelled')
    }
  }

  private get sessions(): ByClawDshSessionPort {
    return this.handler.sessions
  }
}
