import assert from 'node:assert/strict'
import { GatewayDataEmitter } from '@byclaw/by-framework'
import { emitByClawProjection, reasoningProjection } from '../lib/byclaw-presentation.js'

let emitted
const redis = {
  pipeline() {
    return {
      xadd(_stream, _id, _field, value) {
        emitted = JSON.parse(value)
        return this
      },
      expire() {
        return this
      },
      async exec() {
        return []
      },
    }
  },
}

const emitter = new GatewayDataEmitter(redis)
const projection = reasoningProjection('child output', {
  sessionId: 'dsh-child-1',
  parentSessionId: 'dsh-root-1',
  rootSessionId: 'dsh-root-1',
  externalParentSessionId: '20028155',
  scope: 'child',
  depth: 1,
  sequence: 7,
  eventKind: 'think',
  status: 'running',
  childName: '架构舵手',
  parentMessageId: 'root-message',
})

await emitByClawProjection(emitter, '20028155', 'trace-1', projection, 'BYCLAW_DSH')

assert.equal(emitted.metadata.session_scope, 'child')
assert.equal(emitted.metadata.external_session_id, 'dsh-child-1')
assert.equal(emitted.metadata.external_root_session_id, 'dsh-root-1')
assert.equal(emitted.metadata.host_session_id, '20028155')
assert.equal(emitted.data.choices[0].delta.content, 'child output')

console.log('emitter metadata verification passed')
