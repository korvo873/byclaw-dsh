import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { codeGraphPolicy } from '../lib/index.js'

const policy = codeGraphPolicy()
assert.match(policy, /^## CodeGraph/mu)
assert.match(policy, /current runtime context/u)
assert.match(policy, /projectPath/u)
assert.match(policy, /mcp__codegraph__codegraph_context/u)
assert.match(policy, /mcp__codegraph__codegraph_trace/u)
assert.doesNotMatch(policy, /ByClaw session/u)

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(patch, /id: codegraph-mcp/u)
assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/u)
assert.match(patch, /command: !!js process\.env\.CODEGRAPH_COMMAND \|\| 'codegraph'/u)
assert.match(patch, /args: \['serve', '--mcp'\]/u)
assert.match(patch, /id: dsh-codegraph/u)
assert.match(patch, /name: '@byclaw\/dsh-codegraph'/u)

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: expression => ({ expression }),
})
const parsedPatch = yaml.load(patch, { schema: yaml.JSON_SCHEMA.extend(JsExpr) })
const mcpEntry = parsedPatch[0].insert.find(entry => entry.id === 'codegraph-mcp')
const cwdExpression = mcpEntry.config.cwd.expression
const evaluateCwd = (env, fallbackCwd) => Function(
  'process',
  `return (${cwdExpression})`,
)({ env, cwd: () => fallbackCwd })

assert.equal(evaluateCwd({ CODEGRAPH_MCP_CWD: '/' }, '/workspace'), '/')
assert.equal(evaluateCwd({}, '/workspace'), '/workspace')

console.info('ByClaw CodeGraph plugin verification passed')
