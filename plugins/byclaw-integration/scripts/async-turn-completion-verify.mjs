import assert from 'node:assert/strict'
import { waitForAsyncTurnCompletion } from '../lib/session-runtime.js'

const finalIdle = Promise.withResolvers()
const gateCompletion = Promise.withResolvers()
let idleCalls = 0
let settled = false

const agent = {
  whenIdle() {
    idleCalls += 1
    return finalIdle.promise
  },
}
const gate = {
  waiting: true,
  completion: gateCompletion.promise,
  assertHealthy() {},
}

const completion = waitForAsyncTurnCompletion(agent, gate).then(() => {
  settled = true
})

await Promise.resolve()
assert.equal(idleCalls, 0)
assert.equal(settled, false)

gateCompletion.resolve()
await gateCompletion.promise
await Promise.resolve()
assert.equal(idleCalls, 1)
assert.equal(settled, false, 'gate completion must not finish while the final agent turn is still streaming')

finalIdle.resolve()
await completion
assert.equal(settled, true)

console.log('async turn completion verification passed')
