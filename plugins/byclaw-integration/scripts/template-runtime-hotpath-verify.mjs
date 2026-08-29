/** Inbound root preparation must use the already-synchronized local catalog. */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAgentTemplate } from '../src/agent-template.ts'
import { registerAgentTemplateRuntime } from '../src/template-runtime.ts'

const root = await mkdtemp(join(tmpdir(), 'byclaw-template-hotpath-'))
try {
  await writeAgentTemplate(root, {
    schemaVersion: 'dsh.agent-template/v1',
    id: 'byclaw-employee-1',
    kind: 'agent',
    name: '本地模板',
    description: '验证入站热路径',
    persona: '直接回复。',
    skills: [],
    source: {
      system: 'byclaw',
      resourceId: '1',
      resourceCode: 'EMPLOYEE_1',
      workerAgentType: 'BYCLAW_DSH',
      directlyAuthorized: true,
    },
  })

  let refreshes = 0
  const ctx = {
    subagents: { registerContinuableSetup() {} },
    tools: { register() {} },
  }
  const runtime = registerAgentTemplateRuntime(ctx, {
    catalogDir: root,
    subagentProvider: 'test',
    resolveModel: async () => ({ provider: 'test', model: 'test' }),
    beforeInstantiate: async () => { refreshes += 1 },
  })

  const prepared = await runtime.prepareRoot('byclaw-employee-1')
  assert.equal(prepared.templateId, 'byclaw-employee-1')
  assert.equal(refreshes, 0, 'inbound root preparation synchronously refreshed remote resources')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('ByClaw template inbound hot-path checks passed')
