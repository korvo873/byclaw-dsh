# @byclaw/dsh-codegraph

English | [中文](README.zh.md)

This private DSH workspace plugin owns the CodeGraph runtime capability. Its bundle mounts `@deepseek-ai/dsh-mcp-client` as `codegraph-mcp` and registers a global CodeGraph system-prompt section inherited by root and delegated Agents.

## Installation

Copy this directory to `<deepseek-harness>/plugins/dsh-codegraph`, then run:

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-codegraph run verify
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-codegraph
dsh --profile web --dump-config
```

The effective tree must contain `codegraph-mcp` and `dsh-codegraph`. The default MCP command is `codegraph serve --mcp`; set `CODEGRAPH_COMMAND` when the executable is not on `PATH`, or override the complete `codegraph-mcp.config` in the profile patch.

The policy requires every CodeGraph call to pass the Agent's authoritative current-runtime cwd as `projectPath`. The MCP process cwd is not a project selection mechanism. If the MCP process cannot start or synchronize tools, plugin loading fails rather than leaving a misleading prompt without tools.

## Verification

```sh
pnpm --filter @byclaw/dsh-codegraph run verify
```

An end-to-end capability prompt should contain only the business request. Inspect DSH session events afterward to confirm the Agent selected `mcp__codegraph__codegraph_*` tools autonomously.
