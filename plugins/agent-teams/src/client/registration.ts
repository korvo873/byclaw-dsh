/** Conversation-node registration owned by the AgentTeams client fiber. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { agentTeamsCardDefinition } from './agent-teams-card-definition.ts'

/** Register the AgentTeams conversation definition for one client-fiber lifetime. */
export function registerAgentTeamsConversationDefinition(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.conversationEvents.register(agentTeamsCardDefinition),
    'agent-teams: conversation definition',
  )
}
