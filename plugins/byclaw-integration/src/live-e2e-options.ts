/** Parse and serialize the live ByClaw inbound smoke-test options. */

export interface ByClawLiveE2eOptions {
  main: boolean
  targetAgentType: string
  agentId?: string
  agentCode?: string
  agentName?: string
  prompts: string[]
}

function optionValue(argv: string[], index: number, option: string): { value: string; nextIndex: number } {
  const argument = argv[index]
  if (argument === undefined) throw new Error(`missing value for ${option}`)
  const inlinePrefix = `${option}=`
  if (argument.startsWith(inlinePrefix)) {
    const value = argument.slice(inlinePrefix.length).trim()
    if (value === '') throw new Error(`missing value for ${option}`)
    return { value, nextIndex: index }
  }
  const value = argv[index + 1]?.trim() ?? ''
  if (value === '' || value.startsWith('--')) throw new Error(`missing value for ${option}`)
  return { value, nextIndex: index + 1 }
}

/** Parse live-e2e flags while leaving all remaining arguments as prompts. */
export function parseByClawLiveE2eArgs(
  argv: readonly string[],
  userCode = process.env['USER_CODE']?.trim() || 'adminvip',
): ByClawLiveE2eOptions {
  let main = false
  let agentId: string | undefined
  let agentCode: string | undefined
  let agentName: string | undefined
  const prompts: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      prompts.push(...argv.slice(index + 1))
      break
    }
    if (argument === '--main') {
      main = true
      continue
    }
    let parsed: { value: string; nextIndex: number } | undefined
    if (argument === '--agent-id' || argument?.startsWith('--agent-id=')) {
      parsed = optionValue(argv as string[], index, '--agent-id')
      agentId = parsed.value
    } else if (argument === '--agent-code' || argument?.startsWith('--agent-code=')) {
      parsed = optionValue(argv as string[], index, '--agent-code')
      agentCode = parsed.value
    } else if (argument === '--agent-name' || argument?.startsWith('--agent-name=')) {
      parsed = optionValue(argv as string[], index, '--agent-name')
      agentName = parsed.value
    } else {
      if (argument?.startsWith('--')) throw new Error(`unsupported option: ${argument}`)
      prompts.push(argument ?? '')
      continue
    }
    index = parsed.nextIndex
  }
  if (prompts.length === 0) throw new Error('provide at least one prompt')
  if (main && (agentId !== undefined || agentCode !== undefined || agentName !== undefined)) {
    throw new Error('--main cannot be combined with a direct agent target')
  }
  return {
    main,
    targetAgentType: main ? 'BYCLAW_DSH' : `BYCLAW_DSH_${userCode}`,
    ...agentId === undefined ? {} : { agentId },
    ...agentCode === undefined ? {} : { agentCode },
    ...agentName === undefined ? {} : { agentName },
    prompts,
  }
}

/** Build ByClaw's snake_case extra payload without putting routing flags in text. */
export function buildByClawInboundExtraPayload(
  cwd: string | undefined,
  options: ByClawLiveE2eOptions,
): Record<string, string> {
  return {
    ...cwd?.trim() === '' || cwd === undefined ? {} : { cwd: cwd.trim() },
    ...options.agentId === undefined ? {} : { agent_id: options.agentId },
    ...options.agentCode === undefined ? {} : { agent_code: options.agentCode },
    ...options.agentName === undefined ? {} : { agent_name: options.agentName },
  }
}
