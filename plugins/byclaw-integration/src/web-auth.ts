/** Fixed public launch-token adapter over DSH's browser-session authentication. */

import { timingSafeEqual } from 'node:crypto'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

export const BYCLAW_DSH_WEB_AUTH_TOKEN_ENV = 'BYCLAW_DSH_WEB_AUTH_TOKEN' as const

export type ByClawWebAuthConnection = Pick<
  HostConnectionHandle,
  'authenticatedUrl' | 'authorizeIndex'
>

interface ActiveAdapter {
  generation: symbol
  publicToken: string
  internalToken: string
}

interface ConnectionDispatcher {
  originalAuthenticatedUrl: ByClawWebAuthConnection['authenticatedUrl']
  originalAuthorizeIndex: ByClawWebAuthConnection['authorizeIndex']
  authenticatedUrl: ByClawWebAuthConnection['authenticatedUrl']
  authorizeIndex: ByClawWebAuthConnection['authorizeIndex']
  active?: ActiveAdapter
}

const dispatchers = new WeakMap<ByClawWebAuthConnection, ConnectionDispatcher>()

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes)
}

/**
 * Present one deployment token while retaining DSH's random internal token,
 * signed-cookie exchange, request trust checks, and API/WebSocket auth.
 */
export function overrideByClawWebAuthToken(
  connection: ByClawWebAuthConnection,
  configuredToken: string,
): () => void {
  const publicToken = configuredToken.trim()
  if (publicToken === '') throw new Error(`${BYCLAW_DSH_WEB_AUTH_TOKEN_ENV} must be non-empty`)

  let dispatcher = dispatchers.get(connection)
  if (dispatcher === undefined) {
    const originalAuthenticatedUrl = connection.authenticatedUrl
    const originalAuthorizeIndex = connection.authorizeIndex
    dispatcher = {
      originalAuthenticatedUrl,
      originalAuthorizeIndex,
      authenticatedUrl(baseUrl: string): string {
        const url = new URL(originalAuthenticatedUrl.call(connection, baseUrl))
        const active = dispatcher?.active
        if (active !== undefined) url.searchParams.set('token', active.publicToken)
        return url.href
      },
      authorizeIndex(request, response): boolean {
        const active = dispatcher?.active
        if (active === undefined) return originalAuthorizeIndex.call(connection, request, response)
        const url = new URL(request.url ?? '/', 'http://dsh.invalid')
        const tokens = url.searchParams.getAll('token')
        if (tokens.length !== 1 || !tokenMatches(tokens[0] ?? '', active.publicToken)) {
          return originalAuthorizeIndex.call(connection, request, response)
        }
        url.searchParams.set('token', active.internalToken)
        return originalAuthorizeIndex.call(connection, {
          method: request.method,
          headers: request.headers,
          url: `${url.pathname}${url.search}`,
        }, response)
      },
    }
    dispatchers.set(connection, dispatcher)
    connection.authenticatedUrl = dispatcher.authenticatedUrl
    connection.authorizeIndex = dispatcher.authorizeIndex
  }

  const internalUrl = new URL(dispatcher.originalAuthenticatedUrl.call(connection, 'http://127.0.0.1'))
  const internalToken = internalUrl.searchParams.get('token')
  if (internalToken === null || internalToken === '') {
    throw new Error('byclaw-dsh could not resolve the DSH browser launch token')
  }

  const generation = Symbol('byclaw-web-auth-generation')
  dispatcher.active = { generation, publicToken, internalToken }
  return () => {
    if (dispatcher?.active?.generation === generation) dispatcher.active = undefined
  }
}
