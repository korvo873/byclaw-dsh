# ByClaw DSH plugins

English | [中文](README.zh.md)

This repository maintains the ByClaw plugin suite for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). The plugins integrate through DSH services, events, tools, prompts, and bundle layers without modifying DSH core source.

## Plugin index

| Plugin | Package | Responsibility | Documentation |
| --- | --- | --- | --- |
| AgentTeams | `@byclaw/dsh-agent-teams` | Creates durable multi-agent teams with task DAGs, scheduling, messaging, archives, and a Web activity panel | [中文](./plugins/agent-teams/README.zh.md) · [English](./plugins/agent-teams/README.md) |
| ByClaw Integration | `@byclaw/dsh-integration` | Synchronizes ByClaw digital employees, expert groups, Skills, and models; registers the `BYCLAW_DSH` Worker; maps DSH session events; and injects session context without rewriting user messages | [中文](./plugins/byclaw-integration/README.zh.md) · [English](./plugins/byclaw-integration/README.md) |
| Trellis | `@byclaw/dsh-trellis` | Injects Trellis workflow state, provisions workflow Skills, and exposes task-management tools and UI | [中文](./plugins/dsh-trellis/README.md) · [English](./plugins/dsh-trellis/README_EN.md) |
| Better Sidebar | `@byclaw/dsh-better-sidebar` | Provides the workspace sidebar, editor, terminal, Git, browser, and sidebar extension service | [中文](./plugins/dsh-better-sidebar/README.md) · [English](./plugins/dsh-better-sidebar/README_EN.md) |
| Diff Viewer | `@byclaw/dsh-diff-viewer` | Replaces write/edit diff cards with a scalable unified or split visual diff | [README](./plugins/dsh-diff-viewer/README.md) |
| CodeGraph | `@byclaw/dsh-codegraph` | Composes the CodeGraph MCP server and registers CodeGraph usage policy for root and delegated Agents | [中文](./plugins/dsh-codegraph/README.zh.md) · [English](./plugins/dsh-codegraph/README.md) |

The packages are private DSH workspace packages and are not published to the npm registry. Their `workspace:` dependencies resolve inside a DSH source workspace, so place the plugin directories below `<deepseek-harness>/plugins/` before installing and building them. Trellis, Better Sidebar, and Diff Viewer retain their upstream licenses and exact import provenance in `UPSTREAM.md`; ByClaw owns the maintained package identities and profile composition.

## Architecture and load order

```text
DSH profile
├── @byclaw/dsh-agent-teams
│   ├── agent_teams_* 工具与系统提示词策略
│   ├── 持久团队、成员、任务 DAG、邮箱和调度器
│   └── 可选 Web 活动面板
├── @byclaw/dsh-integration
│   ├── Redis / ByClaw BE 资源与模型同步
│   ├── 数字员工与专家团模板、作用域 Skill
│   ├── BYCLAW_DSH Worker、原样业务消息和会话映射
│   ├── plugin:byclaw-context 会话与工作区注入
│   └── 专家团团长通过 AgentTeams 调度团员
├── @byclaw/dsh-trellis
├── @byclaw/dsh-better-sidebar
├── @byclaw/dsh-diff-viewer
└── @byclaw/dsh-codegraph
    ├── codegraph-mcp：MCP 进程与工具注册
    └── codegraph:usage-policy：根与委派 Agent 继承的系统提示词
```

Install AgentTeams before ByClaw Integration because expert groups depend on it. The other four packages compose independently. ByClaw Integration owns only the durable ByAI session namespace and workspace context; Trellis and CodeGraph own their runtime-capability prompts.

ByClaw Integration keeps each ByAI business instruction as an unchanged `source: user` message. It records the external `session_id` and `cwd` as durable session data, then adds a separate `plugin:byclaw-context` message on each Agent's first admitted step so root and delegated Agents receive the same workspace declaration with correct provenance.

ByClaw inbound messages can target an authorized digital employee or expert group directly with `extra_payload.agent_id`, `agent_code`, or `agent_name`; the live smoke helper exposes the same fields as `--agent-id`, `--agent-code`, and `--agent-name`. When structured metadata is absent, one unambiguous `@resource-name` or `@resource-code` mention in the message body is also accepted and removed before delivery. Invalid, unauthorized, conflicting, or ambiguous targets fail before a child session is created; messages without a target continue through the main Agent route.

## Prerequisites

- A DSH source workspace and an available `dsh` CLI
- Node.js `^22.19.0 || >=24`, pnpm, and a completed `pnpm install` in the DSH workspace
- ByClaw Integration: reachable ByClaw BE and Redis services

## Installation

### 1. Copy the plugins into the DSH workspace

```sh
git clone https://github.com/korvo873/byclaw-dsh.git /path/to/byclaw-dsh
cp -R /path/to/byclaw-dsh/plugins/agent-teams /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/byclaw-integration /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-trellis /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-better-sidebar /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-diff-viewer /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-codegraph /path/to/deepseek-harness/plugins/
```

If a destination already exists, preserve its local changes and merge updates with a Git diff. Do not overwrite a plugin directory that contains uncommitted work.

### 2. Install dependencies and build

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
pnpm --filter @byclaw/dsh-better-sidebar run build
pnpm --filter @byclaw/dsh-diff-viewer run build
pnpm --filter @byclaw/dsh-codegraph run build
```

Rebuild the affected package after changing plugin source.

### 3. Add the packages to a DSH profile

The example uses the `web` profile. Replace it with `headless` for a deployment without the Web UI:

```sh
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-trellis
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-better-sidebar
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-diff-viewer
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-codegraph
dsh --profile web --dump-config
```

`dsh plugin add` links or installs each package into the profile and uses its `dsh.bundle.patch` declaration to append the plugin layer to `dsh.profile.bundles`. If pnpm blocks `node-pty` while installing `dsh-trellis`, set `allowBuilds.node-pty: true` in the profile's `pnpm-workspace.yaml` and repeat the command.

## Environment variables

Copy the example and fill in deployment values:

```sh
cp /path/to/byclaw-dsh/.env.example /path/to/deepseek-harness/.env
```

The DSH launcher reads `.env` from its launch working directory. An already exported process value takes precedence over that file and `$DSH_HOME/.env`. Never commit the completed `.env`.

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `USER_CODE` | Required when Integration is enabled | ByClaw login authorization; explicit plugin `userCode` may supply it instead |
| `REDIS_HOST`, `REDIS_PORT` | Integration with standalone Redis | Redis endpoint; defaults to `localhost:6379` |
| `REDIS_USERNAME`, `REDIS_PASSWORD` | Deployment-dependent | Redis credentials |
| `REDIS_DATABASE` | Optional | Standalone Redis database; defaults to `0` |
| `REDIS_MODE`, `REDIS_CLUSTER_NODES` | Redis Cluster | Cluster mode and a comma-separated `host:port` seed list |
| `REDIS_KEY_SCHEMA_VERSION` | Must be `v2` for Cluster | Selects the Redis key format with hash tags |
| `BYCLAW_REDIS_MODEL_ENABLED` | Optional | Enables Redis dynamic models by default; `false` requires both plugin `provider` and `model` |
| `BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX` | Required for Redis dynamic-model mode | Decrypts ByClaw model authorization and remains process-only |
| `BYCLAW_LLM_IDLE_TIME` | Optional | Dynamic-model idle timeout in seconds; defaults to `600` |

## Profile configuration

Each package's `cordis.patch.yml` inserts its plugin row. A machine-level or profile-level `cordis.patch.yml` can replace the complete `config` for the same `id`; every retained setting must be restated in that replacement.

This example configures the session/team plugins. The capability and Web plugins use their bundle defaults:

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams
    memberProvider: spawn
    memberMaxDepth: 2
    maxMembers: 8
    controlledWorkflow: true
    maxTaskAttempts: 3

- id: byclaw-dsh
  config:
    enabled: true
    userCode: !!js process.env.USER_CODE
    baseUrl: 'http://123.56.153.229:8080'
    stateDir: .agent-teams
    maxConcurrency: 8
    subagentProvider: spawn
    agentPreset: standard

- id: codegraph-mcp
  config:
    serverName: codegraph
    transport: stdio
    command: codegraph
    args: [serve, --mcp]
    cwd: !!js process.cwd()
    env: {}
    toolCallTimeoutMs: 60000
    failOnStartupError: true
```

The expert-group path delegates twice—main agent to leader to member—so `agent-teams.memberMaxDepth` must be at least `2`. When `BYCLAW_REDIS_MODEL_ENABLED=false`, `byclaw-dsh.config` must also provide a local `provider` and `model`.

Each plugin README owns the detailed field semantics, failure conditions, and limitations:

- [AgentTeams configuration and architecture](./plugins/agent-teams/README.zh.md#配置)
- [ByClaw Integration configuration and architecture](./plugins/byclaw-integration/README.zh.md#配置)

## Verification and startup

```sh
cd /path/to/deepseek-harness
pnpm --filter @byclaw/dsh-agent-teams run verify
pnpm --filter @byclaw/dsh-integration run verify
pnpm --filter @byclaw/dsh-trellis run test
pnpm --filter @byclaw/dsh-better-sidebar run build
pnpm --filter @byclaw/dsh-diff-viewer run check
pnpm --filter @byclaw/dsh-codegraph run verify
dsh --profile web --dump-config
dsh web
```

`--dump-config` must show `agent-teams`, `byclaw-dsh`, `better-sidebar`, `trellis-workflow`, `dsh-diff-viewer`, `codegraph-mcp`, and `dsh-codegraph`. Integration subscribes to Redis and completes one blocking resource synchronization before its Worker starts.

## Local state and security

- AgentTeams stores team state in `.agent-teams/` below the session workspace by default.
- Integration stores templates and Skill caches below DSH-home-derived directories by default, and reads authorized resources through Redis and ByClaw BE.
- `.env`, Redis passwords, model decryption keys, generated `lib/`, `node_modules/`, and runtime state do not belong in source control.

## Development

All maintained plugins participate in verification from the DSH root workspace. Run the smallest command covering the affected package after each change. Documentation and package behavior must stay aligned with package metadata, injected-service lists, and bundle patches.
