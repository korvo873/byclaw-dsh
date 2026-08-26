# ByClaw DSH plugins

English | [中文](README.zh.md)

This repository maintains three ByClaw Cordis plugins for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). They integrate through DSH Service Definitions, events, and tool extension points without modifying DSH core source.

## Plugin index

| Plugin | Package | Responsibility | Documentation |
| --- | --- | --- | --- |
| AgentTeams | `@byclaw/dsh-agent-teams` | Creates durable multi-agent teams with task DAGs, scheduling, messaging, archives, and a Web activity panel | [中文](./agent-teams/README.zh.md) · [English](./agent-teams/README.md) |
| ByClaw Integration | `@byclaw/dsh-integration` | Synchronizes ByClaw digital employees, expert groups, Skills, and models; registers the `BYCLAW_DSH` Worker; and maps DSH session events | [中文](./byclaw-integration/README.zh.md) · [English](./byclaw-integration/README.md) |
| Trellis Context | `@byclaw/dsh-trellis-context` | Initializes Trellis repositories and injects repository specifications, SessionStart data, and workflow context into the same model step | [中文](./trellis-context/README.zh.md) · [English](./trellis-context/README.md) |

All three packages are private DSH workspace packages and are not published to the npm registry. Their `workspace:` dependencies must resolve inside a DSH source workspace, so place the plugin directories below `<deepseek-harness>/plugins/` before installing and building them.

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
│   ├── BYCLAW_DSH Worker 和会话映射
│   └── 专家团团长通过 AgentTeams 调度团员
└── @byclaw/dsh-trellis-context（可选）
    ├── Git / Trellis 仓库识别与幂等初始化
    └── 同步骤 bootstrap、规范索引和 workflow state 注入
```

Install the packages in this order: `agent-teams`, `byclaw-integration`, then `trellis-context`. ByClaw expert groups depend on AgentTeams. Trellis Context runs independently and is disabled by default.

## Prerequisites

- A DSH source workspace and an available `dsh` CLI
- Node.js `^22.19.0 || >=24`, pnpm, and a completed `pnpm install` in the DSH workspace
- ByClaw Integration: reachable ByClaw BE and Redis services
- Trellis Context: Git, `bash`, `python3`, and a shell provider that shares the repository filesystem with the DSH process

## Installation

### 1. Copy the plugins into the DSH workspace

```sh
git clone https://github.com/korvo873/byclaw-dsh.git /path/to/byclaw-dsh
cp -R /path/to/byclaw-dsh/agent-teams /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/byclaw-integration /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/trellis-context /path/to/deepseek-harness/plugins/
```

If a destination already exists, preserve its local changes and merge updates with a Git diff. Do not overwrite a plugin directory that contains uncommitted work.

### 2. Install dependencies and build

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
pnpm --filter @byclaw/dsh-trellis-context run build
```

Rebuild the affected package after changing plugin source.

### 3. Add the packages to a DSH profile

The example uses the `web` profile. Replace it with `headless` for a deployment without the Web UI:

```sh
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh plugin --profile web add /path/to/deepseek-harness/plugins/trellis-context
dsh --profile web --dump-config
```

`dsh plugin add` links each package into the profile and uses its `dsh.bundle.patch` declaration to append the plugin layer to `dsh.profile.bundles`. The bundled `trellis-context` row has `enabled: false`, so installation alone does not activate it.

## Environment variables

Copy the example and fill in deployment values:

```sh
cp /path/to/byclaw-dsh/.env.example /path/to/deepseek-harness/.env
```

The DSH launcher reads `.env` from its launch working directory. An already exported process value takes precedence over that file and `$DSH_HOME/.env`. Never commit the completed `.env`.

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `USER_CODE` | Required when Integration or Trellis is enabled | ByClaw login authorization and Trellis identity; explicit plugin `userCode` may supply it instead |
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

This example enables all three plugins:

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

- id: trellis-context
  config:
    enabled: true
    userCode: !!js process.env.USER_CODE
    timeoutMs: 120000
```

The expert-group path delegates twice—main agent to leader to member—so `agent-teams.memberMaxDepth` must be at least `2`. When `BYCLAW_REDIS_MODEL_ENABLED=false`, `byclaw-dsh.config` must also provide a local `provider` and `model`.

Each plugin README owns the detailed field semantics, failure conditions, and limitations:

- [AgentTeams configuration and architecture](./agent-teams/README.zh.md#配置)
- [ByClaw Integration configuration and architecture](./byclaw-integration/README.zh.md#配置)
- [Trellis Context configuration and architecture](./trellis-context/README.zh.md#配置)

## Verification and startup

```sh
cd /path/to/deepseek-harness
pnpm --filter @byclaw/dsh-agent-teams run verify
pnpm --filter @byclaw/dsh-integration run verify
pnpm --filter @byclaw/dsh-trellis-context run typecheck
pnpm exec vitest run plugins/trellis-context/tests
dsh --profile web --dump-config
dsh web
```

`--dump-config` must show the `agent-teams`, `byclaw-dsh`, and `trellis-context` rows with their final replaced configuration. Integration subscribes to Redis and completes one blocking resource synchronization before its Worker starts. Trellis runs only when `enabled: true` and the current prompt is admitted.

## Local state and security

- AgentTeams stores team state in `.agent-teams/` below the session workspace by default.
- Integration stores templates and Skill caches below DSH-home-derived directories by default, and reads authorized resources through Redis and ByClaw BE.
- Trellis stores transaction state in `$DSH_HOME/state/trellis-context` by default, requires a directory chain that is not group/world-writable, and rejects symbolic links.
- `.env`, Redis passwords, model decryption keys, generated `lib/`, `node_modules/`, and runtime state do not belong in source control.

## Development

The three plugins participate in type checking and builds from the DSH root workspace. Run the smallest verification commands listed in the affected plugin README after each change. Documentation and package behavior must stay aligned with the `Config` Schema, injected-service list, and `cordis.patch.yml` in each package.
