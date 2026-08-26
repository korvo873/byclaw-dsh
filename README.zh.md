# ByClaw DSH 插件

[English](README.md) | 中文

这个仓库维护 ByClaw 面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的三个 Cordis 插件。插件通过 DSH 的 Service Definition、事件和工具扩展点接入，不修改 DSH 核心源码。

## 插件目录

| 插件 | 包名 | 作用 | 详细文档 |
| --- | --- | --- | --- |
| AgentTeams | `@byclaw/dsh-agent-teams` | 创建持久化多 Agent 团队，提供任务 DAG、调度、消息、归档和 Web 活动面板 | [中文](./plugins/agent-teams/README.zh.md) · [English](./plugins/agent-teams/README.md) |
| ByClaw Integration | `@byclaw/dsh-integration` | 同步 ByClaw 数字员工、专家团、Skill 和模型，注册 `BYCLAW_DSH` Worker，并映射 DSH 会话事件 | [中文](./plugins/byclaw-integration/README.zh.md) · [English](./plugins/byclaw-integration/README.md) |
| Trellis Context | `@byclaw/dsh-trellis-context` | 初始化 Trellis 仓库，并在同一个模型步骤中注入仓库规范、SessionStart 和工作流上下文 | [中文](./plugins/trellis-context/README.zh.md) · [English](./plugins/trellis-context/README.md) |

三个包当前都是 DSH 私有工作区包，不发布到 npm registry。它们的 `workspace:` 依赖需要在 DSH 源码工作区中解析，因此应把插件目录放进 `<deepseek-harness>/plugins/` 后安装和构建。

## 架构与加载关系

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

建议按 `agent-teams`、`byclaw-integration`、`trellis-context` 的顺序安装。ByClaw 专家团依赖 AgentTeams；Trellis Context 独立运行，且默认禁用。

## 前置条件

- DSH 源码工作区和可用的 `dsh` CLI
- Node.js `^22.19.0 || >=24`、pnpm，以及完成过 `pnpm install` 的 DSH 工作区
- ByClaw Integration：可访问的 ByClaw BE 和 Redis
- Trellis Context：Git、`bash`、`python3`，以及与 DSH 进程共享仓库文件系统的 shell provider

## 安装

### 1. 把插件复制到 DSH 工作区

```sh
git clone https://github.com/korvo873/byclaw-dsh.git /path/to/byclaw-dsh
cp -R /path/to/byclaw-dsh/plugins/agent-teams /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/byclaw-integration /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/trellis-context /path/to/deepseek-harness/plugins/
```

目标目录已存在时先保留自己的改动，再按 Git diff 合并更新；不要直接覆盖一个有未提交修改的插件目录。

### 2. 安装依赖并构建

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
pnpm --filter @byclaw/dsh-trellis-context run build
```

修改插件源码后需要重新运行对应包的构建命令。

### 3. 加入 DSH profile

下面以 `web` profile 为例；无 Web UI 的部署可替换为 `headless`：

```sh
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh plugin --profile web add /path/to/deepseek-harness/plugins/trellis-context
dsh --profile web --dump-config
```

`dsh plugin add` 会把包链接进 profile，并根据各包的 `dsh.bundle.patch` 把插件层加入 `dsh.profile.bundles`。`trellis-context` 的包内配置为 `enabled: false`，仅安装不会启动它。

## 环境变量

复制仓库中的示例并填写部署值：

```sh
cp /path/to/byclaw-dsh/.env.example /path/to/deepseek-harness/.env
```

DSH 启动器读取启动工作目录下的 `.env`；已导出的进程变量优先于该文件和 `$DSH_HOME/.env`。不要提交填写后的 `.env`。

| 变量 | 是否必需 | 用途 |
| --- | --- | --- |
| `USER_CODE` | 启用 Integration 或 Trellis 时必需 | ByClaw 登录授权与 Trellis 身份；也可在插件 `userCode` 中显式配置 |
| `REDIS_HOST`、`REDIS_PORT` | Integration 单机 Redis | Redis 地址，默认 `localhost:6379` |
| `REDIS_USERNAME`、`REDIS_PASSWORD` | 按 Redis 部署 | Redis 凭据 |
| `REDIS_DATABASE` | 可选 | 单机 Redis database，默认 `0` |
| `REDIS_MODE`、`REDIS_CLUSTER_NODES` | Redis Cluster | Cluster 模式和逗号分隔的 `host:port` 列表 |
| `REDIS_KEY_SCHEMA_VERSION` | Cluster 必须为 `v2` | 选择带 hash tag 的 Redis key 格式 |
| `BYCLAW_REDIS_MODEL_ENABLED` | 可选 | 默认开启 Redis 动态模型；设为 `false` 时必须在插件中同时配置 `provider` 和 `model` |
| `BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX` | Redis 动态模型模式必需 | 解密 ByClaw 模型鉴权；只保存在进程环境中 |
| `BYCLAW_LLM_IDLE_TIME` | 可选 | 动态模型连接空闲超时秒数，默认 `600` |

## Profile 配置

各包的 `cordis.patch.yml` 负责插入插件行。机器级或 profile 级 `cordis.patch.yml` 可以按相同 `id` 覆盖整段 `config`；覆盖时必须重述该插件需要保留的全部配置。

下面是同时启用三个插件的示例：

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

专家团链路是“主 Agent → 团长 → 团员”两级委派，因此 `agent-teams.memberMaxDepth` 必须至少为 `2`。如果 `BYCLAW_REDIS_MODEL_ENABLED=false`，还要在 `byclaw-dsh.config` 中提供本地 `provider` 和 `model`。

每个字段的语义、失败条件和限制由各插件 README 维护：

- [AgentTeams 配置与架构](./plugins/agent-teams/README.zh.md#配置)
- [ByClaw Integration 配置与架构](./plugins/byclaw-integration/README.zh.md#配置)
- [Trellis Context 配置与架构](./plugins/trellis-context/README.zh.md#配置)

## 验证与启动

```sh
cd /path/to/deepseek-harness
pnpm --filter @byclaw/dsh-agent-teams run verify
pnpm --filter @byclaw/dsh-integration run verify
pnpm --filter @byclaw/dsh-trellis-context run typecheck
pnpm exec vitest run plugins/trellis-context/tests
dsh --profile web --dump-config
dsh web
```

`--dump-config` 应显示 `agent-teams`、`byclaw-dsh` 和 `trellis-context` 三个条目及最终覆盖后的配置。Integration 启动时会先完成 Redis 订阅和一次阻塞式资源同步，再上线 Worker；Trellis 只在 `enabled: true` 且当前提示词获准时执行。

## 本地状态与安全

- AgentTeams 默认把团队状态写入会话工作区的 `.agent-teams/`。
- Integration 默认把模板与 Skill 缓存写入 DSH home 派生目录，并通过 Redis/ByClaw BE 读取授权资源。
- Trellis 默认把事务状态写入 `$DSH_HOME/state/trellis-context`，要求目录链不可被 group/world 写入，并拒绝符号链接。
- `.env`、Redis 密码、模型解密密钥、生成的 `lib/`、`node_modules/` 和运行状态不属于源码仓库。

## 开发

三个插件在 DSH 根工作区中参与类型检查和构建。修改后运行对应插件 README 中列出的最小验证命令；文档和包级行为应与 `src/index.ts` 的 `Config` Schema、`inject` 服务列表和 `cordis.patch.yml` 保持一致。
