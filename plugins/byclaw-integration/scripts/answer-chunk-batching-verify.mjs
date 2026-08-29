import assert from 'node:assert/strict'
import { AnswerChunkBatcher } from '../lib/session-runtime.js'

const batcher = new AnswerChunkBatcher(8)

assert.equal(batcher.append('root:1:1', '你'), undefined)
assert.equal(batcher.append('root:1:1', '好'), undefined)
assert.equal(batcher.append('root:1:1', '，这是'), undefined)
assert.equal(batcher.append('root:1:1', '批量输出'), '你好，这是批量输出')
assert.equal(batcher.flush('root:1:1'), undefined)

assert.equal(batcher.append('root:1:2', '剩余'), undefined)
assert.equal(batcher.flush('root:1:2'), '剩余')

assert.equal(batcher.append('child:1:1', '独立'), undefined)
assert.equal(batcher.append('root:1:3', '根会话'), undefined)
assert.deepEqual([...batcher.keys()].sort(), ['child:1:1', 'root:1:3'])
assert.equal(batcher.flush('child:1:1'), '独立')
assert.equal(batcher.flush('root:1:3'), '根会话')
assert.deepEqual([...batcher.keys()], [])

console.log('answer chunk batching verification passed')
