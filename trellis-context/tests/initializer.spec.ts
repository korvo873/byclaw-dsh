import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseTrellisInitializerOutput, TrellisInitializer, type TrellisInitResult } from '../src/initializer.ts'

const initialized = (projectRoot: string): TrellisInitResult => ({
  kind: 'initialized',
  projectRoot,
  codegraphIndex: join(projectRoot, '.codegraph'),
  bootstrapSkill: join(projectRoot, '.claude/skills/trellis-spec-bootstrap/SKILL.md'),
})

describe('parseTrellisInitializerOutput', () => {
  it('parses an initialized result with required paths', () => {
    expect(parseTrellisInitializerOutput(
      "status=initialized project_root=/tmp/repo codegraph_index=/tmp/repo/.codegraph bootstrap_skill=/tmp/repo/.claude/skills/trellis-spec-bootstrap/SKILL.md\n",
    )).toEqual({
      kind: 'initialized',
      projectRoot: '/tmp/repo',
      codegraphIndex: '/tmp/repo/.codegraph',
      bootstrapSkill: '/tmp/repo/.claude/skills/trellis-spec-bootstrap/SKILL.md',
    })
  })

  it('rejects output without one recognized status line', () => {
    expect(() => parseTrellisInitializerOutput('noise')).toThrow(/recognized status/)
  })

  it('parses an already initialized result', () => {
    expect(parseTrellisInitializerOutput(
      'status=already_initialized project_root=/tmp/repo pending_bootstrap=inspect\n',
    )).toEqual({
      kind: 'already-initialized',
      projectRoot: '/tmp/repo',
      pendingBootstrap: 'inspect',
    })
  })

  it('parses an existing project without bootstrap transaction support', () => {
    expect(parseTrellisInitializerOutput(
      'status=already_initialized project_root=/tmp/repo pending_bootstrap=none\n',
    )).toEqual({
      kind: 'already-initialized',
      projectRoot: '/tmp/repo',
      pendingBootstrap: 'none',
    })
  })

  it('parses a not applicable result', () => {
    expect(parseTrellisInitializerOutput('status=not_applicable project_root=/tmp/repo reason=no_gitmodules\n')).toEqual({
      kind: 'not-applicable',
      projectRoot: '/tmp/repo',
      reason: 'no_gitmodules',
    })
  })

  it('accepts the non-terminal Git bootstrap status before the terminal result', () => {
    expect(parseTrellisInitializerOutput(
      'status=git_initialized project_root=/tmp/repo remote=https://example.test/repo branch=main\nstatus=initialized project_root=/tmp/repo codegraph_index=/tmp/repo/.codegraph bootstrap_skill=/tmp/repo/.claude/skills/trellis-spec-bootstrap/SKILL.md user=abc\n',
    )).toMatchObject({ kind: 'initialized', projectRoot: '/tmp/repo' })
  })

  it('rejects duplicate terminal statuses', () => {
    expect(() => parseTrellisInitializerOutput(
      'status=already_initialized project_root=/tmp/repo pending_bootstrap=inspect\nstatus=already_initialized project_root=/tmp/repo pending_bootstrap=inspect\n',
    )).toThrow(/duplicate terminal status/)
  })

  it('rejects malformed fields', () => {
    expect(() => parseTrellisInitializerOutput('status=already_initialized project_root=/tmp/repo unexpected')).toThrow(/malformed field/)
  })

  it('requires all initialized paths', () => {
    expect(() => parseTrellisInitializerOutput('status=initialized project_root=/tmp/repo')).toThrow(/codegraph_index/)
  })

  it('decodes Bash printf %q UTF-8 escapes in every returned path field', () => {
    const result = parseTrellisInitializerOutput(String.raw`status=initialized project_root=$'/tmp/\351\241\271\347\233\256\360\237\230\200' codegraph_index=$'/tmp/\351\241\271\347\233\256\360\237\230\200/.codegraph' bootstrap_skill=$'/tmp/\351\241\271\347\233\256\360\237\230\200/.claude/skills/\360\237\230\200/SKILL.md'
`)
    expect(result).toEqual({
      kind: 'initialized',
      projectRoot: '/tmp/项目😀',
      codegraphIndex: '/tmp/项目😀/.codegraph',
      bootstrapSkill: '/tmp/项目😀/.claude/skills/😀/SKILL.md',
    })
  })

  it('decodes Bash ANSI-C hex bytes and Unicode escapes as UTF-8', () => {
    expect(parseTrellisInitializerOutput(String.raw`status=already_initialized project_root=$'unicode-\xE9\xA1\xB9-\u9879-\U0001F600' pending_bootstrap=inspect
`)).toEqual({
      kind: 'already-initialized',
      projectRoot: 'unicode-项-项-😀',
      pendingBootstrap: 'inspect',
    })
  })

  it('preserves literal UTF-8 code points in shell words', () => {
    expect(parseTrellisInitializerOutput(
      'status=already_initialized project_root=/tmp/项目😀 pending_bootstrap=inspect\n',
    )).toEqual({
      kind: 'already-initialized',
      projectRoot: '/tmp/项目😀',
      pendingBootstrap: 'inspect',
    })
  })

  it('rejects malformed UTF-8 from Bash ANSI-C escapes', () => {
    expect(() => parseTrellisInitializerOutput(String.raw`status=already_initialized project_root=$'bad-\377'
`)).toThrow(/invalid UTF-8/)
  })
})

describe('TrellisInitializer', () => {
  it('coalesces concurrent initialization for one canonical root', async () => {
    let release!: (value: string) => void
    const output = new Promise<string>(resolve => { release = resolve })
    const run = vi.fn(async () => parseTrellisInitializerOutput(await output))
    const initializer = new TrellisInitializer(run)
    const first = initializer.ensure('/tmp/repo')
    const second = initializer.ensure('/tmp/repo')
    release('status=already_initialized project_root=/tmp/repo pending_bootstrap=inspect')
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('coalesces lexical aliases and runs with the canonical root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trellis-initializer-lexical-'))
    try {
      let release!: () => void
      const output = new Promise<void>(resolve => { release = resolve })
      const run = vi.fn(async (projectRoot: string) => {
        await output
        return initialized(projectRoot)
      })
      const initializer = new TrellisInitializer(run)
      const first = initializer.ensure(root)
      const second = initializer.ensure(join(root, '.'))
      release()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledWith(await realpath(root), expect.any(AbortSignal))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('coalesces symlink aliases and runs with the physical root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'trellis-initializer-symlink-'))
    const root = join(parent, 'root')
    const alias = join(parent, 'alias')
    await mkdir(root)
    await symlink(root, alias, 'dir')
    try {
      let release!: () => void
      const output = new Promise<void>(resolve => { release = resolve })
      const run = vi.fn(async (projectRoot: string) => {
        await output
        return initialized(projectRoot)
      })
      const initializer = new TrellisInitializer(run)
      const first = initializer.ensure(root)
      const second = initializer.ensure(alias)
      release()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledWith(await realpath(root), expect.any(AbortSignal))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('aborting the first caller does not cancel a later caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trellis-initializer-first-abort-'))
    try {
      let release!: () => void
      const output = new Promise<void>(resolve => { release = resolve })
      let sharedSignal!: AbortSignal
      const run = vi.fn(async (projectRoot: string, signal?: AbortSignal) => {
        sharedSignal = signal as AbortSignal
        await output
        return initialized(projectRoot)
      })
      const initializer = new TrellisInitializer(run)
      const firstController = new AbortController()
      const first = initializer.ensure(root, firstController.signal)
      const second = initializer.ensure(join(root, '.'), new AbortController().signal)
      firstController.abort()
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      expect(sharedSignal.aborted).toBe(false)
      release()
      await expect(second).resolves.toEqual(initialized(await realpath(root)))
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborting a later caller does not cancel the first caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trellis-initializer-later-abort-'))
    try {
      let release!: () => void
      const output = new Promise<void>(resolve => { release = resolve })
      let sharedSignal!: AbortSignal
      const run = vi.fn(async (projectRoot: string, signal?: AbortSignal) => {
        sharedSignal = signal as AbortSignal
        await output
        return initialized(projectRoot)
      })
      const initializer = new TrellisInitializer(run)
      const first = initializer.ensure(root, new AbortController().signal)
      const laterController = new AbortController()
      const later = initializer.ensure(join(root, '.'), laterController.signal)
      laterController.abort()
      await expect(later).rejects.toMatchObject({ name: 'AbortError' })
      expect(sharedSignal.aborted).toBe(false)
      release()
      await expect(first).resolves.toEqual(initialized(await realpath(root)))
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts the shared operation when all callers abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trellis-initializer-all-abort-'))
    try {
      let sharedAbort!: () => void
      const aborted = new Promise<void>(resolve => { sharedAbort = resolve })
      let sharedSignal!: AbortSignal
      const run = vi.fn((_projectRoot: string, signal?: AbortSignal) => {
        sharedSignal = signal as AbortSignal
        return new Promise<TrellisInitResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sharedAbort()
            reject(new Error('shared operation aborted'))
          }, { once: true })
        })
      })
      const initializer = new TrellisInitializer(run)
      const firstController = new AbortController()
      const laterController = new AbortController()
      const first = initializer.ensure(root, firstController.signal)
      const later = initializer.ensure(join(root, '.'), laterController.signal)
      firstController.abort()
      laterController.abort()
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      await expect(later).rejects.toMatchObject({ name: 'AbortError' })
      await expect(aborted).resolves.toBeUndefined()
      expect(sharedSignal.aborted).toBe(true)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an all-aborted operation coalesced until cancellation settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trellis-initializer-cancellation-settlement-'))
    try {
      let rejectShared!: (reason?: unknown) => void
      let sharedSignal!: AbortSignal
      const shared = new Promise<TrellisInitResult>((_resolve, reject) => {
        rejectShared = reject
      })
      const terminalError = new Error('shared operation aborted')
      const run = vi.fn((_projectRoot: string, signal?: AbortSignal) => {
        sharedSignal = signal as AbortSignal
        return shared
      })
      const initializer = new TrellisInitializer(run)
      const firstController = new AbortController()
      const laterController = new AbortController()
      const first = initializer.ensure(root, firstController.signal)
      const later = initializer.ensure(join(root, '.'), laterController.signal)
      firstController.abort()
      laterController.abort()
      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      await expect(later).rejects.toMatchObject({ name: 'AbortError' })
      expect(sharedSignal.aborted).toBe(true)

      const late = initializer.ensure(root)
      expect(run).toHaveBeenCalledTimes(1)

      rejectShared(terminalError)
      await expect(late).rejects.toBe(terminalError)

      const next = initializer.ensure(root)
      await expect(next).rejects.toBe(terminalError)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
