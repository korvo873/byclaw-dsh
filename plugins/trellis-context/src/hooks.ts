import type { SessionId } from '@deepseek-ai/dsh-session'

/** Claude-compatible Trellis hook names adapted by this plugin. */
export type TrellisHookName = 'SessionStart' | 'UserPromptSubmit'

/** Input accepted by the repository-owned Trellis hooks. */
export interface TrellisHookInput {
  session_id: SessionId
  transcript_path: string
  cwd: string
  hook_event_name: TrellisHookName
  source?: 'startup'
  prompt?: string
}

/** Quote one value as a POSIX shell word without command interpolation. */
export function quotePosixShellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Build the JSON input for one repository-owned Trellis hook. */
export function trellisHookInput(
  name: TrellisHookName,
  sessionId: SessionId,
  cwd: string,
  prompt?: string,
): TrellisHookInput {
  return {
    session_id: sessionId,
    transcript_path: '',
    cwd,
    hook_event_name: name,
    ...name === 'SessionStart' ? { source: 'startup' as const } : { prompt: prompt ?? '' },
  }
}

/**
 * Parse one hook JSON document and return only its matching model-visible context.
 * @param stdout - Complete, non-truncated hook standard output.
 * @param expectedName - Hook event required in `hookSpecificOutput`.
 * @returns Non-empty `hookSpecificOutput.additionalContext` text.
 */
export function parseTrellisHookContext(stdout: string, expectedName: TrellisHookName): string {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${expectedName} hook output is not one JSON document`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${expectedName} hook output must be a JSON object`)
  }
  const output = (value as Record<string, unknown>)['hookSpecificOutput']
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new Error(`${expectedName} hook output is missing hookSpecificOutput`)
  }
  const fields = output as Record<string, unknown>
  if (fields['hookEventName'] !== expectedName) {
    throw new Error(`${expectedName} hook output has mismatched hookEventName`)
  }
  const context = fields['additionalContext']
  if (typeof context !== 'string') {
    throw new Error(`${expectedName} hook output is missing additionalContext`)
  }
  if (context.trim().length === 0) throw new Error(`${expectedName} hook output has empty additionalContext`)
  return context
}
