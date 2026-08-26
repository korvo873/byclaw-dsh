/** POSIX helper protocol for pending-bootstrap transaction storage. @module @byclaw/dsh-trellis-context/transaction */

import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

/**
 * Executes the bundled descriptor-relative helper through the plugin shell capability.
 *
 * @param args - Helper operation and validated operands.
 * @param projectRoot - Canonical project root used as the shell working directory.
 * @param signal - Admission or lifecycle cancellation signal.
 * @returns Complete helper standard output after a successful process exit.
 */
export type RunTransactionHelper = (
  args: readonly string[],
  projectRoot: string,
  signal?: AbortSignal,
) => Promise<string>

/** Validated private state directory and project-keyed transaction pathname. */
export interface PendingBootstrapPath {
  /** Normalized absolute owner-only state directory. */
  readonly stateDir: string
  /** Stable diagnostic pathname; filesystem operations use only the helper's retained descriptors. */
  readonly path: string
  /** Canonical project root bound to the transaction name and record. */
  readonly projectRoot: string
  /** State-directory identity returned by the descriptor-relative helper. */
  readonly stateDirIdentity: FileIdentity
}

/** One validated JSON transaction record bound to its descriptor and content identities. */
export interface PendingBootstrapTransaction extends PendingBootstrapPath {
  /** Marker identity used by helper cleanup to reject replacement. */
  readonly markerIdentity: FileIdentity
  /** SHA-256 of the exact versioned JSON record bytes inspected before publication. */
  readonly recordDigest: string
}

interface HelperResult extends Record<string, unknown> {
  status: string
}

function parseResult(stdout: string): HelperResult {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error('transaction helper output is not one JSON document', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('transaction helper output must be a JSON object')
  }
  const result = value as Record<string, unknown>
  if (typeof result['status'] !== 'string') throw new Error('transaction helper output has no status')
  return result as HelperResult
}

function requiredString(result: HelperResult, field: string): string {
  const value = result[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`transaction helper output has no ${field}`)
  }
  return value
}

function identity(result: HelperResult, prefix: 'state' | 'marker'): FileIdentity {
  const dev = requiredString(result, `${prefix}Dev`)
  const ino = requiredString(result, `${prefix}Ino`)
  if (!/^\d+$/u.test(dev) || !/^\d+$/u.test(ino)) {
    throw new Error(`transaction helper output has malformed ${prefix} identity`)
  }
  return { dev, ino }
}

function expectedTransactionPath(stateDir: string, projectRoot: string): string {
  const digest = createHash('sha256').update(projectRoot).digest('hex')
  return join(stateDir, `${digest}.pending`)
}

function pathResult(result: HelperResult, stateDir: string, projectRoot: string): PendingBootstrapPath {
  const returnedStateDir = requiredString(result, 'stateDir')
  const returnedPath = requiredString(result, 'transactionPath')
  const expectedPath = expectedTransactionPath(stateDir, projectRoot)
  if (returnedStateDir !== stateDir || returnedPath !== expectedPath) {
    throw new Error(`transaction helper returned mismatched path ${returnedPath}`)
  }
  return {
    stateDir,
    path: returnedPath,
    projectRoot,
    stateDirIdentity: identity(result, 'state'),
  }
}

/**
 * Create and validate the private state directory through the bundled helper.
 * @param run - Helper execution through the configured shell provider.
 * @param configuredStateDir - Validated absolute plugin-owned state root.
 * @param canonicalProjectRoot - Canonical repository root used as the stable filename key.
 * @param signal - Admission/lifecycle cancellation signal.
 * @returns The helper-validated path and retained directory identity token.
 */
export async function preparePendingBootstrapPath(
  run: RunTransactionHelper,
  configuredStateDir: string,
  canonicalProjectRoot: string,
  signal?: AbortSignal,
): Promise<PendingBootstrapPath> {
  if (!isAbsolute(configuredStateDir)) throw new TypeError(`stateDir must be absolute: ${configuredStateDir}`)
  const stateDir = resolve(configuredStateDir)
  const result = parseResult(await run(['prepare', stateDir, canonicalProjectRoot], canonicalProjectRoot, signal))
  if (result.status !== 'prepared') throw new Error(`transaction helper prepare returned ${result.status}`)
  return pathResult(result, stateDir, canonicalProjectRoot)
}

/**
 * Inspect and validate a versioned project-bound record through the bundled helper.
 * A stale project-instance record is quarantined by the helper and reported as absent.
 * @param run - Helper execution through the configured shell provider.
 * @param path - Prepared project transaction path.
 * @param signal - Admission/lifecycle cancellation signal.
 * @returns The exact validated record identity, or `undefined` when absent or stale.
 */
export async function inspectPendingBootstrap(
  run: RunTransactionHelper,
  path: PendingBootstrapPath,
  signal?: AbortSignal,
): Promise<PendingBootstrapTransaction | undefined> {
  const result = parseResult(await run(
    ['inspect', path.stateDir, path.projectRoot],
    path.projectRoot,
    signal,
  ))
  if (result.status === 'absent' || result.status === 'mismatch') return undefined
  if (result.status !== 'present') throw new Error(`transaction helper inspect returned ${result.status}`)
  const inspectedPath = pathResult(result, path.stateDir, path.projectRoot)
  if (inspectedPath.stateDirIdentity.dev !== path.stateDirIdentity.dev
    || inspectedPath.stateDirIdentity.ino !== path.stateDirIdentity.ino) {
    throw new Error(`stateDir was replaced: ${path.stateDir}`)
  }
  const recordDigest = requiredString(result, 'recordDigest')
  if (!/^[0-9a-f]{64}$/u.test(recordDigest)) {
    throw new Error('transaction helper output has malformed record digest')
  }
  return {
    ...inspectedPath,
    markerIdentity: identity(result, 'marker'),
    recordDigest,
  }
}

/**
 * Quarantine and remove exactly the inspected record through descriptor-relative helper operations.
 * @param run - Helper execution through the configured shell provider.
 * @param transaction - Directory, marker, project, and record identities captured before publication.
 * @param signal - Admission/lifecycle cancellation signal.
 */
export async function clearPendingBootstrap(
  run: RunTransactionHelper,
  transaction: PendingBootstrapTransaction,
  signal?: AbortSignal,
): Promise<void> {
  const result = parseResult(await run([
    'clear',
    transaction.stateDir,
    transaction.projectRoot,
    transaction.stateDirIdentity.dev,
    transaction.stateDirIdentity.ino,
    transaction.markerIdentity.dev,
    transaction.markerIdentity.ino,
    transaction.recordDigest,
  ], transaction.projectRoot, signal))
  if (result.status !== 'cleared' && result.status !== 'absent' && result.status !== 'mismatch') {
    throw new Error(`transaction helper clear returned ${result.status}`)
  }
}
