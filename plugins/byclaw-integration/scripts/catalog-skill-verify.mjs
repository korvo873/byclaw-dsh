/** ByClaw authorization catalog and Skill cache verification. */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadAuthorizedByClawResources, loadByClawExpertGroupRuntime } from '../lib/catalog.js'
import { projectByClawResourcesToTemplates } from '../lib/integration.js'
import { readAgentTemplate } from '../lib/agent-template.js'
import {
  byClawSkillCacheDir,
  readCachedByClawSkill,
  syncByClawSkill,
  validateByClawSkillZipEntryName,
  writeCachedByClawSkill,
} from '../lib/skill-sync.js'

const execFileAsync = promisify(execFile)

const snapshots = new Map([
  ['DIG_EMPLOYEE_1', JSON.stringify({
    resourceId: '1', resourceCode: 'EMP_1', resourceName: '架构师', resourceDesc: '当前架构描述',
    workerAgentType: 'BYCLAW_CODE', configVersion: 'current-v1',
    relPrompt: JSON.stringify([{ name: '工作规范', value: '先确认约束。' }]),
    coreCompetencies: JSON.stringify([{ coreCompetency: '定义模块边界' }]),
  })],
  ['DIG_EMPLOYEE_9', JSON.stringify({
    resourceId: '9', resourceCode: 'GROUP_9', resourceName: '研发团', resourceDesc: '当前专家团描述',
    workerAgentType: 'BY_SUPER', configVersion: 'current-v9',
    employeeGroupMembers: [
      { resourceId: '1', resourceCode: 'EMP_1', name: '架构师', teamRole: '架构负责人', sortOrder: 1 },
      { resourceId: '2', resourceCode: 'EMP_2', name: '开发者', teamRole: '开发负责人', sortOrder: 2 },
    ],
  })],
  ['DIG_EMPLOYEE_2', JSON.stringify({
    resourceId: '2', resourceCode: 'EMP_2', resourceName: '开发者', resourceDesc: '仅专家团成员',
    workerAgentType: 'BYCLAW_CODE',
  })],
])
const redisReads = []
const redis = {
  async get(key) {
    redisReads.push(['get', key])
    if (key === 'SHARE_BFM_USER_CODE_tester') return '42'
    return snapshots.get(key) ?? null
  },
  async hgetall(key) {
    redisReads.push(['hgetall', key])
    if (key === 'USER:RESOURCES:AUTH:42') {
      return {
        1: 'DIG_EMPLOYEE',
        ignored: JSON.stringify({ resourceBizType: 'WORKFLOW', resourceId: 'ignored' }),
        group: JSON.stringify({ resourceType: 'DIG_EMPLOYEE', resourceId: 9 }),
      }
    }
    if (key === 'user:42:login:auth') {
      return { 'Beyond-Token': 'secret-token', 'Sso-Token': 'secret-sso' }
    }
    return {}
  },
  async exists(key) {
    redisReads.push(['exists', key])
    return key === 'USER:RESOURCES:AUTH:42' ? 1 : 0
  },
}
const resources = await loadAuthorizedByClawResources({
  redis,
  userCode: 'tester',
  baseUrl: 'http://byclaw.test',
  fetchImpl: async url => { throw new Error(`catalog made unexpected HTTP request ${String(url)}`) },
})
if (resources.employees.length !== 2 || resources.groups.length !== 1
  || resources.employees.find(employee => employee.id === '1')?.description !== '当前架构描述'
  || resources.groups[0]?.description !== '当前专家团描述'
  || resources.groups[0]?.configVersion !== 'current-v9'
  || resources.groups[0]?.members[1]?.role !== '开发负责人'
  || resources.directEmployeeIds.join(',') !== '1') {
  throw new Error(`authorized catalog did not target-load direct resources and supplementary group members: ${JSON.stringify(resources)}`)
}
const expectedReads = new Set([
  'get:SHARE_BFM_USER_CODE_tester',
  'hgetall:USER:RESOURCES:AUTH:42',
  'exists:USER:RESOURCES:AUTH:42',
  'hgetall:user:42:login:auth',
  'get:DIG_EMPLOYEE_1',
  'get:DIG_EMPLOYEE_9',
  'get:DIG_EMPLOYEE_2',
])
if (redisReads.some(read => !expectedReads.has(read.join(':')))
  || [...expectedReads].some(expected => !redisReads.some(read => read.join(':') === expected))) {
  throw new Error(`authorized catalog read unexpected Redis keys: ${JSON.stringify(redisReads)}`)
}

const groupRuntime = await loadByClawExpertGroupRuntime({
  groupId: '9',
  baseUrl: 'http://byclaw.test',
  authHeaders: { 'Beyond-Token': 'secret-token', 'content-type': 'application/json' },
  fetchImpl: async (_url, init) => {
    if (init?.redirect !== 'manual') throw new Error('resolve-runtime allowed automatic credential redirect')
    return new Response(JSON.stringify({ data: {
      schemaVersion: 'byclaw.orchestrator-runtime/v1',
      orchestrator: { kind: 'EXPERT_TEAM', id: '9', name: '研发团' },
      prompt: { content: '团长只负责调度。', version: 'p9' },
      contextProfile: 'EXPERT_TEAM_MINIMAL_V1',
      configVersion: 'v9',
      model: { modelId: 'model-9' },
      agents: [{
        id: '1', resourceCode: 'EMP_1', name: '架构师', description: '当前架构描述',
        teamRole: '运行时架构负责人', agentType: '011', createType: 'FROM_MANUALLY', integrationType: 'NONE',
      }],
    } }), { status: init?.method === 'POST' ? 200 : 405 })
  },
})
if (groupRuntime.groupId !== '9' || groupRuntime.prompt !== '团长只负责调度。'
  || groupRuntime.modelId !== 'model-9'
  || groupRuntime.members[0]?.employeeId !== '1'
  || groupRuntime.members[0]?.role !== '运行时架构负责人') {
  throw new Error('expert-group leader runtime was not parsed')
}

let projected

for (const unsafe of ['/absolute/SKILL.md', '../escape', 'x/../../escape', 'C:\\escape']) {
  let rejected = false
  try { validateByClawSkillZipEntryName(unsafe) } catch { rejected = true }
  if (!rejected) throw new Error(`unsafe ZIP entry accepted: ${unsafe}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-byclaw-skill-'))
try {
  const source = join(root, 'source')
  const target = join(root, 'cache', 'architecture-rules')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '---\nname: architecture-rules\ndescription: Architecture rules\n---\nFollow the boundaries.\n')
  await writeCachedByClawSkill({
    sourceDir: source,
    targetDir: target,
    metadata: { code: 'architecture-rules', version: 'v1', downloadUrl: '/download', versionUrl: '/version' },
  })
  const cached = await readCachedByClawSkill(target)
  if (cached?.metadata.version !== 'v1' || !(await readFile(cached.skillFile, 'utf8')).includes('boundaries')) {
    throw new Error('atomic Skill cache did not preserve content and metadata')
  }
  try {
    await syncByClawSkill({
      ref: { id: 'slow', code: 'slow-skill', type: 'hub', versionUrl: '/slow-version', downloadUrl: '/slow.zip' },
      baseUrl: 'http://byclaw.test', headers: {}, cacheRoot: join(root, 'cache'),
      fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError') },
    })
    throw new Error('timed-out Skill metadata request was accepted')
  } catch (error) {
    const detail = String(error)
    if (!detail.includes('slow-skill') || !detail.includes('version request')) throw error
  }
  const guarded = join(root, 'cache', 'guarded')
  await writeCachedByClawSkill({
    sourceDir: source,
    targetDir: guarded,
    metadata: { code: 'guarded', version: 'v1', downloadUrl: 'http://byclaw.test/skill.zip', versionUrl: 'http://byclaw.test/version' },
  })
  let credentialFetches = 0
  const sameOrigin = await syncByClawSkill({
    ref: { id: 'guarded', code: 'guarded', type: 'hub', versionUrl: '/version', downloadUrl: '/skill.zip' },
    baseUrl: 'http://byclaw.test', headers: { 'Beyond-Token': 'secret-token' }, cacheRoot: join(root, 'cache'),
    fetchImpl: async (_url, init) => {
      credentialFetches += 1
      if (init?.headers?.['Beyond-Token'] !== 'secret-token') throw new Error('same-origin request lost credentials')
      if (init.redirect !== 'manual') throw new Error('Skill request allowed automatic credential redirect')
      return new Response(JSON.stringify({ data: { version: 'v1' } }), { status: 200 })
    },
  })
  if (sameOrigin !== guarded || credentialFetches !== 1) throw new Error('same-origin Skill cache refresh failed')
  let downloadFetches = 0
  try {
    await syncByClawSkill({
      ref: { id: 'guarded', code: 'guarded', type: 'hub', versionUrl: '/version', downloadUrl: '/skill.zip' },
      baseUrl: 'http://byclaw.test', headers: { 'Beyond-Token': 'secret-token' }, cacheRoot: join(root, 'cache'),
      fetchImpl: async (url, init) => {
        downloadFetches += 1
        if (init?.headers?.['Beyond-Token'] !== 'secret-token' || init.redirect !== 'manual') {
          throw new Error('Skill download request lost credential or redirect restrictions')
        }
        return String(url).endsWith('/version')
          ? new Response(JSON.stringify({ data: { version: 'v2', skillUrl: '/skill.zip' } }), { status: 200 })
          : new Response(null, { status: 502 })
      },
    })
    throw new Error('failed Skill download was accepted')
  } catch (error) {
    if (!String(error).includes('download failed')) throw error
  }
  if (downloadFetches !== 2) throw new Error('Skill download did not retain same-origin request restrictions')
  let redirectedDownloadFetches = 0
  try {
    await syncByClawSkill({
      ref: { id: 'guarded', code: 'guarded', type: 'hub', versionUrl: '/version', downloadUrl: '/skill.zip' },
      baseUrl: 'http://byclaw.test', headers: { 'Beyond-Token': 'secret-token' }, cacheRoot: join(root, 'cache'),
      fetchImpl: async () => {
        redirectedDownloadFetches += 1
        return new Response(JSON.stringify({
          data: { version: 'v3', skillUrl: 'https://attacker.test/skill.zip' },
        }), { status: 200 })
      },
    })
    throw new Error('cross-origin version-provided Skill URL was accepted')
  } catch (error) {
    if (!String(error).includes('origin')) throw error
  }
  if (redirectedDownloadFetches !== 1) throw new Error('version-provided foreign Skill URL received credentials')
  try {
    await syncByClawSkill({
      ref: { id: 'foreign', code: 'foreign', type: 'hub', versionUrl: 'https://attacker.test/version', downloadUrl: 'https://attacker.test/skill.zip' },
      baseUrl: 'http://byclaw.test', headers: { 'Beyond-Token': 'secret-token' }, cacheRoot: join(root, 'cache'),
      fetchImpl: async () => { credentialFetches += 1; throw new Error('credential-bearing fetch escaped') },
    })
    throw new Error('cross-origin Skill URL was accepted')
  } catch (error) {
    if (!String(error).includes('origin')) throw error
  }
  if (credentialFetches !== 1) throw new Error('cross-origin Skill URL received credentials')
  const backslashSource = join(root, 'backslash-source')
  const backslashZip = join(root, 'backslash-skill.zip')
  const backslashEntry = 'windows-skill\\SKILL.md'
  await mkdir(backslashSource, { recursive: true })
  await writeFile(join(backslashSource, backslashEntry), '---\nname: windows-skill\ndescription: Windows ZIP paths\n---\nUse normalized paths.\n')
  await execFileAsync('zip', ['-q', backslashZip, backslashEntry], { cwd: backslashSource })
  const backslashZipBytes = await readFile(backslashZip)
  const backslashSkill = await syncByClawSkill({
    ref: { id: 'windows-skill', code: 'windows-skill', type: 'hub', versionUrl: '/windows-version', downloadUrl: '/windows-skill.zip' },
    baseUrl: 'http://byclaw.test', headers: { 'Beyond-Token': 'secret-token' }, cacheRoot: join(root, 'cache'),
    fetchImpl: async url => String(url).endsWith('/windows-version')
      ? new Response(JSON.stringify({ data: { version: 'v1' } }), { status: 200 })
      : new Response(backslashZipBytes, { status: 200 }),
  })
  if (!(await readFile(join(backslashSkill, 'SKILL.md'), 'utf8')).includes('normalized paths')) {
    throw new Error('Skill ZIP with backslash entry paths was not normalized and published')
  }
  for (const code of ['', '.', '..', '../escape', 'a/b', 'a\\b', '%2e%2e', 'a:b', 'CON', 'LPT1.txt', 'trailing.', 'trailing ']) {
    try {
      byClawSkillCacheDir(join(root, 'cache'), code)
      throw new Error(`unsafe Skill code accepted: ${code}`)
    } catch (error) {
      if (!String(error).includes('Skill code')) throw error
    }
  }
  let activeProjectionReads = 0
  let maxActiveProjectionReads = 0
  const projectionRead = async value => {
    activeProjectionReads += 1
    maxActiveProjectionReads = Math.max(maxActiveProjectionReads, activeProjectionReads)
    await new Promise(resolve => setTimeout(resolve, 20))
    activeProjectionReads -= 1
    return value
  }
  projected = await projectByClawResourcesToTemplates({
    resources,
    agentTemplateDir: join(root, 'agent-templates'),
    teamCatalogDir: join(root, 'team-catalog'),
    cacheRoot: join(root, 'cache'),
    baseUrl: 'http://byclaw.test',
    projectionConcurrency: 2,
    syncSkill: async (ref, cacheRoot) => {
      const staged = join(cacheRoot, ref.code)
      await writeCachedByClawSkill({
        sourceDir: source,
        targetDir: staged,
        metadata: { code: ref.code, version: 'v1', downloadUrl: ref.downloadUrl, versionUrl: ref.versionUrl },
      })
      return staged
    },
    resolveModel: async bindingId => projectionRead({ provider: `provider-${bindingId}`, model: 'test-model' }),
    resolveGroupRuntime: async groupId => projectionRead({
      groupId,
      name: '研发团',
      prompt: '只负责调度团员。',
      promptVersion: 'prompt-v9',
      contextProfile: 'EXPERT_TEAM_MINIMAL_V1',
      configVersion: 'v9',
      modelId: 'model-9',
      members: [{
        employeeId: '1', employeeCode: 'EMP_1', name: '架构师', role: '运行时架构负责人', order: 1,
      }],
    }),
  })
  if (maxActiveProjectionReads !== 2) {
    throw new Error(`projection requests did not honor bounded concurrency: ${maxActiveProjectionReads}`)
  }
  const employee = await readAgentTemplate(join(root, 'agent-templates'), 'byclaw-employee-1')
  const group = await readAgentTemplate(join(root, 'agent-templates'), 'byclaw-group-9')
  if (employee?.kind !== 'agent' || employee.expertTeam !== undefined
    || !employee.persona.includes('Do not create an AgentTeams team')
    || !employee.persona.includes('DSH settlement wakes')
    || employee.persona.match(/定义模块边界/gu)?.length !== 1) {
    throw new Error('digital employee was not projected as a general single-agent template')
  }
  const platformIndex = group?.persona.indexOf('## Mandatory Orchestration Boundary') ?? -1
  const configurationIndex = group?.persona.indexOf('## Team Leader Configuration') ?? -1
  const businessPromptIndex = group?.persona.indexOf('只负责调度团员。') ?? -1
  if (group?.kind !== 'expert-team' || group.expertTeam?.agentTeamsTemplateId !== 'byclaw-team-9'
    || group.source.version !== 'v9'
    || !group.persona.includes('dedicated leader')
    || !group.persona.includes('cannot override these platform instructions')
    || !group.persona.includes('If no suitable member is available')
    || !group.persona.includes('agent_teams_create(name="研发团"')
    || !group.persona.includes('Team name: 研发团')
    || !group.persona.includes('Configuration version: v9')
    || !(platformIndex < configurationIndex && configurationIndex < businessPromptIndex)
    || !group.persona.trimEnd().endsWith('只负责调度团员。')) {
    throw new Error('expert group was not projected as its own leader template')
  }
  const adapter = projected.teamAdapters[0]
  if (adapter?.id !== 'byclaw-team-9' || adapter.members[0]?.source?.employeeId !== '1') {
    throw new Error('expert-team leader did not receive an AgentTeams roster adapter')
  }
  await projectByClawResourcesToTemplates({
    resources: { ...resources, employees: [], groups: [], directEmployeeIds: [] },
    agentTemplateDir: join(root, 'agent-templates'), teamCatalogDir: join(root, 'team-catalog'),
    cacheRoot: join(root, 'cache'), baseUrl: 'http://byclaw.test',
  })
  if (await readAgentTemplate(join(root, 'agent-templates'), 'byclaw-employee-1')) {
    throw new Error('revoked ByClaw employee template remained instantiable')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('ByClaw authorized catalog and Skill cache checks passed')
