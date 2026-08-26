/** Safe ByClaw Hub Skill download cache, adapted from baiying-enhance. */

import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { ByClawSkillRef } from './types.ts'

const execFileAsync = promisify(execFile)
const METADATA_FILE = '.byclaw-hub-skill.json'

export interface ByClawSkillMetadata {
  code: string
  version: string
  downloadUrl: string
  versionUrl: string
}

export interface CachedByClawSkill {
  metadata: ByClawSkillMetadata
  skillFile: string
}

/** Reject absolute and parent-traversing ZIP entries before extraction. */
export function validateByClawSkillZipEntryName(name: string): void {
  const normalized = name.replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)
    || normalized.split('/').some(part => part === '..')) {
    throw new Error(`unsafe ByClaw Skill ZIP entry path: ${name}`)
  }
}

/** Read a complete local cache generation. */
export async function readCachedByClawSkill(targetDir: string): Promise<CachedByClawSkill | undefined> {
  try {
    const metadata = JSON.parse(await readFile(join(targetDir, METADATA_FILE), 'utf8')) as ByClawSkillMetadata
    if (typeof metadata.code !== 'string' || typeof metadata.version !== 'string') return undefined
    const skillFile = join(targetDir, 'SKILL.md')
    await readFile(skillFile, 'utf8')
    return { metadata, skillFile }
  } catch {
    return undefined
  }
}

/** Atomically publish one already-validated extracted Skill directory. */
export async function writeCachedByClawSkill(options: {
  sourceDir: string
  targetDir: string
  metadata: ByClawSkillMetadata
}): Promise<void> {
  await mkdir(dirname(options.targetDir), { recursive: true })
  const suffix = `${process.pid}-${Date.now()}`
  const swap = `${options.targetDir}.tmp-${suffix}`
  const backup = `${options.targetDir}.bak-${suffix}`
  await cp(options.sourceDir, swap, { recursive: true, force: true })
  await writeFile(join(swap, METADATA_FILE), `${JSON.stringify(options.metadata, null, 2)}\n`, { mode: 0o600 })
  let hadExisting = false
  try {
    await rename(options.targetDir, backup)
    hadExisting = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(swap, options.targetDir)
  } catch (error: unknown) {
    if (hadExisting) await rename(backup, options.targetDir).catch(() => undefined)
    await rm(swap, { recursive: true, force: true })
    throw error
  }
  if (hadExisting) await rm(backup, { recursive: true, force: true })
}

function absoluteUrl(baseUrl: string, value: string): string {
  const base = baseUrl.replace(/\/+$/u, '')
  if (/^https?:\/\//iu.test(value)) return value
  if (value.startsWith('/')) return new URL(value, new URL(base).origin).toString()
  return new URL(value, `${base}/`).toString()
}

/** Resolve a Skill endpoint and reject origins outside the configured ByClaw service. */
export function byClawSkillUrl(baseUrl: string, value: string): string {
  const url = new URL(absoluteUrl(baseUrl, value))
  const configured = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`ByClaw Skill URL must use HTTP(S): ${value}`)
  if (url.origin !== configured.origin) throw new Error(`ByClaw Skill URL origin is not configured: ${url.origin}`)
  return url.toString()
}

/** Resolve one untrusted Skill identifier beneath the owned cache root. */
export function byClawSkillCacheDir(cacheRoot: string, code: string): string {
  const windowsStem = code.split('.')[0] ?? ''
  if (code === '' || code === '.' || code === '..'
    || code.includes('/') || code.includes('\\')
    || /[<>:"|?*\u0000-\u001f]/u.test(code)
    || /%2e|%2f|%5c/iu.test(code)
    || /[. ]$/u.test(code)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(windowsStem)) {
    throw new Error(`unsafe ByClaw Skill code: ${code}`)
  }
  const root = resolve(cacheRoot)
  const target = resolve(root, code)
  const contained = relative(root, target)
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error(`unsafe ByClaw Skill code: ${code}`)
  }
  return target
}

async function responseVersion(response: Response): Promise<{ version: string; downloadUrl?: string }> {
  if (!response.ok) throw new Error(`ByClaw Skill version request failed with HTTP ${response.status}`)
  const root = await response.json() as Record<string, unknown>
  const data = root['data'] as Record<string, unknown> | undefined
  const version = typeof data?.['version'] === 'string' || typeof data?.['version'] === 'number'
    ? String(data['version']).trim()
    : ''
  if (version === '') throw new Error('ByClaw Skill version response omitted data.version')
  const downloadUrl = typeof data?.['skillUrl'] === 'string' ? data['skillUrl'].trim() : ''
  return { version, ...downloadUrl === '' ? {} : { downloadUrl } }
}

async function validateZip(path: string): Promise<void> {
  const { stdout } = await execFileAsync('unzip', ['-Z', '-1', path], { maxBuffer: 20 * 1024 * 1024 })
  for (const entry of stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)) {
    validateByClawSkillZipEntryName(entry)
  }
}

/** Synchronize one Hub Skill by remote version and return its local root. */
export async function syncByClawSkill(options: {
  ref: ByClawSkillRef
  baseUrl: string
  headers: Record<string, string>
  cacheRoot: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const versionUrl = byClawSkillUrl(options.baseUrl, options.ref.versionUrl)
  const version = await responseVersion(await fetchImpl(versionUrl, {
    headers: options.headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }))
  const downloadUrl = byClawSkillUrl(options.baseUrl, version.downloadUrl ?? options.ref.downloadUrl)
  const targetDir = byClawSkillCacheDir(options.cacheRoot, options.ref.code)
  const cached = await readCachedByClawSkill(targetDir)
  if (cached?.metadata.version === version.version && cached.metadata.downloadUrl === downloadUrl) return targetDir

  const scratch = await mkdtemp(join(tmpdir(), 'dsh-byclaw-skill-'))
  try {
    const zipPath = join(scratch, 'skill.zip')
    const extractDir = join(scratch, 'extract')
    await mkdir(extractDir, { recursive: true })
    const response = await fetchImpl(downloadUrl, {
      headers: options.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok || response.body === null) throw new Error(`ByClaw Skill download failed with HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zipPath))
    await validateZip(zipPath)
    await execFileAsync('unzip', ['-q', zipPath, '-d', extractDir], { maxBuffer: 20 * 1024 * 1024 })
    let sourceDir = extractDir
    try {
      await readFile(join(sourceDir, 'SKILL.md'), 'utf8')
    } catch {
      const entries = (await import('node:fs/promises')).readdir(extractDir, { withFileTypes: true })
      const candidates = (await entries).filter(entry => entry.isDirectory() && entry.name !== '__MACOSX')
      const roots: string[] = []
      for (const candidate of candidates) {
        const path = join(extractDir, candidate.name)
        try { await readFile(join(path, 'SKILL.md'), 'utf8'); roots.push(path) } catch { /* not a Skill root */ }
      }
      if (roots.length !== 1) throw new Error('ByClaw Skill ZIP must contain exactly one SKILL.md root')
      sourceDir = roots[0] as string
    }
    await writeCachedByClawSkill({
      sourceDir,
      targetDir,
      metadata: { code: options.ref.code, version: version.version, downloadUrl, versionUrl },
    })
    return targetDir
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
