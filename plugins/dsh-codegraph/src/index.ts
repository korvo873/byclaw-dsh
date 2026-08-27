/** CodeGraph MCP usage policy for DeepSeek Harness Agents. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'dsh-codegraph'

/** Services required to contribute model guidance. */
export const inject = ['systemPrompt']

const POLICY = `## CodeGraph

This runtime provides CodeGraph through the \`mcp__codegraph__codegraph_*\` tools. CodeGraph is a tree-sitter-parsed graph of project files, symbols, and relationships.

Use the authoritative cwd from the current runtime context as \`projectPath\` on every CodeGraph call. Do not rely on the MCP process directory, and do not substitute another checkout.

Prefer CodeGraph for structural questions:

- Use \`mcp__codegraph__codegraph_context\` first for architecture, onboarding, or focused project context.
- Use one \`mcp__codegraph__codegraph_explore\` call to inspect several related symbols surfaced by context.
- Use \`mcp__codegraph__codegraph_trace\` first for an end-to-end path, then at most one explore call for the returned hops.
- Use \`mcp__codegraph__codegraph_search\` to locate symbols by name.
- Use \`mcp__codegraph__codegraph_callers\` and \`mcp__codegraph__codegraph_callees\` for incoming and outgoing calls.
- Use \`mcp__codegraph__codegraph_impact\` before changing a symbol when its downstream effect matters.
- Use \`mcp__codegraph__codegraph_node\` for one symbol's signature, source, or documentation.
- Use \`mcp__codegraph__codegraph_files\` for structural directory contents and \`mcp__codegraph__codegraph_status\` for index health.

Use native text search for literal strings, comments, and log messages, or after opening a specific file. Do not repeat a successful CodeGraph structural lookup with grep. Allow about one second for the index watcher after writes.

If CodeGraph reports that the selected project is not initialized, ask the user before running \`codegraph init -i\` unless an explicitly authorized initialization workflow owns that operation.`

/** Return the model-visible CodeGraph usage policy. */
export function codeGraphPolicy(): string {
  return POLICY
}

/** Register the global policy inherited by root and delegated Agents. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codegraph:usage-policy',
    order: 117,
    text: POLICY,
  }), 'dsh-codegraph.system-prompt')
}
