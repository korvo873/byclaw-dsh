import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTransactionRaceHook } from './transaction-test-utils.ts'

const HELPER = fileURLToPath(new URL('../resources/ensure-trellis-init/scripts/transaction_helper.py', import.meta.url))
const roots: string[] = []

interface HelperResult {
  status: 'prepared' | 'created' | 'present' | 'absent' | 'mismatch' | 'cleared'
  stateDir?: string
  transactionPath?: string
  stateDev?: string
  stateIno?: string
  markerDev?: string
  markerIno?: string
  recordDigest?: string
  quarantineName?: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; projectRoot: string; stateDir: string }> {
  const created = await mkdtemp(join(process.cwd(), '.trellis-transaction-test-'))
  roots.push(created)
  const root = await realpath(created)
  const projectRoot = join(root, 'project')
  const stateDir = join(root, 'private', 'trellis-context')
  await mkdir(projectRoot, { mode: 0o700 })
  await writeFile(join(projectRoot, '.gitmodules'), '[submodule "fixture"]\n', { mode: 0o600 })
  return { root, projectRoot, stateDir }
}

async function runHelper(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string; result?: HelperResult }> {
  const child = spawn('python3', [HELPER, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const [code] = await once(child, 'exit') as [number | null]
  const stdoutText = Buffer.concat(stdout).toString('utf8')
  return {
    code,
    stdout: stdoutText,
    stderr: Buffer.concat(stderr).toString('utf8'),
    ...code === 0 ? { result: JSON.parse(stdoutText) as HelperResult } : {},
  }
}

function clearArgs(projectRoot: string, transaction: HelperResult): string[] {
  return [
    'clear',
    transaction.stateDir!,
    projectRoot,
    transaction.stateDev!,
    transaction.stateIno!,
    transaction.markerDev!,
    transaction.markerIno!,
    transaction.recordDigest!,
  ]
}

describe('descriptor-relative transaction helper', () => {
  it('rejects the filesystem root as a non-owner-only state directory', async () => {
    const { projectRoot } = await fixture()

    const prepared = await runHelper(['prepare', '/', projectRoot])

    expect(prepared.code).not.toBe(0)
    expect(prepared.stderr).toContain('stateDir is not an owner-only directory')
  })

  it('stores and inspects an owner-only versioned project-instance record', async () => {
    const { projectRoot, stateDir } = await fixture()

    const prepared = await runHelper(['prepare', stateDir, projectRoot])
    const created = await runHelper(['ensure', stateDir, projectRoot])
    const inspected = await runHelper(['inspect', stateDir, projectRoot])

    expect(prepared).toMatchObject({ code: 0, result: { status: 'prepared', stateDir } })
    expect(created).toMatchObject({ code: 0, result: { status: 'created', stateDir } })
    expect(inspected).toMatchObject({ code: 0, result: { status: 'present', stateDir } })
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
    expect((await stat(created.result!.transactionPath!)).mode & 0o777).toBe(0o600)
    const record = JSON.parse(await readFile(created.result!.transactionPath!, 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({
      version: 1,
      project: { canonicalRoot: projectRoot },
      gitmodules: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    })
  })

  it.each([
    'after-partial-write',
    'after-file-fsync',
    'after-install',
    'before-directory-fsync',
  ])('recovers atomic publication after a crash %s', async (stage) => {
    const { projectRoot, stateDir } = await fixture()
    const prepared = await runHelper(['prepare', stateDir, projectRoot])

    const interrupted = await runHelper(['--test-fault', stage, 'ensure', stateDir, projectRoot])
    const interruptedNames = await readdir(stateDir)
    const finalExists = await stat(prepared.result!.transactionPath!).then(() => true, () => false)

    expect(interrupted.code).toBe(97)
    expect(finalExists).toBe(stage === 'after-install' || stage === 'before-directory-fsync')
    expect(interruptedNames.some(name => name.startsWith('.publish-')))
      .toBe(stage !== 'before-directory-fsync')

    const retry = await runHelper(['ensure', stateDir, projectRoot])
    const inspected = await runHelper(['inspect', stateDir, projectRoot])

    expect(retry).toMatchObject({
      code: 0,
      result: { status: expect.stringMatching(/^(created|present)$/u) },
    })
    expect(inspected).toMatchObject({ code: 0, result: { status: 'present' } })
    const recordBytes = await readFile(retry.result!.transactionPath!, 'utf8')
    expect(JSON.parse(recordBytes)).toMatchObject({
      version: 1,
      project: { canonicalRoot: projectRoot },
    })
    expect((await readdir(stateDir)).filter(name => name.startsWith('.publish-'))).toEqual([])
  })

  it('quarantines helper-owned incomplete final-name residue before retry publication', async () => {
    const { projectRoot, stateDir } = await fixture()
    const prepared = await runHelper(['prepare', stateDir, projectRoot])
    await writeFile(prepared.result!.transactionPath!, '{"version":', { mode: 0o600 })

    const retry = await runHelper(['ensure', stateDir, projectRoot])

    expect(retry).toMatchObject({ code: 0, result: { status: 'created' } })
    expect(JSON.parse(await readFile(retry.result!.transactionPath!, 'utf8'))).toMatchObject({
      version: 1,
      project: { canonicalRoot: projectRoot },
    })
    expect((await readdir(stateDir)).some(name => name.startsWith('.incomplete-'))).toBe(true)
  })

  it('rejects a complete unsupported record instead of treating it as crash residue', async () => {
    const { projectRoot, stateDir } = await fixture()
    const created = await runHelper(['ensure', stateDir, projectRoot])
    const transactionPath = created.result!.transactionPath!
    const unsupported = JSON.parse(await readFile(transactionPath, 'utf8')) as Record<string, unknown>
    unsupported['version'] = 2
    const unsupportedBytes = `${JSON.stringify(unsupported)}\n`
    await writeFile(transactionPath, unsupportedBytes, { mode: 0o600 })

    const retry = await runHelper(['ensure', stateDir, projectRoot])

    expect(retry.code).not.toBe(0)
    expect(retry.stderr).toContain('unsupported version')
    expect(await readFile(transactionPath, 'utf8')).toBe(unsupportedBytes)
    expect((await readdir(stateDir)).some(name => name.startsWith('.incomplete-'))).toBe(false)
  })

  it('ignores the ambient transaction race-hook variable', async () => {
    const { root, projectRoot, stateDir } = await fixture()
    const hook = join(root, 'ambient-hook.sh')
    const sentinel = join(root, 'ambient-hook.sentinel')
    await writeFile(hook, `#!/usr/bin/env bash\ntouch "$RACE_SENTINEL"\n`)
    await chmod(hook, 0o700)

    const result = await runHelper(['ensure', stateDir, projectRoot], {
      TRELLIS_CONTEXT_TRANSACTION_RACE_HOOK: hook,
      RACE_SENTINEL: sentinel,
    })

    expect(result).toMatchObject({ code: 0, result: { status: 'created' } })
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines a stale same-path record without changing the replacement project', async () => {
    const { root, projectRoot, stateDir } = await fixture()
    const created = await runHelper(['ensure', stateDir, projectRoot])
    expect(created.code).toBe(0)
    await rename(projectRoot, join(root, 'project-a'))
    await mkdir(projectRoot, { mode: 0o700 })
    await writeFile(join(projectRoot, '.gitmodules'), '[submodule "replacement"]\n', { mode: 0o600 })
    await mkdir(join(projectRoot, '.trellis'), { mode: 0o700 })
    await writeFile(join(projectRoot, '.trellis/owned-by-b'), 'project-b-bytes\n', { mode: 0o600 })

    const inspected = await runHelper(['inspect', stateDir, projectRoot])

    expect(inspected).toMatchObject({ code: 0, result: { status: 'mismatch' } })
    expect(await readFile(join(projectRoot, '.trellis/owned-by-b'), 'utf8')).toBe('project-b-bytes\n')
    await expect(stat(created.result!.transactionPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(stateDir)).some(name => name.startsWith('.stale-'))).toBe(true)
  })

  it.each(['after-component-open', 'after-component-check'])(
    'does not create outside state after %s replacement',
    async (stage) => {
      const { root, projectRoot } = await fixture()
      const swappable = join(root, 'swappable')
      const stateDir = join(swappable, 'trellis-context')
      const displaced = join(root, 'swappable-original')
      const outside = join(root, 'outside')
      const sentinel = join(root, `${stage}.sentinel`)
      await mkdir(swappable, { mode: 0o700 })
      await mkdir(outside, { mode: 0o700 })
      await writeFile(join(outside, 'outside-bytes'), 'unchanged\n', { mode: 0o600 })
      const hook = await writeTransactionRaceHook(root)

      const result = await runHelper(['--test-hook', hook, 'prepare', stateDir, projectRoot], {
        RACE_STAGE: stage,
        RACE_SUBJECT: swappable,
        RACE_SENTINEL: sentinel,
        RACE_ACTION: 'swap-directory',
        RACE_SOURCE: swappable,
        RACE_DISPLACED: displaced,
        RACE_OUTSIDE: outside,
      })

      expect(result.code).not.toBe(0)
      await expect(stat(sentinel)).resolves.toBeDefined()
      expect(await readFile(join(outside, 'outside-bytes'), 'utf8')).toBe('unchanged\n')
      expect(await readdir(outside)).toEqual(['outside-bytes'])
    },
  )

  it('does not read or change an outside target after marker-open replacement', async () => {
    const { root, projectRoot, stateDir } = await fixture()
    const created = await runHelper(['ensure', stateDir, projectRoot])
    const transactionPath = created.result!.transactionPath!
    const outside = join(root, 'outside-marker')
    await writeFile(outside, 'outside-bytes\n', { mode: 0o600 })
    const hook = await writeTransactionRaceHook(root)

    const result = await runHelper(['--test-hook', hook, 'inspect', stateDir, projectRoot], {
      RACE_STAGE: 'after-marker-open',
      RACE_SUBJECT: transactionPath,
      RACE_SENTINEL: join(root, 'marker-open.sentinel'),
      RACE_ACTION: 'swap-marker',
      RACE_SOURCE: transactionPath,
      RACE_DISPLACED: `${transactionPath}.original`,
      RACE_OUTSIDE: outside,
    })

    expect(result.code).not.toBe(0)
    expect(await readFile(outside, 'utf8')).toBe('outside-bytes\n')
  })

  it.each([
    ['after-quarantine', false],
    ['after-final-revalidation', true],
  ] as const)('unlinks no outside name after %s replacement', async (stage, clears) => {
    const { root, projectRoot, stateDir } = await fixture()
    await runHelper(['ensure', stateDir, projectRoot])
    const transaction = (await runHelper(['inspect', stateDir, projectRoot])).result!
    const displaced = join(root, 'state-original')
    const outside = join(root, 'outside-state')
    await mkdir(outside, { mode: 0o700 })
    const outsideMarker = join(outside, basename(transaction.transactionPath!))
    await writeFile(outsideMarker, 'outside-marker\n', { mode: 0o600 })
    const beforeNames = await readdir(outside)
    const hook = await writeTransactionRaceHook(root)

    const result = await runHelper(['--test-hook', hook, ...clearArgs(projectRoot, transaction)], {
      RACE_STAGE: stage,
      RACE_SUBJECT: stateDir,
      RACE_SENTINEL: join(root, `${stage}.sentinel`),
      RACE_ACTION: 'swap-directory',
      RACE_SOURCE: stateDir,
      RACE_DISPLACED: displaced,
      RACE_OUTSIDE: outside,
    })

    expect(result.code === 0).toBe(clears)
    expect(await readdir(outside)).toEqual(beforeNames)
    expect(await readFile(outsideMarker, 'utf8')).toBe('outside-marker\n')
    if (!clears) {
      await expect(stat(join(displaced, basename(transaction.transactionPath!)))).resolves.toBeDefined()
    }
  })
})
