/**
 * Same-step Trellis repository context for DeepSeek Harness.
 *
 * @module @byclaw/dsh-trellis-context
 */

import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { openContainedFile, trellisContextText } from './context.ts'
import {
  parseTrellisHookContext,
  quotePosixShellWord,
  trellisHookInput,
} from './hooks.ts'
import { parseTrellisInitializerOutput, TrellisInitializer } from './initializer.ts'
import type { TrellisInitResult } from './initializer.ts'
import {
  clearPendingBootstrap,
  inspectPendingBootstrap,
  preparePendingBootstrapPath,
} from './transaction.ts'
import type { PendingBootstrapTransaction, RunTransactionHelper } from './transaction.ts'

const MAX_SHELL_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const SESSION_CONTEXT_MARKER = '<!-- trellis-context:session-start -->'
const BOOTSTRAP_CONTEXT_MARKER = '<!-- trellis-context:bootstrap -->'
const BUNDLED_RESOURCE_DIR = fileURLToPath(new URL('../resources/ensure-trellis-init', import.meta.url))

type ShellSandboxPolicy = ShellExecRequest['sandboxPolicy']

interface PendingPublication {
  readonly transaction: PendingBootstrapTransaction
  readonly sandboxPolicy: ShellSandboxPolicy
}

/** Cordis row name for the Trellis context plugin. */
export const name = 'trellis-context'

/** Shell execution and the live session store required by this plugin. */
export const inject = ['shell', 'sessions', 'systemPrompt'] as const

/** Trusted-profile configuration for same-step Trellis repository context. */
export interface Config {
  /** Activates the plugin only when exactly `true`; omitted and `false` are inert. */
  enabled?: boolean
  /** Non-empty Trellis identity; falls back to the process `USER_CODE`. */
  userCode?: string
  /** Initializer and workflow-reference directory; defaults to the bundled resources. */
  resourceDir?: string
  /** Absolute owner-only transaction directory below non-writable trusted parents; defaults below `$DSH_HOME`. */
  stateDir?: string
  /** Positive safe-integer shell-operation timeout; defaults to 120000 milliseconds. */
  timeoutMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  userCode: z.string(),
  resourceDir: z.string(),
  stateDir: z.string(),
  timeoutMs: z.number(),
})

interface OperationOutput {
  stdout: string
}

function validatePositiveInteger(field: 'timeoutMs', value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`trellis-context: ${field} must be a positive safe integer, got ${String(value)}`)
  }
}

function operationError(projectRoot: string, operation: string, detail: string, cause?: unknown): Error {
  return new Error(`trellis-context ${operation} failed for ${projectRoot}: ${detail}`, {
    ...cause === undefined ? {} : { cause },
  })
}

async function defaultStateDirectory(): Promise<string> {
  const home = resolveDshHome()
  try {
    const info = await lstat(home)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`DSH_HOME is not a no-follow directory: ${home}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return join(await canonicalizeWatchPath(home), 'state', 'trellis-context')
}

function completedOutput(result: ShellRunResult, projectRoot: string, operation: string): OperationOutput {
  if (result.timedOut) throw operationError(projectRoot, operation, `timed out after ${String(result.timeoutMs)}ms`)
  if (result.aborted) throw operationError(projectRoot, operation, 'was aborted')
  if (result.exitCode === null) {
    throw operationError(projectRoot, operation, `terminated without an exit code (signal ${result.signal ?? 'unknown'})`)
  }
  if (result.stdout.truncated || result.stderr.truncated) {
    throw operationError(projectRoot, operation, 'produced lossy output')
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.text.trim()
    throw operationError(
      projectRoot,
      operation,
      `exited with code ${String(result.exitCode)}${detail.length === 0 ? '' : `: ${detail}`}`,
    )
  }
  return { stdout: result.stdout.text }
}

async function readContainedUtf8(root: string, path: string, signal: AbortSignal): Promise<string> {
  const file = await openContainedFile(root, path)
  try {
    return await file.readUtf8(signal)
  } finally {
    await file.close()
  }
}

function currentPrompt(messages: readonly UserMessage[]): string {
  return messages.flatMap(message => message.content.flatMap(block => (
    block.type === 'text' ? [block.text] : []
  ))).join('\n')
}

function durableSessionContextExists(session: Session): boolean {
  const start = session.header.parentSession === undefined ? 0 : (session.header.seedLength ?? 0)
  return session.events.slice(start).some(event => (
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === name
    && event.data.content.some(block => block.type === 'text' && block.text.includes(SESSION_CONTEXT_MARKER))
  ))
}

function durableBootstrapContextEvent(session: Session): SessionEvent<'user/message'> | undefined {
  return session.events.find((event): event is SessionEvent<'user/message'> => (
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === name
    && event.data.content.some(block => block.type === 'text' && block.text.includes(BOOTSTRAP_CONTEXT_MARKER))
  ))
}

function combinedContext(
  initialization: string | undefined,
  sessionContext: string | undefined,
  workflowState: string,
): string {
  return [
    initialization === undefined ? undefined : BOOTSTRAP_CONTEXT_MARKER,
    initialization,
    sessionContext === undefined ? undefined : SESSION_CONTEXT_MARKER,
    sessionContext,
    workflowState,
  ].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}

function trellisPolicy(projectRoot: string): string {
  return [
    '## Trellis workspace context',
    `The current Agent has an active Trellis workspace at ${projectRoot}.`,
    'Treat every plugin:trellis-context message as authoritative project workflow context for the current request.',
    'Follow its task-status instructions before substantive work. Use its available-index list to read the relevant index and rule documents on demand; index bodies are not implicitly included.',
    'Complete any required initialization precheck first. Before the first CodeGraph or native code exploration, read every advertised index whose path covers the package or repository named by the request. This requirement applies equally to root and delegated Agents.',
    'Do not wait for the user or delegating Agent to name Trellis explicitly. Apply the injected workflow whenever it is relevant to the task.',
  ].join('\n')
}

async function discoverSpecIndexes(projectRoot: string, signal: AbortSignal): Promise<string[]> {
  const specRoot = join(projectRoot, '.trellis/spec')
  const indexes: string[] = []
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && entry.name === 'index.md') {
        indexes.push(path.slice(projectRoot.length + 1).replaceAll('\\', '/'))
      }
    }
  }
  await visit(specRoot)
  return indexes
}

async function completeSessionContextIndexes(
  projectRoot: string,
  context: string,
  signal: AbortSignal,
): Promise<{ readonly context: string; readonly recovered: readonly string[] }> {
  const recovered = (await discoverSpecIndexes(projectRoot, signal))
    .filter(path => !context.includes(path))
  if (recovered.length === 0) return { context, recovered }
  return {
    context: [
      context,
      '<!-- trellis-context:spec-index-recovery -->',
      '<trellis-spec-indexes>',
      'Additional available indexes (read on demand):',
      ...recovered.map(path => `- ${path}`),
      'Before the first CodeGraph or native code exploration of a named package or repository, read every matching index above.',
      '</trellis-spec-indexes>',
    ].join('\n\n'),
    recovered,
  }
}

function discoverTrellisRoot(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  let candidate = resolve(cwd)
  while (true) {
    if (existsSync(join(candidate, '.trellis'))
      && existsSync(join(candidate, '.claude/hooks/session-start.py'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

/**
 * Register same-step Trellis initialization and context injection.
 * The listener delegates first, stays inert for rejected or empty admissions, and records
 * every accepted Trellis contribution as a plugin-sourced user message before model dispatch.
 * Newly initialized repositories retain a private transaction until the configured persistence
 * service returns the exact bootstrap event from its durable log. The initializer helper holds a
 * project-scoped process lock and retained root descriptor across every mutating phase. Disposal
 * aborts and drains complete captured admissions, initializer runs, hooks, persistence reads, and
 * transaction cleanup.
 *
 * @param ctx - Plugin context that owns shell execution, admission, and lifecycle effects.
 * @param config - Trusted-profile opt-in, Trellis identity, private state root, and bounded operation settings.
 * @throws During activation for invalid enabled configuration, or during admission when Git,
 * initializer, transaction-helper, contained-file, hook transport, or hook JSON processing fails.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled !== true) return
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  validatePositiveInteger('timeoutMs', timeoutMs)
  const userCode = config.userCode?.trim() || process.env['USER_CODE']?.trim()
  if (userCode === undefined || userCode.length === 0) {
    throw new Error('trellis-context: USER_CODE is required when the plugin is enabled')
  }
  if (config.stateDir !== undefined && (config.stateDir.trim().length === 0 || !isAbsolute(config.stateDir))) {
    throw new TypeError('trellis-context: stateDir must be a non-empty absolute path')
  }
  const configuredStateDir = config.stateDir
  const resolveStateDir = configuredStateDir === undefined
    ? defaultStateDirectory
    : async (): Promise<string> => resolve(configuredStateDir)
  const resourceDir = resolve(config.resourceDir ?? BUNDLED_RESOURCE_DIR)
  const initializerScript = resolve(resourceDir, 'scripts/ensure_trellis_init.sh')
  const transactionHelper = resolve(BUNDLED_RESOURCE_DIR, 'scripts/transaction_helper.py')
  const codegraphWorkflowPath = resolve(resourceDir, 'references/codegraph-bootstrap.md')
  const postBootstrapWorkflowPath = resolve(resourceDir, 'references/post-bootstrap-git.md')
  const lifecycle = new AbortController()
  const activeOperations = new Set<Promise<unknown>>()
  const pendingPublications = new Map<string, PendingPublication>()
  const activeProjectRoots = new Map<Agent, string>()

  ctx.systemPrompt.section({
    name: 'trellis-context:workspace-policy',
    order: 117,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const projectRoot = activeProjectRoots.get(agent) ?? discoverTrellisRoot(agent.session.header.cwd)
      return projectRoot === undefined ? '' : trellisPolicy(projectRoot)
    },
  })

  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation)
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    )
    return operation
  }

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('trellis-context plugin unloaded'))
    activeProjectRoots.clear()
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations])
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    activeProjectRoots.delete(agent)
  })

  const ensureTrellisPolicy = (agent: Agent, projectRoot: string): void => {
    if (activeProjectRoots.get(agent) === projectRoot) return
    activeProjectRoots.set(agent, projectRoot)
    ctx.logger.info(`trellis-context runtime capability registered: session=${agent.id}; cwd=${projectRoot}`)
  }

  const runShell = async (
    projectRoot: string,
    operation: string,
    request: Parameters<typeof ctx.shell.resolve>[0],
  ): Promise<OperationOutput> => {
    let result: ShellRunResult
    try {
      result = await ctx.shell.run(ctx.shell.resolve(request))
    } catch (error) {
      throw operationError(projectRoot, operation, 'shell transport threw', error)
    }
    return completedOutput(result, projectRoot, operation)
  }

  const resolveGitRoot = async (
    cwd: string,
    signal: AbortSignal,
    sandboxPolicy: ShellSandboxPolicy,
  ): Promise<string | undefined> => {
    let result: ShellRunResult
    try {
      result = await ctx.shell.run(ctx.shell.resolve({
        command: 'git rev-parse --show-toplevel',
        workdir: cwd,
        timeoutMs,
        signal,
        stdoutMaxBytes: MAX_SHELL_OUTPUT_BYTES,
        sandboxPolicy,
      }))
    } catch (error) {
      throw operationError(cwd, 'git-root', 'shell transport threw', error)
    }
    if (result.timedOut || result.aborted || result.exitCode === null
      || result.stdout.truncated || result.stderr.truncated) {
      return completedOutput(result, cwd, 'git-root').stdout
    }
    if (result.exitCode !== 0) return undefined
    const output = result.stdout.text.trim()
    if (output.length === 0 || output.includes('\n') || output.includes('\r')) {
      throw operationError(cwd, 'git-root', 'returned an invalid repository root')
    }
    try {
      return await realpath(output)
    } catch (error) {
      throw operationError(cwd, 'git-root', 'returned a repository root that cannot be resolved', error)
    }
  }

  const transactionRunner = (sandboxPolicy: ShellSandboxPolicy): RunTransactionHelper => async (
    args,
    projectRoot,
    signal,
  ) => {
    const output = await runShell(projectRoot, 'bootstrap-transaction', {
      command: `python3 ${[transactionHelper, ...args].map(quotePosixShellWord).join(' ')}`,
      workdir: projectRoot,
      timeoutMs,
      signal: signal ?? lifecycle.signal,
      stdoutMaxBytes: MAX_SHELL_OUTPUT_BYTES,
      sandboxPolicy,
    })
    return output.stdout
  }

  const runInitializer = (
    projectRoot: string,
    sandboxPolicy: ShellSandboxPolicy,
    signal?: AbortSignal,
  ): Promise<TrellisInitResult> => trackOperation(
    (async () => {
      const effectiveSignal = signal ?? lifecycle.signal
      const transaction = await preparePendingBootstrapPath(
        transactionRunner(sandboxPolicy),
        await resolveStateDir(),
        projectRoot,
        effectiveSignal,
      )
      const output = await runShell(projectRoot, 'initializer', {
        command: `bash ${quotePosixShellWord(initializerScript)} ${quotePosixShellWord(projectRoot)}`,
        workdir: projectRoot,
        timeoutMs,
        signal: effectiveSignal,
        stdoutMaxBytes: MAX_SHELL_OUTPUT_BYTES,
        env: {
          USER_CODE: userCode,
          TRELLIS_CONTEXT_STATE_DIR: transaction.stateDir,
          TRELLIS_CONTEXT_TRANSACTION_HELPER: transactionHelper,
        },
        sandboxPolicy,
      })
      let result: TrellisInitResult
      try {
        result = parseTrellisInitializerOutput(output.stdout)
      } catch (error) {
        throw operationError(projectRoot, 'initializer', 'returned invalid status output', error)
      }
      if (resolve(result.projectRoot) !== projectRoot) {
        throw operationError(projectRoot, 'initializer', `returned mismatched project root ${result.projectRoot}`)
      }
      return result
    })(),
  )
  const initializer = new TrellisInitializer((projectRoot, signal) => (
    runInitializer(projectRoot, undefined, signal)
  ))

  const clearAfterPersistence = async (
    session: Session,
    transaction: PendingBootstrapTransaction,
    expectedEvent: SessionEvent<'user/message'>,
    signal: AbortSignal,
    sandboxPolicy: ShellSandboxPolicy,
  ): Promise<boolean> => {
    await Promise.resolve()
    if (signal.aborted) return false
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      throw operationError(transaction.path, 'bootstrap-publication', 'persistence barrier failed', error)
    }
    if (signal.aborted) return false
    const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) return false
    let durableEvents: readonly SessionEvent[]
    try {
      durableEvents = (await persistence.readFrom(session.id, expectedEvent.seq, signal)).events
    } catch (error) {
      throw operationError(transaction.path, 'bootstrap-publication', 'cannot inspect durable session log', error)
    }
    if (signal.aborted) return false
    const durableEvent = durableEvents.find(event => event.seq === expectedEvent.seq)
    if (!isDeepStrictEqual(durableEvent, expectedEvent)) {
      throw operationError(
        transaction.path,
        'bootstrap-publication',
        `durable session log does not contain the exact bootstrap event at seq ${String(expectedEvent.seq)}`,
      )
    }
    try {
      await clearPendingBootstrap(transactionRunner(sandboxPolicy), transaction, signal)
    } catch (error) {
      throw operationError(transaction.path, 'bootstrap-publication', 'cannot clear pending transaction', error)
    }
    return true
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== name
      || !event.data.content.some(block => block.type === 'text' && block.text.includes(BOOTSTRAP_CONTEXT_MARKER))) {
      return
    }
    const publication = pendingPublications.get(event.data.id)
    if (publication === undefined) return
    pendingPublications.delete(event.data.id)
    void trackOperation(clearAfterPersistence(
      session,
      publication.transaction,
      event,
      lifecycle.signal,
      publication.sandboxPolicy,
    )).catch((error: unknown) => {
      ctx.logger.warn(`${String(error)}${error instanceof Error && error.cause !== undefined ? `: ${String(error.cause)}` : ''}`)
    })
  })

  const runHook = (
    projectRoot: string,
    operation: 'session-start' | 'workflow-state',
    hookName: 'SessionStart' | 'UserPromptSubmit',
    sessionId: Agent['session']['id'],
    prompt: string | undefined,
    signal: AbortSignal,
    sandboxPolicy: ShellSandboxPolicy,
  ): Promise<string> => trackOperation((async () => {
    const relativeScript = hookName === 'SessionStart'
      ? '.claude/hooks/session-start.py'
      : '.claude/hooks/inject-workflow-state.py'
    const script = resolve(projectRoot, relativeScript)
    let temporaryDirectory: string | undefined
    try {
      const source = await openContainedFile(projectRoot, script)
      let bytes: Buffer
      try {
        bytes = await source.readBytes(signal)
      } finally {
        await source.close()
      }
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-trellis-hook-'))
      await chmod(temporaryDirectory, 0o700)
      const frozenScript = join(temporaryDirectory, relativeScript.slice(relativeScript.lastIndexOf('/') + 1))
      const destination = await open(frozenScript, 'wx', 0o700)
      try {
        await destination.writeFile(bytes)
      } finally {
        await destination.close()
      }
      await chmod(frozenScript, 0o700)

      const input = trellisHookInput(hookName, sessionId, projectRoot, prompt)
      const output = await runShell(projectRoot, operation, {
        command: `python3 ${quotePosixShellWord(frozenScript)}`,
        workdir: projectRoot,
        timeoutMs,
        signal,
        stdoutMaxBytes: MAX_SHELL_OUTPUT_BYTES,
        stdin: JSON.stringify(input),
        env: {
          USER_CODE: userCode,
          CLAUDE_PROJECT_DIR: projectRoot,
          TRELLIS_CONTEXT_ID: sessionId,
        },
        sandboxPolicy,
      })
      try {
        return parseTrellisHookContext(output.stdout, hookName)
      } catch (error) {
        throw operationError(projectRoot, operation, 'returned invalid hook JSON', error)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('trellis-context ')) throw error
      throw operationError(projectRoot, operation, `cannot freeze or execute ${relativeScript}`, error)
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    }
  })())

  const initializedContext = async (
    projectRoot: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const expectedSkill = resolve(projectRoot, '.claude/skills/trellis-spec-bootstrap/SKILL.md')
    try {
      const [bootstrapSkill, codegraphWorkflow, postBootstrapWorkflow] = await Promise.all([
        readContainedUtf8(projectRoot, expectedSkill, signal),
        readContainedUtf8(resourceDir, codegraphWorkflowPath, signal),
        readContainedUtf8(resourceDir, postBootstrapWorkflowPath, signal),
      ])
      return trellisContextText({
        codegraphWorkflow,
        bootstrapSkill,
        postBootstrapWorkflow,
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('trellis-context ')) throw error
      throw operationError(projectRoot, 'initializer', 'cannot read generated bootstrap resources', error)
    }
  }

  ctx.on('agent/pre-step', ({ agent, signal }, next): Promise<PreStepDecision> => trackOperation((async () => {
      const downstream = await next()
      if (downstream.kind !== 'enter' || downstream.messages.length === 0) return downstream
      const operationSignal = AbortSignal.any([signal, lifecycle.signal])
      operationSignal.throwIfAborted()
      const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      const cwd = agent.session.header.cwd
      if (cwd === undefined) return downstream
      const projectRoot = await resolveGitRoot(cwd, operationSignal, sandboxPolicy)
      if (projectRoot === undefined) return downstream
      let result: TrellisInitResult
      try {
        result = await initializer.ensureWith(
          projectRoot,
          (root, sharedSignal) => runInitializer(root, sandboxPolicy, sharedSignal),
          operationSignal,
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw operationError(projectRoot, 'initializer', 'was aborted while waiting', error)
        }
        throw error
      }
      if (result.kind === 'not-applicable') return downstream
      if (result.kind === 'initialized') {
        const expectedSkill = resolve(result.projectRoot, '.claude/skills/trellis-spec-bootstrap/SKILL.md')
        if (resolve(result.bootstrapSkill) !== expectedSkill) {
          throw operationError(result.projectRoot, 'initializer', `returned unexpected bootstrap Skill ${result.bootstrapSkill}`)
        }
      }

      let transaction: PendingBootstrapTransaction | undefined
      if (result.kind === 'initialized' || result.pendingBootstrap === 'inspect') {
        const transactionPath = await preparePendingBootstrapPath(
          transactionRunner(sandboxPolicy),
          await resolveStateDir(),
          result.projectRoot,
          operationSignal,
        )
        try {
          transaction = await inspectPendingBootstrap(
            transactionRunner(sandboxPolicy),
            transactionPath,
            operationSignal,
          )
        } catch (error) {
          throw operationError(result.projectRoot, 'initializer', 'cannot validate pending bootstrap transaction', error)
        }
        if (result.kind === 'initialized' && transaction === undefined) {
          throw operationError(
            result.projectRoot,
            'initializer',
            `did not create pending bootstrap transaction ${transactionPath.path}`,
          )
        }
      }
      const bootstrapEvent = durableBootstrapContextEvent(agent.session)
      if (transaction !== undefined && bootstrapEvent !== undefined) {
        await clearAfterPersistence(agent.session, transaction, bootstrapEvent, operationSignal, sandboxPolicy)
      }
      const bootstrapPending = transaction !== undefined && bootstrapEvent === undefined

      const firstSessionPrompt = !durableSessionContextExists(agent.session)
      let sessionContext: string | undefined
      if (firstSessionPrompt) {
        const hookContext = await runHook(
          result.projectRoot,
          'session-start',
          'SessionStart',
          agent.session.id,
          undefined,
          operationSignal,
          sandboxPolicy,
        )
        const completed = await completeSessionContextIndexes(
          result.projectRoot,
          hookContext,
          operationSignal,
        )
        sessionContext = completed.context
        if (completed.recovered.length > 0) {
          ctx.logger.info(
            `trellis-context recovered nested spec indexes: session=${agent.id}; count=${String(completed.recovered.length)}; indexes=${JSON.stringify(completed.recovered)}`,
          )
        }
      }
      const workflowState = await runHook(
        result.projectRoot,
        'workflow-state',
        'UserPromptSubmit',
        agent.session.id,
        currentPrompt(downstream.messages),
        operationSignal,
        sandboxPolicy,
      )
      const initialization = bootstrapPending
        ? await initializedContext(result.projectRoot, operationSignal)
        : undefined

      ensureTrellisPolicy(agent, result.projectRoot)

      const contextMessage = createUserMessage({
        content: [{
          type: 'text',
          text: combinedContext(initialization, sessionContext, workflowState),
        }],
        source: { kind: 'plugin', plugin: name },
      })
      if (bootstrapPending && transaction !== undefined) {
        pendingPublications.set(contextMessage.id, { transaction, sandboxPolicy })
      }

      return {
        kind: 'enter',
        messages: [
          ...downstream.messages,
          contextMessage,
        ],
      }
    })()))
}
