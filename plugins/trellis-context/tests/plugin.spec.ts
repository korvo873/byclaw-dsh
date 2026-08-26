import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SessionTelemetryCoordinator } from '@deepseek-ai/dsh-session-telemetry'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import * as yaml from 'js-yaml'
import { openContainedFile } from '../src/context.ts'
import { parseTrellisHookContext, quotePosixShellWord } from '../src/hooks.ts'
import * as TrellisPlugin from '../src/index.ts'
import { writeTransactionRaceHook } from './transaction-test-utils.ts'

const RESOURCE_DIR = fileURLToPath(new URL('../resources/ensure-trellis-init', import.meta.url))
const SESSION_CONTEXT = `<session-context>
SESSION-START-CONTEXT
</session-context>

<guidelines>
## Available indexes (read on demand)
- .trellis/spec/backend/index.md
</guidelines>`

let temporaryRoots: string[] = []
let contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
  await Promise.all(temporaryRoots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

function shellResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1_000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

class FakeShell extends ShellExecutor {
  readonly specs: ShellExecSpec[] = []
  handler: (spec: ShellExecSpec) => Promise<ShellRunResult> = async () => shellResult()

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/unused',
      timeoutMs: request.timeoutMs ?? 1_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64 * 1024,
      ...request.signal === undefined ? {} : { signal: request.signal },
      ...request.stdin === undefined ? {} : { stdin: request.stdin },
      ...request.env === undefined ? {} : { env: request.env },
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    if (spec.command.includes('transaction_helper.py')) return runActualShell(spec)
    return this.handler(spec)
  }

  override start(): ShellProcess {
    throw new Error('trellis-context must never start a background process')
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function makeRoot(): Promise<string> {
  const parent = await mkdtemp(join(process.cwd(), '.dsh-trellis-context-'))
  temporaryRoots.push(parent)
  const root = join(parent, "repo 'quoted'")
  await mkdir(root)
  await writeFile(join(root, '.gitmodules'), '[submodule "fixture"]\n', { mode: 0o600 })
  return realpath(root)
}

async function runActualShell(spec: ShellExecSpec): Promise<ShellRunResult> {
  const child = spawn('bash', ['-c', spec.command], {
    cwd: spec.workdir,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  return shellResult({
    exitCode,
    signal,
    stdout: { text: Buffer.concat(stdout).toString('utf8'), truncated: false },
    stderr: { text: Buffer.concat(stderr).toString('utf8'), truncated: false },
  })
}

function transactionSpec(spec: ShellExecSpec, root: string): { helper: string; stateDir: string; path: string } {
  const helper = spec.env?.['TRELLIS_CONTEXT_TRANSACTION_HELPER']
  const stateDir = spec.env?.['TRELLIS_CONTEXT_STATE_DIR']
  if (helper === undefined || stateDir === undefined) throw new Error('initializer transaction helper environment is missing')
  const digest = createHash('sha256').update(root).digest('hex')
  return { helper, stateDir, path: join(stateDir, `${digest}.pending`) }
}

async function ensureTransaction(spec: ShellExecSpec, root: string): Promise<string> {
  const transaction = transactionSpec(spec, root)
  const result = await runActualShell({
    ...spec,
    command: `python3 ${[transaction.helper, 'ensure', transaction.stateDir, root]
      .map(quotePosixShellWord).join(' ')}`,
  })
  if (result.exitCode !== 0) throw new Error(`transaction helper failed: ${result.stderr.text}`)
  return transaction.path
}

async function installGeneratedTrellis(root: string, spec = 'SPEC-INDEX-CONTENT'): Promise<void> {
  await mkdir(join(root, '.claude/hooks'), { recursive: true })
  await mkdir(join(root, '.claude/skills/trellis-spec-bootstrap'), { recursive: true })
  await mkdir(join(root, '.trellis/spec/backend'), { recursive: true })
  await writeFile(join(root, '.claude/hooks/session-start.py'), '# session start\n')
  await writeFile(join(root, '.claude/hooks/inject-workflow-state.py'), '# workflow state\n')
  await writeFile(
    join(root, '.claude/skills/trellis-spec-bootstrap/SKILL.md'),
    '# trellis-spec-bootstrap\nComplete generated bootstrap.\n',
  )
  await writeFile(join(root, '.trellis/spec/backend/index.md'), `${spec}\n`)
}

function hookOutput(hookEventName: 'SessionStart' | 'UserPromptSubmit', additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })
}

function initializerWord(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ').replaceAll("'", "\\'")
}

function unquotePosixShellWord(value: string): string {
  if (!value.startsWith("'") || !value.endsWith("'")) throw new Error(`not a quoted shell word: ${value}`)
  return value.slice(1, -1).replaceAll("'\\''", "'")
}

interface HandlerOptions {
  initializer?: 'initialized' | 'already-initialized'
  pendingBootstrap?: 'inspect' | 'none'
  sessionContext?: string
  operationResult?: Partial<Record<'initializer' | 'session-start' | 'workflow-state', ShellRunResult>>
}

function trellisHandler(root: string, options: HandlerOptions = {}): {
  handler: (spec: ShellExecSpec) => Promise<ShellRunResult>
  workflowPrompts: string[]
  transactionPaths: string[]
} {
  let workflowCount = 0
  let initialized = false
  const workflowPrompts: string[] = []
  const transactionPaths: string[] = []
  return {
    workflowPrompts,
    transactionPaths,
    handler: async (spec) => {
      if (spec.command === 'git rev-parse --show-toplevel') {
        return shellResult({ stdout: { text: `${root}\n`, truncated: false } })
      }
      if (spec.command.includes('ensure_trellis_init.sh')) {
        const transactionPath = transactionSpec(spec, root).path
        transactionPaths.push(transactionPath)
        const override = options.operationResult?.initializer
        if (override !== undefined) return override
        if (options.initializer === 'initialized' && !initialized) {
          initialized = true
          await installGeneratedTrellis(root)
          await ensureTransaction(spec, root)
          return shellResult({
            stdout: {
              text: `status=initialized project_root=${initializerWord(root)} codegraph_index=${initializerWord(join(root, '.codegraph'))} bootstrap_skill=${initializerWord(join(root, '.claude/skills/trellis-spec-bootstrap/SKILL.md'))}\n`,
              truncated: false,
            },
          })
        }
        return shellResult({
          stdout: {
            text: `status=already_initialized project_root=${initializerWord(root)} pending_bootstrap=${options.pendingBootstrap ?? 'inspect'}\n`,
            truncated: false,
          },
        })
      }
      if (spec.command.includes('session-start.py')) {
        const override = options.operationResult?.['session-start']
        if (override !== undefined) return override
        return shellResult({
          stdout: {
            text: hookOutput('SessionStart', options.sessionContext ?? SESSION_CONTEXT),
            truncated: false,
          },
        })
      }
      if (spec.command.includes('inject-workflow-state.py')) {
        const override = options.operationResult?.['workflow-state']
        if (override !== undefined) return override
        const input = JSON.parse(spec.stdin ?? '{}') as { prompt?: string }
        workflowPrompts.push(input.prompt ?? '')
        workflowCount += 1
        return shellResult({
          stdout: {
            text: hookOutput('UserPromptSubmit', `<workflow-state>WORKFLOW-${String(workflowCount)}</workflow-state>`),
            truncated: false,
          },
        })
      }
      throw new Error(`unexpected shell command: ${spec.command}`)
    },
  }
}

async function harness(
  root: string,
  handler: (spec: ShellExecSpec) => Promise<ShellRunResult>,
  config: Partial<TrellisPlugin.Config> = {},
  mountBeforeTrellis?: (ctx: Context) => Promise<void>,
): Promise<{
  ctx: Context
  shell: FakeShell
  adapter: RecordingAdapter
  pluginFiber: { dispose(): Promise<void>; restart(): Promise<void> }
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FakeShell)
  const shell = ctx.shell as FakeShell
  shell.handler = handler
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountBeforeTrellis?.(ctx)
  const pluginFiber = await ctx.plugin(TrellisPlugin, {
    enabled: true,
    userCode: 'test-user',
    resourceDir: RESOURCE_DIR,
    timeoutMs: 1_000,
    stateDir: join(dirname(root), 'trellis-context-state'),
    ...config,
  })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, shell, adapter, pluginFiber }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function send(agent: ReturnType<Context['agentLoop']['create']>, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  return agent.whenIdle()
}

function pluginEvents(events: readonly SessionEvent[]): Array<SessionEvent<'user/message'>> {
  return events.filter((event): event is SessionEvent<'user/message'> => (
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'trellis-context'
  ))
}

function messageText(event: SessionEvent<'user/message'>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function mountPersistence(ctx: Context, root: string, kind: 'jsonl' | 'sqlite'): Promise<void> {
  if (kind === 'jsonl') {
    await ctx.plugin(JsonlSessionPersistence, {
      root: join(dirname(root), 'session-jsonl'),
      compression: 'none',
      packChunks: false,
      writeBatchMaxDelayMs: 1,
    })
    return
  }
  await ctx.plugin(SqliteSessionPersistence, {
    path: join(dirname(root), 'session.sqlite'),
    journalMode: 'delete',
    writeBatchMaxDelayMs: 1,
  })
}

describe('same-step Trellis context through the real Agent Loop', () => {
  it('applies the active session sandbox policy to every shell command', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root)
    const { ctx, shell, adapter } = await harness(root, fixture.handler, {}, async inner => {
      await inner.plugin(SandboxPolicyService, {
        mode: 'read-only',
        workspaceRoot: '/deployment-fallback',
      })
    })
    const agent = ctx.agentLoop.create(
      SessionId('session-sandbox-policy'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )
    setSandboxMode(agent.session, 'danger-full-access')

    await send(agent, 'inspect project policy')

    expect(adapter.requests).toHaveLength(1)
    expect(shell.specs.length).toBeGreaterThan(0)
    expect(shell.specs.every(spec => (
      spec.sandboxPolicy?.mode === 'danger-full-access'
      && spec.sandboxPolicy.workspaceRoot === root
      && spec.sandboxPolicy.sessionId === 'session-sandbox-policy'
    ))).toBe(true)
  })

  it('logs initialized bootstrap, the exact SessionStart context, and workflow state in the first model step', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx, shell, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('initialized'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'implement feature')

    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('trellis-spec-bootstrap')
    expect(request).toContain('CodeGraph')
    expect(request).toContain('Post-bootstrap Git workflow')
    expect(request).toContain('SESSION-START-CONTEXT')
    expect(request).toContain('.trellis/spec/backend/index.md')
    expect(request).not.toContain('SPEC-INDEX-CONTENT')
    expect(request).toContain('WORKFLOW-1')
    const context = pluginEvents(agent.session.events)[0]
    expect(context?.data.source).toEqual({ kind: 'plugin', plugin: 'trellis-context' })
    expect(context?.surfaceOp).toBe('append')

    const initializer = shell.specs.find(spec => spec.command.includes('ensure_trellis_init.sh'))
    expect(initializer?.env?.['USER_CODE']).toBe('test-user')
    expect(initializer?.command).toContain("'\\''")
    const hookSpecs = shell.specs.filter(spec => (
      spec.command.includes('session-start.py') || spec.command.includes('inject-workflow-state.py')
    ))
    expect(hookSpecs).toHaveLength(2)
    expect(hookSpecs.every(spec => spec.stdin !== undefined)).toBe(true)
    expect(hookSpecs.every(spec => spec.workdir === root)).toBe(true)
    expect(JSON.parse(hookSpecs[0]!.stdin ?? '{}')).toMatchObject({
      cwd: root,
      session_id: 'initialized',
      hook_event_name: 'SessionStart',
    })
    expect(JSON.parse(hookSpecs[1]!.stdin ?? '{}')).toMatchObject({
      cwd: root,
      session_id: 'initialized',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'implement feature',
    })
    expect(fixture.workflowPrompts).toEqual(['implement feature'])
  })

  it('adds the exact SessionStart output once, then only new workflow state', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root)
    const { ctx, shell, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('later-turn'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'first prompt')
    await send(agent, 'second prompt')

    expect(adapter.requests).toHaveLength(2)
    const texts = pluginEvents(agent.session.events).map(messageText)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('SESSION-START-CONTEXT')
    expect(texts[0]).toContain('.trellis/spec/backend/index.md')
    expect(texts[0]).not.toContain('SPEC-INDEX-CONTENT')
    expect(texts[0]).toContain('WORKFLOW-1')
    expect(texts[1]).toContain('WORKFLOW-2')
    expect(texts[1]).not.toContain('SESSION-START-CONTEXT')
    expect(texts[1]).not.toContain('.trellis/spec/backend/index.md')
    expect(shell.specs.filter(spec => spec.command.includes('session-start.py'))).toHaveLength(1)
  })

  it('recovers recursively nested spec indexes omitted by the repository SessionStart hook', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const nestedIndex = join(root, '.trellis/spec/beyonai/byclaw-test/frontend/index.md')
    await mkdir(dirname(nestedIndex), { recursive: true })
    await writeFile(nestedIndex, 'NESTED-FRONTEND-SPEC\n')
    const fixture = trellisHandler(root)
    const { ctx, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('nested-spec-index'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'inspect beyonai/byclaw-test frontend architecture')

    const context = pluginEvents(agent.session.events)[0]
    expect(context).toBeDefined()
    expect(messageText(context!)).toContain('.trellis/spec/backend/index.md')
    expect(messageText(context!)).toContain('.trellis/spec/beyonai/byclaw-test/frontend/index.md')
    expect(messageText(context!)).not.toContain('NESTED-FRONTEND-SPEC')
    expect(messageText(context!)).toContain('Before the first CodeGraph or native code exploration')
    expect(adapter.requests[0]?.system).toContain('Before the first CodeGraph or native code exploration')
  })

  it('injects an existing Trellis repository without submodules or bootstrap state', async () => {
    const root = await makeRoot()
    await rm(join(root, '.gitmodules'))
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root, { pendingBootstrap: 'none' })
    const { ctx, shell, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('existing-no-submodules'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'inspect existing project')

    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('SESSION-START-CONTEXT')
    expect(adapter.requests[0]?.system).toContain('## Trellis workspace context')
    expect(adapter.requests[0]?.system).toContain('plugin:trellis-context')
    expect(shell.specs
      .filter(spec => spec.command.includes('transaction_helper.py'))
      .map(spec => spec.command)).toHaveLength(1)
    expect(shell.specs.some(spec => spec.command.includes("'inspect'"))).toBe(false)
  })

  it('dedupes a reconstructed durable session while giving a child independent SessionStart context', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const firstFixture = trellisHandler(root)
    const first = await harness(root, firstFixture.handler)
    const original = first.ctx.agentLoop.create(SessionId('durable'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await send(original, 'original prompt')
    const durableSeed = [...original.session.events]
    await first.ctx.fiber.dispose()
    contexts = contexts.filter(context => context !== first.ctx)

    const resumedFixture = trellisHandler(root)
    const resumed = await harness(root, resumedFixture.handler)
    const handle = await resumed.ctx.agentLoop.createAgent(resumed.ctx, {
      sessionId: SessionId('durable'),
      seed: durableSeed,
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await send(handle.agent, 'resumed prompt')

    const resumedNewContext = pluginEvents(handle.agent.session.events).at(-1)
    expect(resumedNewContext).toBeDefined()
    expect(messageText(resumedNewContext!)).toContain('WORKFLOW-1')
    expect(messageText(resumedNewContext!)).not.toContain('SESSION-START-CONTEXT')
    expect(resumed.shell.specs.filter(spec => spec.command.includes('session-start.py'))).toHaveLength(0)

    const childSeed = [...handle.agent.session.events]
    const child = await resumed.ctx.agentLoop.createAgent(resumed.ctx, {
      sessionId: SessionId('durable-child'),
      seed: childSeed,
      meta: {
        cwd: root,
        parentSession: handle.agent.session.id,
        seedLength: childSeed.length,
      },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await send(child.agent, 'child prompt')

    const childContext = pluginEvents(child.agent.session.events).at(-1)
    expect(childContext).toBeDefined()
    expect(messageText(childContext!)).toContain('SESSION-START-CONTEXT')
    expect(messageText(childContext!)).toContain('.trellis/spec/backend/index.md')
    expect(messageText(childContext!)).not.toContain('SPEC-INDEX-CONTENT')
    expect(resumed.shell.specs.filter(spec => spec.command.includes('session-start.py'))).toHaveLength(1)
    expect(resumed.adapter.requests.at(-1)?.system).toContain('## Trellis workspace context')
  })

  it('delegates a non-Git workspace without changing the admitted prompt', async () => {
    const root = await makeRoot()
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      expect(spec.command).toBe('git rev-parse --show-toplevel')
      return shellResult({ exitCode: 128, stderr: { text: 'not a git repository', truncated: false } })
    }
    const { ctx, shell, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('non-git'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'plain prompt')

    expect(shell.specs).toHaveLength(1)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('plain prompt')
    expect(adapter.requests[0]?.system).not.toContain('## Trellis workspace context')
  })

  it('does not log prepared context when a downstream listener rejects the step', async () => {
    const root = await makeRoot()
    const ordinary = trellisHandler(root)
    let initializerRuns = 0
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('ensure_trellis_init.sh')) return ordinary.handler(spec)
      initializerRuns += 1
      if (initializerRuns > 1) return ordinary.handler(spec)
      await installGeneratedTrellis(root)
      await ensureTransaction(spec, root)
      return shellResult({
        stdout: {
          text: `status=initialized project_root=${initializerWord(root)} codegraph_index=${initializerWord(join(root, '.codegraph'))} bootstrap_skill=${initializerWord(join(root, '.claude/skills/trellis-spec-bootstrap/SKILL.md'))}\n`,
          truncated: false,
        },
      })
    }
    const { ctx, shell, adapter } = await harness(root, handler)
    let first = true
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (!first) return next()
      first = false
      return { kind: 'reject' }
    })
    const agent = ctx.agentLoop.create(SessionId('rejected'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'rejected prompt')

    expect(adapter.requests).toHaveLength(0)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
    expect(shell.specs).toHaveLength(0)

    await send(agent, 'retry prompt')

    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('trellis-spec-bootstrap')
    expect(initializerRuns).toBe(1)
  })

  it('preserves an empty downstream admission without Trellis side effects', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx, shell, adapter } = await harness(root, fixture.handler)
    ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
    const agent = ctx.agentLoop.create(SessionId('empty-enter'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'removed downstream')

    expect(shell.specs).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'step/start')).toBe(false)
  })

  it('builds workflow hook input from the final downstream messages', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root)
    const { ctx } = await harness(root, fixture.handler)
    ctx.on('agent/pre-step', async () => ({
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'downstream replacement' }],
        source: { kind: 'user' },
      })],
    }))
    const agent = ctx.agentLoop.create(SessionId('downstream-prompt'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'original prompt')

    expect(fixture.workflowPrompts).toEqual(['downstream replacement'])
  })

  it('retries newly initialized bootstrap after SessionStart fails and publishes it exactly once', async () => {
    const root = await makeRoot()
    const ordinary = trellisHandler(root, { initializer: 'initialized' })
    let failSessionStart = true
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (failSessionStart && spec.command.includes('session-start.py')) {
        failSessionStart = false
        return shellResult({ stdout: { text: '{', truncated: false } })
      }
      return ordinary.handler(spec)
    }
    const { ctx, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('retry-bootstrap'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'first attempt fails')
    await send(agent, 'retry succeeds')
    await send(agent, 'after commit')

    expect(adapter.requests).toHaveLength(2)
    const contexts = pluginEvents(agent.session.events).map(messageText)
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toContain('trellis-spec-bootstrap')
    expect(contexts[1]).not.toContain('trellis-spec-bootstrap')
  })

  it.each(['jsonl', 'sqlite'] as const)(
    'clears the private pending fact only after %s stores the exact bootstrap event',
    async (persistenceKind) => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
      const { ctx } = await harness(root, fixture.handler, {}, async inner => {
        await mountPersistence(inner, root, persistenceKind)
      })
      const agent = ctx.agentLoop.create(
        SessionId(`bootstrap-commit-${persistenceKind}`),
        { provider: 'mock', model: 'mock' },
        { cwd: root },
      )

      await send(agent, 'commit bootstrap')

      const expected = pluginEvents(agent.session.events)[0]!
      expect(messageText(expected)).toContain('trellis-context:bootstrap')
      await vi.waitFor(async () => {
        await expect(stat(fixture.transactionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      })
      const durable = await ctx.sessionPersistence.readFrom(agent.session.id, expected.seq)
      expect(durable.events.find(event => event.seq === expected.seq)).toEqual(expected)
    },
  )

  it('retains the private pending fact when telemetry is mounted without persistence', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, {}, async (inner) => {
      await inner.plugin({
        name: 'telemetry-without-persistence',
        inject: ['sessions'],
        apply: (telemetryContext: Context) => {
          new SessionTelemetryCoordinator(telemetryContext, {
            emit: () => {},
            flush: () => {},
            shutdown: () => Promise.resolve(),
          })
        },
      })
    })
    const agent = ctx.agentLoop.create(
      SessionId('bootstrap-telemetry-without-persistence'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )

    await send(agent, 'telemetry is not durable storage')

    let removed = false
    try {
      await vi.waitFor(async () => {
        await expect(stat(fixture.transactionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      }, { timeout: 200 })
      removed = true
    } catch {
      // The expected retained marker makes the bounded removal probe time out.
    }
    expect(removed).toBe(false)
    await expect(stat(fixture.transactionPaths[0]!)).resolves.toBeDefined()
  })

  it('retains the private pending fact when persistence cannot return the exact bootstrap event', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, {}, async inner => {
      await mountPersistence(inner, root, 'jsonl')
    })
    const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'readFrom').mockImplementation(async (id, fromSeq, signal) => {
      const stored = await readFrom(id, fromSeq, signal)
      return {
        meta: stored.meta,
        events: stored.events.map(event => event.seq === fromSeq && event.type === 'user/message'
          ? {
              ...event,
              data: {
                ...event.data,
                content: [{ type: 'text' as const, text: 'mismatched durable content' }],
              },
            }
          : event),
      }
    })
    const agent = ctx.agentLoop.create(
      SessionId('bootstrap-mismatched-durable-event'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )

    await send(agent, 'persist a mismatched event')

    let removed = false
    try {
      await vi.waitFor(async () => {
        await expect(stat(fixture.transactionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      }, { timeout: 200 })
      removed = true
    } catch {
      // Exact-event rejection retains the marker, so the bounded removal probe expires.
    }
    expect(removed).toBe(false)
    await expect(stat(fixture.transactionPaths[0]!)).resolves.toBeDefined()
  })

  it('defers the persistence barrier until synchronous event observers enqueue the bootstrap', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, {}, async inner => {
      await mountPersistence(inner, root, 'jsonl')
    })
    const flushEntered = deferred<void>()
    const releaseFlush = deferred<void>()
    let enqueued = false
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'trellis-context') {
        enqueued = true
      }
    })
    ctx.on('session/flush', async () => {
      expect(enqueued).toBe(true)
      flushEntered.resolve(undefined)
      await releaseFlush.promise
    })
    const agent = ctx.agentLoop.create(SessionId('bootstrap-barrier'), { provider: 'mock', model: 'mock' }, { cwd: root })

    const sending = send(agent, 'block durability')
    await flushEntered.promise
    await expect(stat(fixture.transactionPaths[0]!)).resolves.toBeDefined()

    releaseFlush.resolve(undefined)
    await sending
    await vi.waitFor(async () => {
      await expect(stat(fixture.transactionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('keeps the private pending fact on persistence failure and retries in a fresh process', async () => {
    const root = await makeRoot()
    const firstFixture = trellisHandler(root, { initializer: 'initialized' })
    const first = await harness(root, firstFixture.handler)
    let failedFlushes = 0
    first.ctx.on('session/flush', () => {
      failedFlushes += 1
      return Promise.reject(new Error('controlled persistence failure'))
    })
    const firstAgent = first.ctx.agentLoop.create(
      SessionId('bootstrap-persistence-retry'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )

    await send(firstAgent, 'publication cannot persist')
    await vi.waitFor(() => { expect(failedFlushes).toBe(1) })
    const transactionPath = firstFixture.transactionPaths[0]!
    await expect(stat(transactionPath)).resolves.toBeDefined()
    await first.ctx.fiber.dispose()
    contexts = contexts.filter(candidate => candidate !== first.ctx)

    const secondFixture = trellisHandler(root)
    const second = await harness(root, secondFixture.handler, {}, async inner => {
      await mountPersistence(inner, root, 'jsonl')
    })
    const resumed = second.ctx.agentLoop.create(
      SessionId('bootstrap-persistence-retry'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )
    await send(resumed, 'retry publication')
    await send(resumed, 'after durable publication')

    const bootstrapMessages = pluginEvents(resumed.session.events)
      .map(messageText)
      .filter(text => text.includes('trellis-context:bootstrap'))
    expect(bootstrapMessages).toHaveLength(1)
    await vi.waitFor(async () => {
      await expect(stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('keeps the pending fact when unload cancels a blocked persistence barrier', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx, pluginFiber } = await harness(root, fixture.handler)
    const flushEntered = deferred<void>()
    const releaseFlush = deferred<void>()
    ctx.on('session/flush', async () => {
      flushEntered.resolve(undefined)
      await releaseFlush.promise
    })
    const agent = ctx.agentLoop.create(SessionId('bootstrap-barrier-cancel'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'publish before unload')
    await flushEntered.promise
    const restarting = pluginFiber.restart()
    await Promise.resolve()
    let settled = false
    void restarting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseFlush.resolve(undefined)
    await restarting
    await expect(stat(fixture.transactionPaths[0]!)).resolves.toBeDefined()
  })

  it('stores project-keyed pending state in an owner-only private directory', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('private-transaction'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'retain without persistence')

    const transactionPath = fixture.transactionPaths[0]!
    expect(dirname(transactionPath)).toBe(join(dirname(root), 'trellis-context-state'))
    expect(basename(transactionPath)).toMatch(/^[0-9a-f]{64}\.pending$/)
    expect((await stat(dirname(transactionPath))).mode & 0o777).toBe(0o700)
    expect((await stat(transactionPath)).mode & 0o777).toBe(0o600)
    await expect(stat(join(root, '.trellis/.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines project A state before publishing context for same-path project B', async () => {
    const root = await makeRoot()
    const stateDir = join(dirname(root), 'trellis-context-state')
    const helper = join(RESOURCE_DIR, 'scripts/transaction_helper.py')
    const ensured = await runActualShell({
      command: `python3 ${[helper, 'ensure', stateDir, root].map(quotePosixShellWord).join(' ')}`,
      workdir: root,
      timeoutMs: 1_000,
      stdoutMaxBytes: 64 * 1024,
      sandboxPolicy: undefined,
    })
    expect(ensured.exitCode).toBe(0)
    const transactionPath = join(
      stateDir,
      `${createHash('sha256').update(root).digest('hex')}.pending`,
    )
    await rename(root, `${root}-project-a`)
    await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, '.gitmodules'), '[submodule "project-b"]\n', { mode: 0o600 })
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root)
    const { ctx, adapter } = await harness(root, fixture.handler, { stateDir })
    const agent = ctx.agentLoop.create(
      SessionId('same-path-project-replacement'),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    )

    await send(agent, 'ordinary project B prompt')

    expect(adapter.requests).toHaveLength(1)
    const context = messageText(pluginEvents(agent.session.events)[0]!)
    expect(context).not.toContain('trellis-context:bootstrap')
    expect(context).not.toContain('Complete generated bootstrap')
    await expect(stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(stateDir)).some(name => name.startsWith('.stale-'))).toBe(true)
  })

  it('derives the default private stateDir from DSH_HOME', async () => {
    const root = await makeRoot()
    const dshHome = join(dirname(root), 'configured-dsh-home')
    vi.stubEnv('DSH_HOME', dshHome)
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, {
      stateDir: undefined,
    } as Partial<TrellisPlugin.Config>)
    const agent = ctx.agentLoop.create(SessionId('default-state-dir'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'use default state')

    expect(dirname(fixture.transactionPaths[0]!)).toBe(join(dshHome, 'state', 'trellis-context'))
  })

  it('rejects an existing stateDir that is not owner-only', async () => {
    const root = await makeRoot()
    const stateDir = join(dirname(root), 'public-state')
    await mkdir(stateDir, { mode: 0o700 })
    await chmod(stateDir, 0o755)
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx, shell, adapter } = await harness(root, fixture.handler, { stateDir })
    const agent = ctx.agentLoop.create(SessionId('public-state-dir'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'must reject public state')

    expect(adapter.requests).toHaveLength(0)
    expect(shell.specs.filter(spec => spec.command.includes('ensure_trellis_init.sh'))).toHaveLength(0)
  })

  it('rejects a symlinked stateDir parent without creating files outside it', async () => {
    const root = await makeRoot()
    const outside = join(dirname(root), 'outside-state')
    const linkedParent = join(dirname(root), 'linked-state-parent')
    await mkdir(outside)
    await symlink(outside, linkedParent, 'dir')
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx, shell, adapter } = await harness(root, fixture.handler, {
      stateDir: join(linkedParent, 'trellis-context'),
    })
    const agent = ctx.agentLoop.create(SessionId('state-parent-symlink'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'must reject state parent')

    expect(adapter.requests).toHaveLength(0)
    expect(shell.specs.filter(spec => spec.command.includes('ensure_trellis_init.sh'))).toHaveLength(0)
    await expect(stat(join(outside, 'trellis-context'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a final transaction symlink without changing its outside target', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const outside = join(dirname(root), 'outside-transaction-target')
    await writeFile(outside, 'outside-bytes\n')
    const ordinary = trellisHandler(root)
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('ensure_trellis_init.sh')) return ordinary.handler(spec)
      const path = transactionSpec(spec, root).path
      ordinary.transactionPaths.push(path)
      await symlink(outside, path)
      return shellResult({
        stdout: {
          text: `status=initialized project_root=${initializerWord(root)} codegraph_index=${initializerWord(join(root, '.codegraph'))} bootstrap_skill=${initializerWord(join(root, '.claude/skills/trellis-spec-bootstrap/SKILL.md'))}\n`,
          truncated: false,
        },
      })
    }
    const { ctx, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('transaction-final-symlink'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'must reject final symlink')

    expect(adapter.requests).toHaveLength(0)
    expect(await readFile(outside, 'utf8')).toBe('outside-bytes\n')
    expect((await lstat(ordinary.transactionPaths[0]!)).isSymbolicLink()).toBe(true)
  })

  it('does not clear a transaction path whose file identity was replaced before cleanup', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, {}, async inner => {
      await mountPersistence(inner, root, 'jsonl')
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'user/message'
        || event.data.source.kind !== 'plugin'
        || event.data.source.plugin !== 'trellis-context'
        || !messageText(event).includes('trellis-context:bootstrap')) return
      const path = fixture.transactionPaths[0]!
      renameSync(path, `${path}.original`)
      writeFileSync(path, 'replacement\n', { mode: 0o600 })
    })
    const agent = ctx.agentLoop.create(SessionId('transaction-replacement'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'replace before cleanup')

    await vi.waitFor(async () => {
      expect(await readFile(fixture.transactionPaths[0]!, 'utf8')).toBe('replacement\n')
    })
  })

  it('does not follow a state-directory replacement during cleanup', async () => {
    const root = await makeRoot()
    const stateDir = join(dirname(root), 'trellis-context-state')
    const displaced = `${stateDir}.original`
    const outside = join(dirname(root), 'outside-cleanup-state')
    await mkdir(outside)
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const { ctx } = await harness(root, fixture.handler, { stateDir }, async inner => {
      await mountPersistence(inner, root, 'jsonl')
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'user/message'
        || event.data.source.kind !== 'plugin'
        || event.data.source.plugin !== 'trellis-context'
        || !messageText(event).includes('trellis-context:bootstrap')) return
      const transactionName = basename(fixture.transactionPaths[0]!)
      writeFileSync(join(outside, transactionName), 'outside-marker\n', { mode: 0o600 })
      renameSync(stateDir, displaced)
      symlinkSync(outside, stateDir, 'dir')
    })
    const agent = ctx.agentLoop.create(SessionId('transaction-cleanup-parent-race'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'swap parent during cleanup')

    await vi.waitFor(async () => {
      expect(await readFile(join(outside, basename(fixture.transactionPaths[0]!)), 'utf8'))
        .toBe('outside-marker\n')
    })
    expect((await lstat(stateDir)).isSymbolicLink()).toBe(true)
  })

  it.each(['after-quarantine', 'after-final-revalidation'])(
    'ignores ambient helper race injection at %s',
    async (stage) => {
      const root = await makeRoot()
      const stateDir = join(dirname(root), 'trellis-context-state')
      const displaced = `${stateDir}.original`
      const outside = join(dirname(root), `outside-${stage}`)
      await mkdir(outside, { mode: 0o700 })
      const transactionName = `${createHash('sha256').update(root).digest('hex')}.pending`
      const outsideMarker = join(outside, transactionName)
      await writeFile(outsideMarker, 'outside-marker\n', { mode: 0o600 })
      const outsideNames = await readdir(outside)
      const sentinel = join(dirname(root), `${stage}.sentinel`)
      const hook = await writeTransactionRaceHook(root)
      vi.stubEnv('TRELLIS_CONTEXT_TRANSACTION_RACE_HOOK', hook)
      vi.stubEnv('RACE_STAGE', stage)
      vi.stubEnv('RACE_SUBJECT', stateDir)
      vi.stubEnv('RACE_SENTINEL', sentinel)
      vi.stubEnv('RACE_ACTION', 'swap-directory')
      vi.stubEnv('RACE_SOURCE', stateDir)
      vi.stubEnv('RACE_DISPLACED', displaced)
      vi.stubEnv('RACE_OUTSIDE', outside)
      const fixture = trellisHandler(root, { initializer: 'initialized' })
      const { ctx, shell } = await harness(root, fixture.handler, { stateDir }, async inner => {
        await mountPersistence(inner, root, 'jsonl')
      })
      const agent = ctx.agentLoop.create(
        SessionId(`transaction-helper-${stage}`),
        { provider: 'mock', model: 'mock' },
        { cwd: root },
      )

      await send(agent, 'race descriptor-relative cleanup')

      await vi.waitFor(async () => {
        await expect(stat(fixture.transactionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
      })
      await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(displaced)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(outside)).toEqual(outsideNames)
      expect(await readFile(outsideMarker, 'utf8')).toBe('outside-marker\n')
      expect(shell.specs.some(spec => (
        spec.command.includes('transaction_helper.py') && spec.command.includes("'clear'")
      ))).toBe(true)
    },
  )

  it('retries newly initialized bootstrap after caller cancellation', async () => {
    const root = await makeRoot()
    const ordinary = trellisHandler(root, { initializer: 'initialized' })
    const sessionStart = deferred<ShellRunResult>()
    const sessionStartEntered = deferred<void>()
    let blockSessionStart = true
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (blockSessionStart && spec.command.includes('session-start.py')) {
        blockSessionStart = false
        sessionStartEntered.resolve(undefined)
        return sessionStart.promise
      }
      return ordinary.handler(spec)
    }
    const { ctx, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('cancel-bootstrap'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'cancel after initialization' }],
      source: { kind: 'user' },
    })
    const controller = new AbortController()
    const decision = agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter', messages: [message] }),
    )
    await sessionStartEntered.promise

    controller.abort(new Error('cancel after initialization'))
    sessionStart.resolve(shellResult({ aborted: true }))
    await expect(decision).rejects.toThrow()
    await send(agent, 'retry after cancellation')

    expect(adapter.requests).toHaveLength(1)
    expect(messageText(pluginEvents(agent.session.events)[0]!)).toContain('trellis-spec-bootstrap')
  })

  it('retries newly initialized bootstrap after HMR interrupts delivery', async () => {
    const root = await makeRoot()
    const ordinary = trellisHandler(root, { initializer: 'initialized' })
    const sessionStart = deferred<ShellRunResult>()
    const sessionStartEntered = deferred<void>()
    let blockSessionStart = true
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (blockSessionStart && spec.command.includes('session-start.py')) {
        blockSessionStart = false
        sessionStartEntered.resolve(undefined)
        return sessionStart.promise
      }
      return ordinary.handler(spec)
    }
    const { ctx, adapter, pluginFiber } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('hmr-bootstrap'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const first = send(agent, 'interrupted after initialization')
    await sessionStartEntered.promise

    const restart = pluginFiber.restart()
    sessionStart.resolve(shellResult({ aborted: true }))
    await Promise.all([restart, first])
    await send(agent, 'retry after HMR')

    expect(adapter.requests).toHaveLength(1)
    expect(messageText(pluginEvents(agent.session.events)[0]!)).toContain('trellis-spec-bootstrap')
  })

  it('retries newly initialized bootstrap after process recreation', async () => {
    const root = await makeRoot()
    const initialized = trellisHandler(root, { initializer: 'initialized' })
    const first = await harness(root, async (spec) => {
      if (spec.command.includes('session-start.py')) {
        return shellResult({ stdout: { text: '{', truncated: false } })
      }
      return initialized.handler(spec)
    })
    const original = first.ctx.agentLoop.create(SessionId('restart-bootstrap'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await send(original, 'fails before publication')
    await first.ctx.fiber.dispose()
    contexts = contexts.filter(context => context !== first.ctx)

    const resumedFixture = trellisHandler(root)
    const resumed = await harness(root, resumedFixture.handler)
    const handle = await resumed.ctx.agentLoop.createAgent(resumed.ctx, {
      sessionId: SessionId('restart-bootstrap'),
      seed: [...original.session.events],
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await send(handle.agent, 'retry in new process')

    expect(resumed.adapter.requests).toHaveLength(1)
    expect(messageText(pluginEvents(handle.agent.session.events)[0]!)).toContain('trellis-spec-bootstrap')
  })
})

describe('failure before model request', () => {
  it.each([
    ['initializer timeout', 'initializer', shellResult({ timedOut: true }), 'timed out'],
    ['initializer abort', 'initializer', shellResult({ aborted: true }), 'was aborted'],
    ['initializer null exit', 'initializer', shellResult({ exitCode: null, signal: 'SIGTERM' }), 'without an exit code'],
    ['initializer non-zero exit', 'initializer', shellResult({ exitCode: 7, stderr: { text: 'failed', truncated: false } }), 'exited with code 7'],
    ['initializer malformed output', 'initializer', shellResult({ stdout: { text: 'noise', truncated: false } }), 'invalid status output'],
    ['SessionStart timeout', 'session-start', shellResult({ timedOut: true }), 'timed out'],
    ['workflow non-zero exit', 'workflow-state', shellResult({ exitCode: 9 }), 'exited with code 9'],
    ['workflow lossy output', 'workflow-state', shellResult({ stdout: { text: 'partial', truncated: true } }), 'lossy output'],
  ] as const)('blocks %s', async (_label, operation, result, diagnostic) => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root, { operationResult: { [operation]: result } })
    const { ctx, adapter } = await harness(root, fixture.handler)
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const agent = ctx.agentLoop.create(SessionId(`failure-${operation}`), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'must not reach model')

    expect(adapter.requests).toHaveLength(0)
    expect(String(errors[0])).toContain(root)
    expect(String(errors[0])).toMatch(new RegExp(operation))
    expect(String(errors[0])).toContain(diagnostic)
  })

  it.each([
    ['malformed JSON', '{'],
    ['duplicate JSON', `${hookOutput('SessionStart', 'one')}\n${hookOutput('SessionStart', 'two')}`],
    ['missing additionalContext', JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } })],
    ['mismatched event', hookOutput('UserPromptSubmit', 'wrong')],
    ['empty context', hookOutput('SessionStart', '  ')],
  ])('rejects SessionStart %s', async (_label, stdout) => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root, {
      operationResult: { 'session-start': shellResult({ stdout: { text: stdout, truncated: false } }) },
    })
    const { ctx, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId(`bad-hook-${basename(root)}`), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'blocked')

    expect(adapter.requests).toHaveLength(0)
  })

  it('requires the generated bootstrap Skill after an initialized result', async () => {
    const root = await makeRoot()
    const fixture = trellisHandler(root, { initializer: 'initialized' })
    const original = fixture.handler
    fixture.handler = async (spec) => {
      const result = await original(spec)
      if (spec.command.includes('ensure_trellis_init.sh')) {
        await rm(join(root, '.claude/skills/trellis-spec-bootstrap/SKILL.md'))
      }
      return result
    }
    const { ctx, adapter } = await harness(root, fixture.handler)
    const agent = ctx.agentLoop.create(SessionId('missing-bootstrap'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'blocked')

    expect(adapter.requests).toHaveLength(0)
  })

  it('executes frozen owner-only hook bytes and removes the private copy after settlement', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const originalHook = join(root, '.claude/hooks/session-start.py')
    const displacedHook = join(root, '.claude/hooks/session-start.original.py')
    const outsideHook = join(root, 'swapped-session-start.py')
    await writeFile(outsideHook, '# swapped hook\n')
    const ordinary = trellisHandler(root)
    let frozenHook: string | undefined
    let frozenBytes: string | undefined
    let frozenMode: number | undefined
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('session-start.py')) return ordinary.handler(spec)
      await rename(originalHook, displacedHook)
      await symlink(outsideHook, originalHook)
      frozenHook = unquotePosixShellWord(spec.command.slice('python3 '.length))
      frozenBytes = await readFile(frozenHook, 'utf8')
      frozenMode = (await stat(frozenHook)).mode & 0o777
      return shellResult({
        stdout: { text: hookOutput('SessionStart', SESSION_CONTEXT), truncated: false },
      })
    }
    const { ctx, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('frozen-hook'), { provider: 'mock', model: 'mock' }, { cwd: root })

    await send(agent, 'freeze hook')

    expect(adapter.requests).toHaveLength(1)
    expect(frozenHook).not.toBe(originalHook)
    expect(frozenBytes).toBe('# session start\n')
    expect(frozenMode).toBe(0o700)
    await expect(readFile(frozenHook!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts and drains a blocked initializer before plugin unload settles', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const ordinary = trellisHandler(root)
    const started = deferred<AbortSignal>()
    const blocked = deferred<ShellRunResult>()
    let initializerSettled = false
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('ensure_trellis_init.sh')) return ordinary.handler(spec)
      if (spec.signal === undefined) throw new Error('initializer signal is required')
      started.resolve(spec.signal)
      return blocked.promise.finally(() => { initializerSettled = true })
    }
    const { ctx, adapter, pluginFiber } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('unload-initializer'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const turn = send(agent, 'blocked initializer')
    const signal = await started.promise

    let disposed = false
    const disposal = pluginFiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    const abortedBeforeSettlement = signal.aborted
    const drainedBeforeSettlement = !disposed
    blocked.resolve(shellResult({ aborted: true }))
    await Promise.all([disposal, turn])

    expect(abortedBeforeSettlement).toBe(true)
    expect(drainedBeforeSettlement).toBe(true)
    expect(initializerSettled).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
  })

  it('aborts and drains a blocked hook across HMR without a late durable message', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const ordinary = trellisHandler(root)
    const started = deferred<AbortSignal>()
    const blocked = deferred<ShellRunResult>()
    let hookSettled = false
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('session-start.py')) return ordinary.handler(spec)
      if (spec.signal === undefined) throw new Error('hook signal is required')
      started.resolve(spec.signal)
      return blocked.promise.finally(() => { hookSettled = true })
    }
    const { ctx, adapter, pluginFiber } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('hmr-hook'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const turn = send(agent, 'blocked hook')
    const signal = await started.promise

    let restarted = false
    const restart = pluginFiber.restart().then(() => { restarted = true })
    await Promise.resolve()
    const abortedBeforeSettlement = signal.aborted
    const drainedBeforeSettlement = !restarted
    blocked.resolve(shellResult({ aborted: true }))
    await Promise.all([restart, turn])

    expect(abortedBeforeSettlement).toBe(true)
    expect(drainedBeforeSettlement).toBe(true)
    expect(hookSettled).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
  })

  it('drains a listener captured before blocked downstream admission across HMR', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const fixture = trellisHandler(root)
    const { ctx, shell, adapter, pluginFiber } = await harness(root, fixture.handler)
    const downstream = deferred<PreStepDecision>()
    const downstreamEntered = deferred<void>()
    ctx.on('agent/pre-step', () => {
      downstreamEntered.resolve(undefined)
      return downstream.promise
    })
    const agent = ctx.agentLoop.create(SessionId('hmr-downstream'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const turn = send(agent, 'blocked downstream')
    await downstreamEntered.promise

    let restarted = false
    const restart = pluginFiber.restart().then(() => { restarted = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    const pendingBeforeDownstream = !restarted
    downstream.resolve({
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'released downstream' }],
        source: { kind: 'user' },
      })],
    })
    await Promise.all([restart, turn])

    expect(pendingBeforeDownstream).toBe(true)
    expect(shell.specs).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(pluginEvents(agent.session.events)).toHaveLength(0)
  })

  it('wraps a real caller AbortError with initializer operation context and preserves its cause', async () => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const ordinary = trellisHandler(root)
    const started = deferred<AbortSignal>()
    const blocked = deferred<ShellRunResult>()
    let initializerSettled = false
    const handler = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      if (!spec.command.includes('ensure_trellis_init.sh')) return ordinary.handler(spec)
      if (spec.signal === undefined) throw new Error('initializer signal is required')
      started.resolve(spec.signal)
      return blocked.promise.finally(() => { initializerSettled = true })
    }
    const { ctx, adapter } = await harness(root, handler)
    const agent = ctx.agentLoop.create(SessionId('caller-abort'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'cancel initializer' }],
      source: { kind: 'user' },
    })
    const controller = new AbortController()
    const decision = agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve({ kind: 'enter', messages: [message] }),
    )
    const initializerSignal = await started.promise

    controller.abort(new Error('test caller abort'))
    let error: unknown
    try {
      await decision
    } catch (caught) {
      error = caught
    }
    const abortedBeforeSettlement = initializerSignal.aborted
    blocked.resolve(shellResult({ aborted: true }))
    await ctx.fiber.dispose()
    contexts = contexts.filter(candidate => candidate !== ctx)

    expect(abortedBeforeSettlement).toBe(true)
    expect(initializerSettled).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(String(error)).toContain(root)
    expect(String(error)).toContain('initializer')
    expect((error as Error & { cause?: unknown }).cause).toMatchObject({ name: 'AbortError' })
  })
})

describe('Trellis context parsers', () => {
  it.each([
    ['spec index', '.trellis/spec/backend/index.md'],
    ['bootstrap Skill', '.claude/skills/trellis-spec-bootstrap/SKILL.md'],
  ])('keeps reading the validated %s descriptor after the pathname is swapped', async (_label, relativePath) => {
    const root = await makeRoot()
    await installGeneratedTrellis(root)
    const path = join(root, relativePath)
    const displaced = `${path}.validated`
    const outside = join(root, `outside-${basename(path)}`)
    await writeFile(path, 'VALIDATED-BYTES\n')
    await writeFile(outside, 'SWAPPED-BYTES\n')
    const opened = await openContainedFile(root, path)
    try {
      await rename(path, displaced)
      await symlink(outside, path)

      expect(await opened.readUtf8(new AbortController().signal)).toBe('VALIDATED-BYTES\n')
    } finally {
      await opened.close()
    }
  })

  it('parses only the matching hookSpecificOutput additionalContext', () => {
    const stdout = JSON.stringify({
      additionalContext: 'top-level ignored',
      systemMessage: 'system ignored',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'accepted',
      },
    })

    expect(parseTrellisHookContext(stdout, 'SessionStart')).toBe('accepted')
  })

  it('quotes apostrophes as one POSIX shell word', () => {
    expect(quotePosixShellWord("repo's hook.py")).toBe("'repo'\\''s hook.py'")
  })
})

describe('plugin configuration and Loader composition', () => {
  it('is inert by default even without USER_CODE', async () => {
    const previous = process.env['USER_CODE']
    delete process.env['USER_CODE']
    try {
      const root = await makeRoot()
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(FakeShell)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TrellisPlugin, {})
      const shell = ctx.shell as FakeShell
      const adapter = new RecordingAdapter()
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = ctx.agentLoop.create(SessionId('default-disabled'), { provider: 'mock', model: 'mock' }, { cwd: root })

      await send(agent, 'ordinary prompt')

      expect(shell.specs).toHaveLength(0)
      expect(adapter.requests).toHaveLength(1)
      expect(pluginEvents(agent.session.events)).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env['USER_CODE']
      else process.env['USER_CODE'] = previous
    }
  })

  it.each([
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ timeoutMs: 1.5 }, 'timeoutMs'],
  ] as const)('rejects invalid positive integers in %j', async (config, field) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeShell)
    await expect(ctx.plugin(TrellisPlugin, { enabled: true, userCode: 'user', ...config })).rejects.toThrow(field)
  })

  it.each(['', 'relative/state'])('rejects invalid stateDir %j at activation', async (stateDir) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakeShell)

    await expect(ctx.plugin(TrellisPlugin, {
      enabled: true,
      userCode: 'user',
      stateDir,
    })).rejects.toThrow(/stateDir.*absolute/)
  })

  it('fails activation when enabled without configured or ambient USER_CODE', async () => {
    const previous = process.env['USER_CODE']
    delete process.env['USER_CODE']
    try {
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(FakeShell)
      await expect(ctx.plugin(TrellisPlugin, { enabled: true })).rejects.toThrow(/USER_CODE/)
    } finally {
      if (previous === undefined) delete process.env['USER_CODE']
      else process.env['USER_CODE'] = previous
    }
  })

  it('keeps namespace metadata, applies cordis.patch.yml, and unloads cleanly', async () => {
    const namespace = TrellisPlugin as Record<string, unknown>
    expect(namespace.default).toBeUndefined()
    const unwrapped = Loader.prototype.unwrapExports(namespace) as Record<string, unknown>
    expect(unwrapped).toBe(namespace)
    expect(unwrapped.name).toBe('trellis-context')
    expect(unwrapped.inject).toEqual(['shell', 'sessions', 'systemPrompt'])
    expect(unwrapped.Config).toBeDefined()
    expect(unwrapped.apply).toBe(TrellisPlugin.apply)

    const root = await makeRoot()
    const configPath = join(root, 'config.yml')
    await writeFile(configPath, '[]\n')
    const previousUserCode = process.env['USER_CODE']
    process.env['USER_CODE'] = 'loader-test-user'
    let parsed: unknown
    try {
      parsed = yaml.load(
        await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
        { schema: entryListSchema },
      )
    } finally {
      if (previousUserCode === undefined) delete process.env['USER_CODE']
      else process.env['USER_CODE'] = previousUserCode
    }
    if (!Array.isArray(parsed)) throw new TypeError('Trellis patch must be a list')
    expect(parsed).toMatchObject([{ insert: [{ id: 'trellis-context', config: { enabled: false } }] }])

    const mountPatches = async (patches: PatchOptions[]): Promise<Context> => {
      const context = new Context()
      contexts.push(context)
      context.baseUrl = pathToFileURL(root).href + '/'
      await mountAgentLoopTestDependencies(context)
      await context.plugin(FakeShell)
      await context.plugin(Loader)
      context.loader.builtins.include = Include
      context.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (specifier === '@byclaw/dsh-trellis-context') return TrellisPlugin
          throw new Error(`unexpected Loader import: ${specifier}`)
        },
      } as unknown as NonNullable<typeof context.loader.internal>
      await context.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href, patches },
      })
      await context.loader.await()
      return context
    }

    const context = await mountPatches(parsed as PatchOptions[])
    const entry = [...context.loader.entries()].find(candidate => candidate.options.name === '@byclaw/dsh-trellis-context')
    expect(entry?.options.config).toMatchObject({ enabled: false })
    const mountedFiber = entry?.fiber
    expect(mountedFiber).toBeDefined()

    const trusted = await mountPatches([
      ...(parsed as PatchOptions[]),
      {
        id: 'trellis-context',
        config: {
          enabled: true,
          userCode: 'trusted-loader-user',
          resourceDir: RESOURCE_DIR,
          timeoutMs: 1_000,
        },
      },
    ])
    const trustedEntry = [...trusted.loader.entries()]
      .find(candidate => candidate.options.name === '@byclaw/dsh-trellis-context')
    expect(trustedEntry?.options.config).toMatchObject({ enabled: true, userCode: 'trusted-loader-user' })
    expect(trustedEntry?.fiber?.uid).not.toBeNull()

    await context.fiber.dispose()
    contexts = contexts.filter(candidate => candidate !== context)
    expect(mountedFiber?.uid).toBeNull()
  })
})
