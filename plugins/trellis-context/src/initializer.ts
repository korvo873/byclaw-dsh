import { realpathSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { resolve } from 'node:path'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_LINE_LENGTH = 16 * 1024
const MAX_FIELDS = 16
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

/** The terminal result reported by the bundled Trellis initializer. */
export type TrellisInitResult =
  | { kind: 'not-applicable'; projectRoot: string; reason: string }
  | { kind: 'already-initialized'; projectRoot: string; pendingBootstrap: 'inspect' | 'none' }
  | { kind: 'initialized'; projectRoot: string; codegraphIndex: string; bootstrapSkill: string }

/** Runs the initializer command for one project root with the shared signal. */
export type RunInitializer = (projectRoot: string, signal?: AbortSignal) => Promise<TrellisInitResult>

function appendUtf8(bytes: number[], text: string): void {
  bytes.push(...Buffer.from(text, 'utf8'))
}

function appendNextCodePoint(bytes: number[], input: string, index: number): number {
  const codePoint = input.codePointAt(index)
  if (codePoint === undefined) return index + 1
  const text = String.fromCodePoint(codePoint)
  appendUtf8(bytes, text)
  return index + text.length
}

function appendCodePoint(bytes: number[], codePoint: number): void {
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw new Error('malformed shell word: invalid Unicode escape')
  }
  appendUtf8(bytes, String.fromCodePoint(codePoint))
}

function parseAnsiCQuotedWord(input: string, start: number): { bytes: number[]; next: number } {
  let index = start + 2
  const bytes: number[] = []
  while (index < input.length) {
    const character = input[index]
    if (character === "'") return { bytes, next: index + 1 }
    if (character !== '\\') {
      index = appendNextCodePoint(bytes, input, index)
      continue
    }

    index += 1
    if (index >= input.length) throw new Error('malformed shell word: unterminated escape')
    const escaped = input[index] ?? ''
    const simpleEscapes: Record<string, string> = {
      a: '\u0007',
      b: '\b',
      e: '\u001b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\u000b',
      '\\': '\\',
      "'": "'",
      '"': '"',
    }
    const simple = simpleEscapes[escaped]
    if (simple !== undefined) {
      appendUtf8(bytes, simple)
      index += 1
      continue
    }
    if (escaped === 'x') {
      const encoded = input.slice(index + 1, index + 3).match(/^[0-9a-f]{1,2}/iu)?.[0]
      if (encoded === undefined) throw new Error('malformed shell word: invalid hex escape')
      bytes.push(Number.parseInt(encoded, 16))
      index += encoded.length + 1
      continue
    }
    if (escaped === 'u' || escaped === 'U') {
      const digits = escaped === 'u' ? 4 : 8
      const encoded = input.slice(index + 1, index + 1 + digits)
      if (encoded.length !== digits || !/^[0-9a-f]+$/iu.test(encoded)) {
        throw new Error('malformed shell word: invalid Unicode escape')
      }
      appendCodePoint(bytes, Number.parseInt(encoded, 16))
      index += digits + 1
      continue
    }
    if (/^[0-7]$/u.test(escaped)) {
      const encoded = input.slice(index, index + 3).match(/^[0-7]{1,3}/u)?.[0]
      if (encoded === undefined) throw new Error('malformed shell word: invalid octal escape')
      bytes.push(Number.parseInt(encoded, 8))
      index += encoded.length
      continue
    }
    appendUtf8(bytes, escaped)
    index += 1
  }
  throw new Error('malformed shell word: unterminated ANSI-C quote')
}

function decodeShellWord(bytes: number[]): string {
  try {
    return utf8Decoder.decode(Uint8Array.from(bytes))
  } catch {
    throw new Error('malformed shell word: invalid UTF-8')
  }
}

function parseShellWords(line: string): string[] {
  const words: string[] = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && /[ \t]/u.test(line[index] ?? '')) index += 1
    if (index >= line.length) break

    const bytes: number[] = []
    let started = false
    while (index < line.length && !/[ \t]/u.test(line[index] ?? '')) {
      const character = line[index]
      if (character === '\\') {
        if (index + 1 >= line.length) throw new Error('malformed shell word: trailing escape')
        appendUtf8(bytes, line[index + 1] ?? '')
        index += 2
        started = true
      } else if (character === "'") {
        started = true
        index += 1
        const end = line.indexOf("'", index)
        if (end === -1) throw new Error('malformed shell word: unterminated single quote')
        appendUtf8(bytes, line.slice(index, end))
        index = end + 1
      } else if (character === '"') {
        started = true
        index += 1
        while (index < line.length && line[index] !== '"') {
          if (line[index] === '\\') {
            if (index + 1 >= line.length) throw new Error('malformed shell word: trailing escape')
            appendUtf8(bytes, line[index + 1] ?? '')
            index += 2
          } else {
            index = appendNextCodePoint(bytes, line, index)
          }
        }
        if (line[index] !== '"') throw new Error('malformed shell word: unterminated double quote')
        index += 1
      } else if (character === '$' && line[index + 1] === "'") {
        started = true
        const parsed = parseAnsiCQuotedWord(line, index)
        bytes.push(...parsed.bytes)
        index = parsed.next
      } else {
        started = true
        index = appendNextCodePoint(bytes, line, index)
      }
    }
    if (!started) throw new Error('malformed shell word: empty field')
    words.push(decodeShellWord(bytes))
    if (words.length > MAX_FIELDS) throw new Error('initializer output has too many fields')
  }
  return words
}

function parseFields(line: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const word of parseShellWords(line)) {
    const separator = word.indexOf('=')
    const key = separator === -1 ? '' : word.slice(0, separator)
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) throw new Error(`malformed field in initializer output: ${word}`)
    if (fields.has(key)) throw new Error(`duplicate field in initializer output: ${key}`)
    fields.set(key, word.slice(separator + 1))
  }
  return fields
}

function requiredField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key)
  if (value === undefined || value.length === 0) throw new Error(`malformed field: ${key} is required`)
  return value
}

function validateFields(fields: Map<string, string>, allowed: readonly string[], required: readonly string[]): void {
  for (const key of fields.keys()) {
    if (!allowed.includes(key)) throw new Error(`malformed field in initializer output: ${key}`)
  }
  for (const key of required) requiredField(fields, key)
}

/** Parse the bounded, shell-escaped status output from the initializer script. */
export function parseTrellisInitializerOutput(stdout: string): TrellisInitResult {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('initializer output exceeds the limit')

  let result: TrellisInitResult | undefined
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length > MAX_LINE_LENGTH) throw new Error('initializer output line exceeds the limit')
    if (line.length === 0 || !line.startsWith('status=')) continue

    const fields = parseFields(line)
    const status = requiredField(fields, 'status')
    if (status === 'git_initialized') {
      validateFields(fields, ['status', 'project_root', 'remote', 'branch'], ['status', 'project_root', 'remote', 'branch'])
      continue
    }

    if (status !== 'not_applicable' && status !== 'already_initialized' && status !== 'initialized') {
      throw new Error(`unrecognized status: ${status}`)
    }
    if (result !== undefined) throw new Error(`duplicate terminal status: ${status}`)

    if (status === 'not_applicable') {
      validateFields(fields, ['status', 'project_root', 'reason'], ['status', 'project_root', 'reason'])
      result = {
        kind: 'not-applicable',
        projectRoot: requiredField(fields, 'project_root'),
        reason: requiredField(fields, 'reason'),
      }
    } else if (status === 'already_initialized') {
      validateFields(fields, ['status', 'project_root', 'pending_bootstrap'], [
        'status',
        'project_root',
        'pending_bootstrap',
      ])
      const pendingBootstrap = requiredField(fields, 'pending_bootstrap')
      if (pendingBootstrap !== 'inspect' && pendingBootstrap !== 'none') {
        throw new Error(`malformed field: pending_bootstrap is ${pendingBootstrap}`)
      }
      result = {
        kind: 'already-initialized',
        projectRoot: requiredField(fields, 'project_root'),
        pendingBootstrap,
      }
    } else {
      validateFields(fields, ['status', 'project_root', 'codegraph_index', 'bootstrap_skill', 'user'], [
        'status',
        'project_root',
        'codegraph_index',
        'bootstrap_skill',
      ])
      result = {
        kind: 'initialized',
        projectRoot: requiredField(fields, 'project_root'),
        codegraphIndex: requiredField(fields, 'codegraph_index'),
        bootstrapSkill: requiredField(fields, 'bootstrap_skill'),
      }
    }
  }

  if (result === undefined) throw new Error('initializer output has no recognized status')
  return result
}

interface InFlightOperation {
  readonly projectRoot: string
  readonly controller: AbortController
  readonly operation: Promise<TrellisInitResult>
  waiters: number
  settled: boolean
}

function abortError(): Error {
  const error = new Error('Trellis initialization was aborted')
  error.name = 'AbortError'
  return error
}

/** Coalesce concurrent initializer runs for the same canonical project root. */
export class TrellisInitializer {
  private readonly inFlight = new Map<string, InFlightOperation>()

  constructor(private readonly run: RunInitializer) {}

  /**
   * Ensure one canonical root is initialized while giving each caller an independent wait.
   * Aborting one caller rejects only that caller. The shared initializer receives its own signal
   * and is aborted only after every current caller has aborted. Once aborted, the operation stays
   * coalesced until it settles, so a caller arriving before settlement receives the same terminal
   * outcome; a new operation starts only after settlement.
   *
   * @param projectRoot - Existing project directory, or a lexical path to one.
   * @param signal - Optional caller-owned cancellation signal.
   * @returns The shared initialization result, unless this caller aborts first.
   */
  ensure(projectRoot: string, signal?: AbortSignal): Promise<TrellisInitResult> {
    return this.ensureWith(projectRoot, this.run, signal)
  }

  /**
   * Ensure one canonical root with a caller-bound runner. The first concurrent caller owns the
   * shared run; later callers join that exact operation until it settles.
   *
   * @param projectRoot - Existing project directory, or a lexical path to one.
   * @param run - Runner whose immutable execution settings belong to this admission.
   * @param signal - Optional caller-owned cancellation signal.
   * @returns The shared initialization result, unless this caller aborts first.
   */
  ensureWith(projectRoot: string, run: RunInitializer, signal?: AbortSignal): Promise<TrellisInitResult> {
    if (signal?.aborted) return Promise.reject(abortError())

    let canonicalRoot: string
    try {
      canonicalRoot = realpathSync(projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Promise.reject(error)
      canonicalRoot = resolve(projectRoot)
    }
    if (signal?.aborted) return Promise.reject(abortError())

    let entry = this.inFlight.get(canonicalRoot)
    if (entry === undefined) {
      const controller = new AbortController()
      let operation: Promise<TrellisInitResult>
      try {
        operation = run(canonicalRoot, controller.signal)
      } catch (error) {
        operation = Promise.reject(error)
      }
      entry = { projectRoot: canonicalRoot, controller, operation, waiters: 0, settled: false }
      this.inFlight.set(canonicalRoot, entry)
      void operation.then(
        () => this.finish(entry!),
        () => this.finish(entry!),
      )
    }
    return this.waitFor(entry, signal)
  }

  private finish(entry: InFlightOperation): void {
    entry.settled = true
    if (this.inFlight.get(entry.projectRoot) === entry) this.inFlight.delete(entry.projectRoot)
  }

  private waitFor(entry: InFlightOperation, signal?: AbortSignal): Promise<TrellisInitResult> {
    entry.waiters += 1
    return new Promise<TrellisInitResult>((resolveResult, rejectResult) => {
      let finished = false
      const abort = (): void => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', abort)
        entry.waiters -= 1
        if (entry.waiters === 0 && !entry.settled) {
          entry.controller.abort()
        }
        rejectResult(abortError())
      }
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      void entry.operation.then(
        result => {
          if (finished) return
          finished = true
          signal?.removeEventListener('abort', abort)
          resolveResult(result)
        },
        error => {
          if (finished) return
          finished = true
          signal?.removeEventListener('abort', abort)
          rejectResult(error)
        },
      )
    })
  }
}
