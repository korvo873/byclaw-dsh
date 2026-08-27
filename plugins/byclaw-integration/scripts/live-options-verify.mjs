import {
  buildByClawInboundExtraPayload,
  parseByClawLiveE2eArgs,
} from '../src/live-e2e-options.ts'

const parsed = parseByClawLiveE2eArgs([
  '--agent-id', '101',
  '请介绍自己',
  '再说一句',
])
if (parsed.main || parsed.targetAgentType !== 'BYCLAW_DSH_adminvip') throw new Error('agent target routing mismatch')
if (parsed.prompts.join('|') !== '请介绍自己|再说一句') throw new Error('prompt parsing mismatch')
const payload = buildByClawInboundExtraPayload('/tmp/workspace', parsed)
if (JSON.stringify(payload) !== JSON.stringify({ cwd: '/tmp/workspace', agent_id: '101' })) {
  throw new Error(`agent extra payload mismatch: ${JSON.stringify(payload)}`)
}

const main = parseByClawLiveE2eArgs(['--main', '回到主 Agent'])
if (!main.main || main.targetAgentType !== 'BYCLAW_DSH' || Object.keys(buildByClawInboundExtraPayload('', main)).length !== 0) {
  throw new Error('main target routing mismatch')
}

const structured = parseByClawLiveE2eArgs(['--agent-id', '123', '做自我介绍'])
if (JSON.stringify(buildByClawInboundExtraPayload('', structured)) !== JSON.stringify({ agent_id: '123' })) {
  throw new Error('structured target payload mismatch')
}

const coded = parseByClawLiveE2eArgs(['--agent-code', 'ARCHITECT', '--agent-name', '架构舵手', '分析架构'])
if (JSON.stringify(buildByClawInboundExtraPayload('', coded)) !== JSON.stringify({
  agent_code: 'ARCHITECT',
  agent_name: '架构舵手',
})) {
  throw new Error('structured code/name payload mismatch')
}

console.log('ByClaw live-e2e option checks passed')
