/** ByClaw inbound direct-target routing verification. */

import assert from 'node:assert/strict'
import { resolveByClawInboundTarget } from '../src/inbound-routing.ts'

const resources = {
  employees: [
    {
      id: '101',
      code: 'ARCHITECT',
      name: '架构舵手',
      description: '负责架构分析',
      capabilities: '',
      persona: '',
      workerAgentType: 'BYCLAW_CODE',
      skills: [],
    },
    {
      id: '102',
      code: 'REVIEWER',
      name: '代码审查员',
      description: '负责代码审查',
      capabilities: '',
      persona: '',
      workerAgentType: 'BYCLAW_CODE',
      skills: [],
    },
    {
      id: '202',
      code: 'TEAM_ONLY_MEMBER',
      name: '团队专属成员',
      description: '只允许专家团调用',
      capabilities: '',
      persona: '',
      workerAgentType: 'BYCLAW_CODE',
      skills: [],
    },
  ],
  groups: [{
    id: '301',
    code: 'RND_GROUP',
    name: '研发专家团',
    description: '负责研发闭环',
    workerAgentType: 'BY_SUPER',
    members: [{
      employeeId: '202',
      employeeCode: 'TEAM_ONLY_MEMBER',
      name: '团队专属成员',
      order: 1,
    }],
  }],
  directEmployeeIds: ['101', '102'],
  authHeaders: {},
}

const employeeById = resolveByClawInboundTarget(resources, { agent_id: 101 }, '做自我介绍')
assert.deepEqual(employeeById, {
  templateId: 'byclaw-employee-101',
  resourceId: '101',
  kind: 'employee',
  name: '架构舵手',
  text: '做自我介绍',
})

const groupById = resolveByClawInboundTarget(resources, { agent_id: '301' }, '做自我介绍')
assert.equal(groupById?.templateId, 'byclaw-group-301')
assert.equal(groupById?.kind, 'group')

assert.equal(
  resolveByClawInboundTarget(resources, { agent_code: 'REVIEWER' }, '审查代码')?.templateId,
  'byclaw-employee-102',
)
assert.equal(
  resolveByClawInboundTarget(resources, { agent_name: '研发专家团' }, '设计方案')?.templateId,
  'byclaw-group-301',
)
assert.equal(
  resolveByClawInboundTarget(resources, {}, '@ARCHITECT 分析架构')?.text,
  '分析架构',
)
assert.equal(
  resolveByClawInboundTarget(resources, {}, '请 @研发专家团 组织评审')?.templateId,
  'byclaw-group-301',
)

assert.equal(resolveByClawInboundTarget(resources, {}, '普通主 Agent 问题'), undefined)

assert.throws(
  () => resolveByClawInboundTarget(resources, { agent_id: '202' }, '越权'),
  /not directly authorized/,
)
assert.throws(
  () => resolveByClawInboundTarget(resources, { agent_id: '999' }, '不存在'),
  /not found/,
)
assert.throws(
  () => resolveByClawInboundTarget(resources, { agent_id: '101', agent_code: 'RND_GROUP' }, '冲突'),
  /conflict/,
)
assert.throws(
  () => resolveByClawInboundTarget(resources, {}, '@ARCHITECT @REVIEWER 请协作'),
  /ambiguous/,
)
assert.throws(
  () => resolveByClawInboundTarget(resources, {}, '@ARCHITECT 请分析；@ARCHITECT 再复核'),
  /ambiguous/,
)
assert.equal(resolveByClawInboundTarget(resources, {}, '@架构舵手分析'), undefined)

console.log('ByClaw inbound direct-routing checks passed')
