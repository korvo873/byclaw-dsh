/** Fixed public launch-token adapter verification. */

import assert from 'node:assert/strict'
import { overrideByClawWebAuthToken } from '../src/web-auth.ts'

const calls = []
const connection = {
  authenticatedUrl(baseUrl) {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.searchParams.set('token', 'internal-random-token')
    return url.href
  },
  authorizeIndex(request, response) {
    calls.push(request.url)
    response.status = request.url === '/?token=internal-random-token' ? 303 : 401
    return false
  },
}
const originalAuthenticatedUrl = connection.authenticatedUrl
const originalAuthorizeIndex = connection.authorizeIndex

const dispose = overrideByClawWebAuthToken(connection, 'ztesoft')
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080'), 'http://127.0.0.1:3080/?token=ztesoft')

const accepted = {}
assert.equal(connection.authorizeIndex({
  method: 'GET',
  url: '/?token=ztesoft',
  headers: { host: '127.0.0.1:3080' },
}, accepted), false)
assert.equal(accepted.status, 303)
assert.equal(calls.at(-1), '/?token=internal-random-token')

const rejected = {}
connection.authorizeIndex({
  method: 'GET',
  url: '/?token=wrong',
  headers: { host: '127.0.0.1:3080' },
}, rejected)
assert.equal(rejected.status, 401)
assert.equal(calls.at(-1), '/?token=wrong')

const duplicate = {}
connection.authorizeIndex({
  method: 'GET',
  url: '/?token=ztesoft&token=ztesoft',
  headers: { host: '127.0.0.1:3080' },
}, duplicate)
assert.equal(duplicate.status, 401)

dispose()
assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080'), 'http://127.0.0.1:3080/?token=internal-random-token')

const stackedAuthorize = connection.authorizeIndex
connection.authorizeIndex = function wrappedAuthorize(request, response) {
  return stackedAuthorize.call(this, request, response)
}
const reload = overrideByClawWebAuthToken(connection, 'rotated-token')
const rotated = {}
connection.authorizeIndex({ method: 'GET', url: '/?token=rotated-token', headers: {} }, rotated)
assert.equal(rotated.status, 303)
reload()
const afterUnload = {}
connection.authorizeIndex({ method: 'GET', url: '/?token=rotated-token', headers: {} }, afterUnload)
assert.equal(afterUnload.status, 401)

assert.notEqual(connection.authenticatedUrl, originalAuthenticatedUrl)
assert.notEqual(connection.authorizeIndex, originalAuthorizeIndex)

assert.throws(() => overrideByClawWebAuthToken(connection, ''), /non-empty/u)
console.log('ByClaw Web auth-token adapter checks passed')
