import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeTransactionRaceHook } from './transaction-test-utils.ts'

const SCRIPT = fileURLToPath(new URL('../resources/ensure-trellis-init/scripts/ensure_trellis_init.sh', import.meta.url))
const TRANSACTION_HELPER = fileURLToPath(new URL('../resources/ensure-trellis-init/scripts/transaction_helper.py', import.meta.url))
const roots: string[] = []

interface ScriptOptions {
  env?: NodeJS.ProcessEnv
  testFault?: string
  testHook?: string
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  bin: string
  projectRoot: string
  stateDir: string
  transactionPath: string
}> {
  const createdRoot = await mkdtemp(join(process.cwd(), '.trellis-init-script-'))
  roots.push(createdRoot)
  const root = await realpath(createdRoot)
  const projectRoot = join(root, 'project')
  const stateDir = join(root, 'state')
  const bin = join(root, 'bin')
  await mkdir(projectRoot)
  await mkdir(stateDir, { mode: 0o700 })
  await mkdir(bin)
  await writeFile(join(projectRoot, '.gitmodules'), '[submodule "fixture"]\n')
  await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
  printf '%s\\n' "$FAKE_PROJECT_ROOT"
fi
exit 0
`)
  await writeFile(join(bin, 'codegraph'), `#!/usr/bin/env bash
case "$1" in
  init) mkdir -p "$3/.codegraph" ;;
  status) printf '{"initialized":true,"fileCount":1,"nodeCount":1}\\n' ;;
esac
`)
  await chmod(join(bin, 'git'), 0o700)
  await chmod(join(bin, 'codegraph'), 0o700)
  return {
    root,
    bin,
    projectRoot,
    stateDir,
    transactionPath: join(stateDir, `${createHash('sha256').update(projectRoot).digest('hex')}.pending`),
  }
}

async function runScript(
  projectRoot: string,
  bin: string,
  stateDir: string,
  options: ScriptOptions = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return startScript(projectRoot, bin, stateDir, options).result
}

function startScript(
  projectRoot: string,
  bin: string,
  stateDir: string,
  options: ScriptOptions = {},
): {
    child: ReturnType<typeof spawn>
    result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
  } {
  const args = [SCRIPT, projectRoot]
  if (options.testHook !== undefined) args.push('--test-hook', options.testHook)
  if (options.testFault !== undefined) args.push('--test-fault', options.testFault)
  const child = spawn('bash', args, {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_PROJECT_ROOT: projectRoot,
      USER_CODE: 'fixture-user',
      TRELLIS_CONTEXT_STATE_DIR: stateDir,
      TRELLIS_CONTEXT_TRANSACTION_HELPER: TRANSACTION_HELPER,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const result = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }))
  return { child, result }
}

describe('bundled Trellis initializer transaction', () => {
  it.each([
    'after-partial-write',
    'after-file-fsync',
    'after-install',
    'before-directory-fsync',
  ])('retries publication fault %s before entering any project mutation', async (stage) => {
    const { root, bin, projectRoot, stateDir, transactionPath } = await fixture()
    const mutationLog = join(root, `${stage}.mutations`)
    await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
  printf '%s\\n' "$FAKE_PROJECT_ROOT"
elif [[ "$*" == *"submodule update"* ]]; then
  printf 'git-submodule\\n' >>"$MUTATION_LOG"
fi
exit 0
`)
    await writeFile(join(bin, 'codegraph'), `#!/usr/bin/env bash
case "$1" in
  init) printf 'codegraph\\n' >>"$MUTATION_LOG"; mkdir -p "$3/.codegraph" ;;
  status) printf '{"initialized":true,"fileCount":1,"nodeCount":1}\\n' ;;
esac
`)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
printf 'trellis\\n' >>"$MUTATION_LOG"
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await Promise.all(['git', 'codegraph', 'trellis'].map(name => chmod(join(bin, name), 0o700)))

    const interrupted = await runScript(projectRoot, bin, stateDir, {
      env: { MUTATION_LOG: mutationLog },
      testFault: stage,
    })

    expect(interrupted.code).not.toBe(0)
    await expect(stat(mutationLog)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(transactionPath).then(() => true, () => false))
      .toBe(stage === 'after-install' || stage === 'before-directory-fsync')
    expect((await readdir(stateDir)).some(name => name.startsWith('.publish-')))
      .toBe(stage !== 'before-directory-fsync')

    const retry = await runScript(projectRoot, bin, stateDir, { env: { MUTATION_LOG: mutationLog } })

    expect(retry).toMatchObject({ code: 0, signal: null })
    expect(retry.stdout).toContain('status=initialized')
    expect(await readFile(mutationLog, 'utf8')).toBe('git-submodule\ncodegraph\ntrellis\n')
  })

  it('serializes two real initializer processes and makes the waiter recheck completed state', async () => {
    const { root, bin, projectRoot, stateDir } = await fixture()
    const mutationLog = join(root, 'mutations.log')
    const release = join(root, 'release-first')
    const hook = join(root, 'lock-hook.sh')
    await writeFile(hook, `#!/usr/bin/env bash
case "$1" in
  before-project-lock|after-project-lock) touch "$RACE_ROOT/$PROCESS_ID.$1" ;;
esac
`)
    await chmod(hook, 0o700)
    await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
  printf '%s\\n' "$FAKE_PROJECT_ROOT"
elif [[ "$*" == *"submodule update"* ]]; then
  printf 'git-submodule\\n' >>"$MUTATION_LOG"
fi
exit 0
`)
    await writeFile(join(bin, 'codegraph'), `#!/usr/bin/env bash
case "$1" in
  init) printf 'codegraph\\n' >>"$MUTATION_LOG"; mkdir -p "$3/.codegraph" ;;
  sync) printf 'codegraph\\n' >>"$MUTATION_LOG" ;;
  status) printf '{"initialized":true,"fileCount":1,"nodeCount":1}\\n' ;;
esac
`)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
printf 'trellis\\n' >>"$MUTATION_LOG"
touch "$RACE_ROOT/$PROCESS_ID.trellis-entered"
while [[ ! -e "$RELEASE_FIRST" ]]; do sleep 0.01; done
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await Promise.all(['git', 'codegraph', 'trellis'].map(name => chmod(join(bin, name), 0o700)))
    const commonEnv = { MUTATION_LOG: mutationLog, RACE_ROOT: root, RELEASE_FIRST: release }
    const first = startScript(projectRoot, bin, stateDir, {
      testHook: hook,
      env: { ...commonEnv, PROCESS_ID: 'first' },
    })
    let second: ReturnType<typeof startScript> | undefined
    try {
      await vi.waitFor(async () => {
        if (first.child.exitCode !== null) throw new Error(JSON.stringify(await first.result))
        await expect(stat(join(root, 'first.trellis-entered'))).resolves.toBeDefined()
      }, { timeout: 5000 })
      second = startScript(projectRoot, bin, stateDir, {
        testHook: hook,
        env: { ...commonEnv, PROCESS_ID: 'second' },
      })
      await vi.waitFor(async () => {
        await expect(stat(join(root, 'second.before-project-lock'))).resolves.toBeDefined()
      }, { timeout: 5000 })

      await expect(stat(join(root, 'second.after-project-lock'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(mutationLog, 'utf8')).toBe('git-submodule\ncodegraph\ntrellis\n')
      expect(second.child.exitCode).toBeNull()
    } finally {
      await writeFile(release, 'release\n')
      await Promise.allSettled([first.result, ...(second === undefined ? [] : [second.result])])
    }

    await expect(first.result).resolves.toMatchObject({ code: 0, signal: null })
    await expect(second!.result).resolves.toMatchObject({ code: 0, signal: null })
    expect((await second!.result).stdout).toContain('status=already_initialized')
    expect(await readFile(mutationLog, 'utf8')).toBe('git-submodule\ncodegraph\ntrellis\n')
  })

  it('rechecks a non-Git waiter after the lock owner bootstraps Git and fails', async () => {
    const { root, bin, projectRoot, stateDir } = await fixture()
    const remote = join(root, 'concurrent-environment-remote')
    const hook = join(root, 'concurrent-bootstrap-hook.sh')
    const release = join(root, 'release-bootstrap')
    const trellisCount = join(root, 'concurrent-trellis-count')
    const modules = `[environment]\n\turl = ${remote}\n\tbranch = main\n`
    await rm(join(bin, 'git'))
    await mkdir(remote)
    execFileSync('git', ['init', '-q', '-b', 'main', remote])
    await writeFile(join(remote, '.gitmodules'), modules)
    execFileSync('git', ['-C', remote, 'add', '.gitmodules'])
    execFileSync('git', [
      '-C', remote,
      '-c', 'user.name=Trellis Test',
      '-c', 'user.email=trellis@example.test',
      'commit', '-q', '-m', 'fixture',
    ])
    await writeFile(join(projectRoot, '.gitmodules'), modules)
    await writeFile(hook, `#!/usr/bin/env bash
case "$1" in
  before-project-lock) touch "$RACE_ROOT/$PROCESS_ID.before-project-lock" ;;
  before-git-bootstrap)
    if [[ "$PROCESS_ID" == "first" ]]; then
      touch "$RACE_ROOT/first.bootstrap-ready"
      while [[ ! -e "$RELEASE_BOOTSTRAP" ]]; do sleep 0.01; done
    fi
    ;;
  before-git-submodule)
    if [[ "$PROCESS_ID" == "first" ]]; then exit 91; fi
    ;;
esac
`)
    await chmod(hook, 0o700)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
printf 'trellis\n' >>"$TRELLIS_COUNT"
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await chmod(join(bin, 'trellis'), 0o700)
    const commonEnv = {
      GIT_CEILING_DIRECTORIES: root,
      RACE_ROOT: root,
      RELEASE_BOOTSTRAP: release,
      TRELLIS_COUNT: trellisCount,
    }
    const first = startScript(projectRoot, bin, stateDir, {
      testHook: hook,
      env: { ...commonEnv, PROCESS_ID: 'first' },
    })
    let second: ReturnType<typeof startScript> | undefined
    try {
      await vi.waitFor(async () => {
        if (first.child.exitCode !== null) throw new Error(JSON.stringify(await first.result))
        await expect(stat(join(root, 'first.bootstrap-ready'))).resolves.toBeDefined()
      }, { timeout: 5000 })
      second = startScript(projectRoot, bin, stateDir, {
        testHook: hook,
        env: { ...commonEnv, PROCESS_ID: 'second' },
      })
      await vi.waitFor(async () => {
        await expect(stat(join(root, 'second.before-project-lock'))).resolves.toBeDefined()
      }, { timeout: 5000 })
    } finally {
      await writeFile(release, 'release\n')
      await Promise.allSettled([first.result, ...(second === undefined ? [] : [second.result])])
    }

    expect((await first.result).code).not.toBe(0)
    await expect(second!.result).resolves.toMatchObject({ code: 0, signal: null })
    expect((await second!.result).stdout).toContain('status=initialized')
    expect(execFileSync('git', ['-C', projectRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main')
    expect(await readFile(trellisCount, 'utf8')).toBe('trellis\n')
  })

  it.each([
    { stage: 'after-record-validation', retainedMutation: undefined },
    { stage: 'before-git-bootstrap', retainedMutation: '.git' },
    { stage: 'before-git-submodule', retainedMutation: '.git-submodule-invoked' },
    { stage: 'before-codegraph', retainedMutation: '.codegraph' },
    { stage: 'before-trellis', retainedMutation: '.trellis-invoked' },
  ])('keeps replacement project B untouched after a $stage swap', async ({ stage, retainedMutation }) => {
    const { root, bin, projectRoot, stateDir } = await fixture()
    const displaced = join(root, `project-a-${stage}`)
    const replacement = join(root, `project-b-${stage}`)
    const sentinel = join(root, `${stage}.sentinel`)
    await mkdir(replacement, { mode: 0o700 })
    await writeFile(join(replacement, '.gitmodules'), '[submodule "project-b"]\n', { mode: 0o600 })
    await writeFile(join(replacement, 'project-b-bytes'), 'unchanged\n', { mode: 0o600 })
    if (stage === 'before-git-bootstrap') {
      await writeFile(join(projectRoot, '.gitmodules'), '[environment]\nurl = https://example.test/repo\nbranch = main\n')
      await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
case "$*" in
  *"rev-parse --show-toplevel"*) exit 1 ;;
  *"config -f"*"environment.url"*) printf 'https://example.test/repo\\n' ;;
  *"config -f"*"environment.branch"*) printf 'main\\n' ;;
esac
exit 0
`)
    } else {
      await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --show-toplevel"* ]]; then
  printf '%s\\n' "$FAKE_PROJECT_ROOT"
elif [[ "$*" == *"submodule update"* ]]; then
  touch .git-submodule-invoked
fi
exit 0
`)
    }
    await chmod(join(bin, 'git'), 0o700)
    const hook = await writeTransactionRaceHook(root)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
touch .trellis-invoked
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await chmod(join(bin, 'trellis'), 0o700)

    const result = await runScript(projectRoot, bin, stateDir, {
      testHook: hook,
      env: {
        RACE_STAGE: stage,
        RACE_SUBJECT: projectRoot,
        RACE_SENTINEL: sentinel,
        RACE_ACTION: 'swap-directory',
        RACE_SOURCE: projectRoot,
        RACE_DISPLACED: displaced,
        RACE_OUTSIDE: replacement,
      },
    })

    expect(result.code).not.toBe(0)
    await expect(stat(sentinel)).resolves.toBeDefined()
    expect(await readFile(join(replacement, 'project-b-bytes'), 'utf8')).toBe('unchanged\n')
    expect(await readdir(replacement)).toEqual(['.gitmodules', 'project-b-bytes'])
    if (retainedMutation !== undefined) {
      await expect(stat(join(displaced, retainedMutation))).resolves.toBeDefined()
    }
  })

  it('advances a real non-Git checkout identity and resumes without bootstrapping Git twice', async () => {
    const { root, bin, projectRoot, stateDir, transactionPath } = await fixture()
    const remote = join(root, 'environment-remote')
    const hook = join(root, 'bootstrap-interruption-hook.sh')
    const hookLog = join(root, 'bootstrap-hook.log')
    const interrupted = join(root, 'bootstrap-interrupted')
    const trellisCount = join(root, 'trellis-count')
    const modules = `[environment]\n\turl = ${remote}\n\tbranch = main\n`
    await rm(join(bin, 'git'))
    await mkdir(remote)
    execFileSync('git', ['init', '-q', '-b', 'main', remote])
    await writeFile(join(remote, '.gitmodules'), modules)
    execFileSync('git', ['-C', remote, 'add', '.gitmodules'])
    execFileSync('git', [
      '-C', remote,
      '-c', 'user.name=Trellis Test',
      '-c', 'user.email=trellis@example.test',
      'commit', '-q', '-m', 'fixture',
    ])
    await writeFile(join(projectRoot, '.gitmodules'), modules)
    const bootstrapModulesIdentity = await stat(join(projectRoot, '.gitmodules'))
    await writeFile(hook, `#!/usr/bin/env bash
printf '%s\\n' "$1" >>"$HOOK_LOG"
if [[ "$1" == "before-git-submodule" && ! -e "$INTERRUPTED" ]]; then
  touch "$INTERRUPTED"
  exit 91
fi
`)
    await chmod(hook, 0o700)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
printf 'trellis\\n' >>"$TRELLIS_COUNT"
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await chmod(join(bin, 'trellis'), 0o700)
    const options = {
      testHook: hook,
      env: {
        GIT_CEILING_DIRECTORIES: root,
        HOOK_LOG: hookLog,
        INTERRUPTED: interrupted,
        TRELLIS_COUNT: trellisCount,
      },
    }

    const first = await runScript(projectRoot, bin, stateDir, options)

    expect(first.code).not.toBe(0)
    expect(execFileSync('git', ['-C', projectRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main')
    expect(await readFile(join(projectRoot, '.gitmodules'), 'utf8')).toBe(modules)
    const advanced = JSON.parse(await readFile(transactionPath, 'utf8')) as {
      gitmodules: { inode: string; sha256: string }
    }
    expect(advanced.gitmodules.sha256).toBe(createHash('sha256').update(modules).digest('hex'))
    expect(advanced.gitmodules.inode).toBe(String((await stat(join(projectRoot, '.gitmodules'))).ino))
    expect(advanced.gitmodules.inode).not.toBe(String(bootstrapModulesIdentity.ino))

    const retry = await runScript(projectRoot, bin, stateDir, options)

    expect(retry).toMatchObject({ code: 0, signal: null })
    expect(retry.stdout).toContain('status=initialized')
    expect((await readFile(hookLog, 'utf8')).split('\n').filter(stage => stage === 'before-git-bootstrap')).toHaveLength(1)
    expect(await readFile(trellisCount, 'utf8')).toBe('trellis\n')
    const inspected = spawn('python3', [TRANSACTION_HELPER, 'inspect', stateDir, projectRoot])
    const inspectedStdout: Buffer[] = []
    inspected.stdout.on('data', chunk => inspectedStdout.push(Buffer.from(chunk)))
    const [inspectCode] = await once(inspected, 'exit') as [number | null]
    expect(inspectCode).toBe(0)
    expect(JSON.parse(Buffer.concat(inspectedStdout).toString('utf8'))).toMatchObject({ status: 'present' })
  })

  it('advances non-Git identity only from the exact record validated before checkout', async () => {
    const { root, bin, projectRoot, stateDir, transactionPath } = await fixture()
    const remote = join(root, 'identity-remote')
    const hook = join(root, 'replace-validated-record.py')
    const sentinel = join(root, 'record-replaced')
    const trellisCount = join(root, 'trellis-count')
    const modules = `[environment]\n\turl = ${remote}\n\tbranch = main\n`
    await rm(join(bin, 'git'))
    await mkdir(remote)
    execFileSync('git', ['init', '-q', '-b', 'main', remote])
    await writeFile(join(remote, '.gitmodules'), modules)
    execFileSync('git', ['-C', remote, 'add', '.gitmodules'])
    execFileSync('git', [
      '-C', remote,
      '-c', 'user.name=Trellis Test',
      '-c', 'user.email=trellis@example.test',
      'commit', '-q', '-m', 'fixture',
    ])
    await writeFile(join(projectRoot, '.gitmodules'), modules)
    await writeFile(hook, `#!/usr/bin/env python3
import json
import os
import sys

if sys.argv[1] != "before-git-bootstrap":
    raise SystemExit(0)
with open(os.environ["TRANSACTION_PATH"], "r+", encoding="utf-8") as handle:
    value = json.load(handle)
    value["gitmodules"]["sha256"] = "0" * 64
    handle.seek(0)
    json.dump(value, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\\n")
    handle.truncate()
    handle.flush()
    os.fsync(handle.fileno())
descriptor = os.open(os.environ["RACE_SENTINEL"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(descriptor)
`)
    await chmod(hook, 0o700)
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
printf 'trellis\n' >>"$TRELLIS_COUNT"
mkdir -p .trellis .claude/skills/trellis-spec-bootstrap
printf '# completed bootstrap\n' >.claude/skills/trellis-spec-bootstrap/SKILL.md
`)
    await chmod(join(bin, 'trellis'), 0o700)

    const result = await runScript(projectRoot, bin, stateDir, {
      testHook: hook,
      env: {
        GIT_CEILING_DIRECTORIES: root,
        RACE_SENTINEL: sentinel,
        TRANSACTION_PATH: transactionPath,
        TRELLIS_COUNT: trellisCount,
      },
    })

    await expect(stat(sentinel)).resolves.toBeDefined()
    expect(execFileSync('git', ['-C', projectRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('record content changed before identity advance')
    await expect(stat(trellisCount)).rejects.toMatchObject({ code: 'ENOENT' })
    const retained = JSON.parse(await readFile(transactionPath, 'utf8')) as { gitmodules: { sha256: string } }
    expect(retained.gitmodules.sha256).toBe('0'.repeat(64))
  })

  it('persists the private transaction before trellis init mutates the repository', async () => {
    const { bin, projectRoot, stateDir, transactionPath } = await fixture()
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
python3 "$TRELLIS_CONTEXT_TRANSACTION_HELPER" locked-inspect \
  "$TRELLIS_CONTEXT_STATE_DIR" "$FAKE_PROJECT_ROOT" \
  "$TRELLIS_CONTEXT_LOCKED_STATE_FD" "$TRELLIS_CONTEXT_LOCKED_ROOT_FD" \
  "$TRELLIS_CONTEXT_LOCKED_LOCK_FD" | grep -q '"status":"present"' || exit 42
attempt_file="$FAKE_PROJECT_ROOT/.trellis-attempt"
if [[ ! -e "$attempt_file" ]]; then
  touch "$attempt_file"
  mkdir -p "$FAKE_PROJECT_ROOT/.trellis"
  kill -TERM "$PPID"
  exit 143
fi
mkdir -p "$FAKE_PROJECT_ROOT/.claude/skills/trellis-spec-bootstrap"
printf '# completed bootstrap\n' >"$FAKE_PROJECT_ROOT/.claude/skills/trellis-spec-bootstrap/SKILL.md"
`)
    await chmod(join(bin, 'trellis'), 0o700)

    const interrupted = await runScript(projectRoot, bin, stateDir)

    expect(interrupted.code).not.toBe(0)
    expect((await stat(transactionPath)).mode & 0o777).toBe(0o600)
    await expect(access(join(projectRoot, '.trellis'), constants.F_OK)).resolves.toBeUndefined()

    const retry = await runScript(projectRoot, bin, stateDir)
    expect(retry).toMatchObject({ code: 0, signal: null })
    expect(retry.stdout).toContain('status=initialized')
    await expect(access(
      join(projectRoot, '.claude/skills/trellis-spec-bootstrap/SKILL.md'),
      constants.F_OK,
    )).resolves.toBeUndefined()
    await expect(stat(transactionPath)).resolves.toBeDefined()
  })

  it('does not create a transaction for an unrelated pre-existing Trellis project', async () => {
    const { bin, projectRoot, stateDir, transactionPath } = await fixture()
    await mkdir(join(projectRoot, '.trellis'))

    const result = await runScript(projectRoot, bin, stateDir)

    expect(result).toMatchObject({ code: 0, signal: null })
    expect(result.stdout).toContain('status=already_initialized')
    await expect(stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a pre-existing Trellis project without submodules', async () => {
    const { bin, projectRoot, stateDir, transactionPath } = await fixture()
    await rm(join(projectRoot, '.gitmodules'))
    await mkdir(join(projectRoot, '.trellis'))

    const result = await runScript(projectRoot, bin, stateDir)

    expect(result).toMatchObject({ code: 0, signal: null })
    expect(result.stdout).toContain('status=already_initialized')
    await expect(stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines project A state without mutating same-path pre-existing project B', async () => {
    const { bin, projectRoot, stateDir, transactionPath } = await fixture()
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
mkdir -p "$FAKE_PROJECT_ROOT/.trellis"
touch "$FAKE_PROJECT_ROOT/.project-a-mutated"
kill -TERM "$PPID"
exit 143
`)
    await chmod(join(bin, 'trellis'), 0o700)

    const interrupted = await runScript(projectRoot, bin, stateDir)
    expect(interrupted.code).not.toBe(0)
    await expect(stat(transactionPath)).resolves.toBeDefined()

    await rename(projectRoot, `${projectRoot}-a`)
    await mkdir(projectRoot, { mode: 0o700 })
    await writeFile(join(projectRoot, '.gitmodules'), '[submodule "project-b"]\n', { mode: 0o600 })
    await mkdir(join(projectRoot, '.trellis'), { mode: 0o700 })
    await writeFile(join(projectRoot, '.trellis/project-b'), 'project-b-bytes\n', { mode: 0o600 })
    await writeFile(join(bin, 'trellis'), `#!/usr/bin/env bash
touch "$FAKE_PROJECT_ROOT/.project-b-trellis-invoked"
exit 99
`)
    await chmod(join(bin, 'trellis'), 0o700)

    const replacement = await runScript(projectRoot, bin, stateDir)

    expect(replacement).toMatchObject({ code: 0, signal: null })
    expect(replacement.stdout).toContain('status=already_initialized')
    expect(await readFile(join(projectRoot, '.trellis/project-b'), 'utf8')).toBe('project-b-bytes\n')
    await expect(stat(join(projectRoot, '.project-b-trellis-invoked'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(transactionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(stateDir)).some(name => name.startsWith('.stale-'))).toBe(true)
  })

  it('refuses a final transaction symlink without truncating its target', async () => {
    const { bin, projectRoot, stateDir, transactionPath } = await fixture()
    const outside = join(dirname(transactionPath), 'outside')
    await writeFile(outside, 'outside-bytes\n')
    await symlink(outside, transactionPath)
    await writeFile(join(bin, 'trellis'), '#!/usr/bin/env bash\nexit 0\n')
    await chmod(join(bin, 'trellis'), 0o700)

    const result = await runScript(projectRoot, bin, stateDir)

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('cannot create or validate pending transaction')
    expect(await readFile(outside, 'utf8')).toBe('outside-bytes\n')
  })
})
