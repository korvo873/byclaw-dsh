/** Runtime instantiation of reusable DSH agent templates. */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAgentTemplate, readAgentTemplateSync, type DshAgentTemplate } from './agent-template.ts'
import type { GenerationLease } from './generation-lease.ts'
import {
  byClawCodeGraphToolNames,
  ensureByClawSessionWorkspace,
  foldByClawSessionWorkspace,
  registerByClawAgentWorkspacePolicy,
} from './session-workspace.ts'

const TEMPLATE_LABEL_PREFIX = 'byclaw-template:'

interface RuntimeSkillRegistry {
  register(skill: {
    name: string
    description: string
    source: 'runtime'
    content: string
    path: string
    resourceBase: { kind: 'directory'; path: string }
  }): () => void
}

interface InstalledTemplateSkills {
  entries: Array<{ name: string; path: string }>
  dispose(): void
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.replace(/^\uFEFF/u, '').startsWith('---')) return undefined
  for (const line of content.split(/\r?\n/u).slice(1)) {
    if (line.trim() === '---' || line.trim() === '...') break
    const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'u').exec(line.trim())
    if (match?.[1] !== undefined) return match[1].trim().replace(/^(['"])(.*)\1$/u, '$2')
  }
  return undefined
}

function skillBody(content: string): string {
  const normalized = content.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---')) return normalized
  const lines = normalized.split(/\r?\n/u)
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---' || lines[index]?.trim() === '...') {
      return lines.slice(index + 1).join('\n').trimStart()
    }
  }
  return normalized
}

function installTemplateSkills(childCtx: Context, template: DshAgentTemplate): InstalledTemplateSkills {
  if (template.skills.length === 0) return { entries: [], dispose: () => undefined }
  const skills = childCtx.get('skills') as unknown as RuntimeSkillRegistry | undefined
  if (skills === undefined) throw new Error(`agent template "${template.id}" requires the DSH Skill registry`)
  const disposers: Array<() => void> = []
  const entries: Array<{ name: string; path: string }> = []
  try {
    for (const source of template.skills) {
      const path = join(source.path, 'SKILL.md')
      const raw = readFileSync(path, 'utf8')
      const definition = {
        name: frontmatterValue(raw, 'name') ?? source.code,
        description: frontmatterValue(raw, 'description') ?? `ByClaw Skill ${source.code}`,
        content: skillBody(raw),
        path,
      }
      disposers.push(skills.register({
        ...definition,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: dirname(path) },
      }))
      entries.push({ name: definition.name, path: source.path })
    }
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return {
    entries,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function templateIdFromLabel(label: string): string | undefined {
  if (!label.startsWith(TEMPLATE_LABEL_PREFIX)) return undefined
  const suffix = label.slice(TEMPLATE_LABEL_PREFIX.length)
  const separator = suffix.lastIndexOf(':')
  return separator < 1 ? undefined : suffix.slice(0, separator)
}

function delegatedTask(parent: Agent, task: string): string {
  const cwd = parent.session.header.cwd
  const workspace = cwd === undefined
    ? ''
    : ['<delegation-workspace>', `cwd: ${cwd}`, '</delegation-workspace>', ''].join('\n')
  return `${workspace}Delegated task from your direct parent:\n\n${task}`
}

/** End a successful asynchronous template dispatch without aborting its tool result. */
export function concludeParentForTemplateInstance(
  exec: Pick<ToolRunContext, 'concludeTurn'>,
): void {
  exec.concludeTurn()
}

/** Install child composition and the model-facing template-instantiation tool. */
export function registerAgentTemplateRuntime(ctx: Context, config: {
  catalogDir: string
  subagentProvider: string
  resolveModel: (bindingId: string, modelId?: string) => Promise<ModelSelection>
  beforeInstantiate?: () => Promise<void>
  generationLease?: GenerationLease
  generationCatalogDir?: string
  maxDepth?: number
}): void {
  const pending = new Map<string, DshAgentTemplate>()
  const pendingModels = new Map<string, ModelSelection>()
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const child = childCtx.agent
    if (child === undefined) return () => undefined
    const inheritedWorkspace = foldByClawSessionWorkspace(child.session.events)
      ?? (child.session.header.parentSession === undefined
        ? undefined
        : foldByClawSessionWorkspace(ctx.agents.get(child.session.header.parentSession)?.session.events ?? []))
    const disposeWorkspace = inheritedWorkspace === undefined
      ? () => undefined
      : (() => {
          ensureByClawSessionWorkspace(child.session, inheritedWorkspace)
          const codeGraphTools = byClawCodeGraphToolNames(child)
          console.info(
            `[byclaw-dsh] 🧭 会话空间 (session=${inheritedWorkspace.externalSessionId}, dsh_session=${child.id}, cwd=${inheritedWorkspace.cwd}, scope=delegated)`,
          )
          console.info(
            `[byclaw-dsh] 🧩 运行能力 (session=${inheritedWorkspace.externalSessionId}, dsh_session=${child.id}, CodeGraph=${codeGraphTools.length === 0 ? 'disabled' : `enabled:${codeGraphTools.length}`})`,
          )
          return registerByClawAgentWorkspacePolicy(childCtx)
        })()
    const descriptor = foldSubagentDescriptor(child.session.events.slice(child.session.header.seedLength ?? 0))
    if (descriptor?.mode !== 'continuable') return disposeWorkspace
    const templateId = templateIdFromLabel(descriptor.label)
    if (templateId === undefined) return disposeWorkspace
    const template = pending.get(descriptor.label) ?? readAgentTemplateSync(config.catalogDir, templateId)
    if (template === undefined) throw new Error(`agent template "${templateId}" disappeared before child composition`)
    const selection = pendingModels.get(descriptor.label)
      ?? (descriptor.agentProvider === undefined || descriptor.agentModel === undefined
        ? undefined
        : { provider: descriptor.agentProvider, model: descriptor.agentModel })
    const installedSkills = installTemplateSkills(childCtx, template)
    console.info(
      `[byclaw-dsh] 🧩 加载会话 Skills (session=${child.id}, template=${template.id}, source=byclaw, count=${installedSkills.entries.length}): ${JSON.stringify(installedSkills.entries)}`,
    )
    const disposeModel = selection === undefined
      ? () => undefined
      : installModelSelection(childCtx, { current: selection, assembled: undefined })
    const disposePolicy = childCtx.systemPrompt.section({
      name: 'byclaw-template:report-policy',
      order: 118,
      text: 'You are a template instance in a durable DSH child session. Put the complete user-facing deliverable in your final response. Do not call the generic report tool: the DSH settlement event delivers that final response and wakes your direct parent asynchronously. Do not ask the parent to poll.',
    })
    return () => {
      disposePolicy()
      installedSkills.dispose()
      disposeModel()
      disposeWorkspace()
    }
  })

  ctx.tools.register(defineTool({
    name: 'byclaw_instantiate_template',
    description: 'Instantiate one authorized DSH agent template as a durable child Agent and delegate a task. A single digital employee never creates AgentTeams; an expert-team template creates its own leader child, and that leader orchestrates its configured roster. This call concludes the dispatch turn; the child report wakes the parent asynchronously.',
    parameters: {
      template_id: { type: 'string', required: true, description: 'Exact template_id returned by byclaw_list_resources.' },
      task: { type: 'string', required: true, description: 'Self-contained assignment for the instantiated Agent. The plugin supplies the inherited workspace separately; do not invent or repeat a cwd.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        template_id: { type: 'string', required: true },
        instance_session_id: { type: 'string', required: true },
        instance_kind: { type: 'string', required: true },
        status: { type: 'string', required: true },
      } },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.instance_kind} template ${value.template_id} instantiated as child ${value.instance_session_id}; parent is waiting for the asynchronous report.`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('byclaw_instantiate_template requires a calling Agent')
      await config.beforeInstantiate?.()
      const task = args.task.trim()
      if (task === '') throw new Error('delegated template task must not be empty')
      const instantiate = async () => {
        const template = await readAgentTemplate(config.catalogDir, args.template_id)
        if (template === undefined) throw new Error(`agent template "${args.template_id}" was not found`)
        if (!template.source.directlyAuthorized && template.kind === 'agent') {
          throw new Error(`agent template "${args.template_id}" is available only through its authorized expert team`)
        }
        const selection = await config.resolveModel(`template:${template.id}`, template.source.modelId)
        const label = `${TEMPLATE_LABEL_PREFIX}${template.id}:${randomUUID()}`
        pending.set(label, template)
        pendingModels.set(label, selection)
        try {
          const started = await ctx.subagents.startContinuable({
            provider: config.subagentProvider,
            label,
            request: {
              prompt: [{ type: 'text', text: delegatedTask(parent, task) }],
              parent,
              persona: template.persona,
              agentOptions: {
                provider: selection.provider,
                model: selection.model,
              },
              ...config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth },
            },
            signal: exec.signal,
          })
          concludeParentForTemplateInstance(exec)
          return {
            template_id: template.id,
            instance_session_id: String(started.childId),
            instance_kind: template.kind,
            status: 'running',
          }
        } finally {
          pending.delete(label)
          pendingModels.delete(label)
        }
      }
      if (config.generationLease === undefined || config.generationCatalogDir === undefined) return instantiate()
      return config.generationLease.read(config.generationCatalogDir, instantiate)
    },
  }))
}
