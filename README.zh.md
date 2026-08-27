# ByClaw DSH 插件

[English](README.md) | 中文

这个仓库维护 ByClaw 面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的插件套件。插件通过 DSH 服务、事件、工具、系统提示词和 bundle 层接入，不修改 DSH 核心源码。

## 插件目录

| 插件 | 包名 | 作用 | 详细文档 |
| --- | --- | --- | --- |
| AgentTeams | `@byclaw/dsh-agent-teams` | 创建持久化多 Agent 团队，提供任务 DAG、调度、消息、归档和 Web 活动面板 | [中文](./plugins/agent-teams/README.zh.md) · [English](./plugins/agent-teams/README.md) |
| ByClaw Integration | `@byclaw/dsh-integration` | 同步 ByClaw 数字员工、专家团、Skill 和模型，注册 `BYCLAW_DSH` Worker，映射 DSH 会话事件，并在不改写用户消息的前提下注入会话上下文 | [中文](./plugins/byclaw-integration/README.zh.md) · [English](./plugins/byclaw-integration/README.md) |
| Trellis | `@byclaw/dsh-trellis` | 注入 Trellis 工作流状态、补齐工作流 Skills，并提供任务工具和 UI | [中文](./plugins/dsh-trellis/README.md) · [English](./plugins/dsh-trellis/README_EN.md) |
| Better Sidebar | `@byclaw/dsh-better-sidebar` | 提供工作区侧边栏、编辑器、终端、Git、浏览器及侧边栏扩展服务 | [中文](./plugins/dsh-better-sidebar/README.md) · [English](./plugins/dsh-better-sidebar/README_EN.md) |
| Diff Viewer | `@byclaw/dsh-diff-viewer` | 为 write/edit 工具提供可扩展的单栏或双栏可视化 diff | [README](./plugins/dsh-diff-viewer/README.md) |
| CodeGraph | `@byclaw/dsh-codegraph` | 装配 CodeGraph MCP，并向根 Agent 与委派 Agent 注册使用策略 | [中文](./plugins/dsh-codegraph/README.zh.md) · [English](./plugins/dsh-codegraph/README.md) |

这些包都是 DSH 私有工作区包，不发布到 npm registry。它们的 `workspace:` 依赖需要在 DSH 源码工作区中解析，因此应把插件目录放进 `<deepseek-harness>/plugins/` 后安装和构建。Trellis、Better Sidebar 与 Diff Viewer 保留上游许可证，并在各自 `UPSTREAM.md` 中锁定导入版本和提交；ByClaw 负责维护包身份及 profile 组合。

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

AgentTeams 应先于 ByClaw Integration 安装，因为专家团依赖它；其余四个插件可独立组合。ByClaw Integration 只负责持久化 ByAI 会话命名空间和工作区上下文，Trellis 与 CodeGraph 各自负责运行能力提示。

ByClaw Integration 把每条 ByAI 业务指令保持为未经改写的 `source: user` 消息。插件将外部 `session_id` 和 `cwd` 记录为持久会话数据，再在每个 Agent 的第一次获准步骤中追加独立的 `plugin:byclaw-context` 消息，使根 Agent 与委派 Agent 都能以正确来源获得同一工作区声明。

ByClaw 入站消息可以通过 `extra_payload.agent_id`、`agent_code` 或 `agent_name` 直接指定当前授权的数字员工或专家团；live smoke 脚本对应提供 `--agent-id`、`--agent-code` 和 `--agent-name`。没有结构化目标时，正文中的唯一且无歧义的 `@资源名称` 或 `@资源编码` 也可作为目标，匹配文本会在投递前移除。目标不存在、未授权、字段冲突或正文歧义时，会在创建子会话前失败；未指定目标的消息继续走主 Agent 原有路径。

## 前置条件

- DSH 源码工作区和可用的 `dsh` CLI
- Node.js `^22.19.0 || >=24`、pnpm，以及完成过 `pnpm install` 的 DSH 工作区
- ByClaw Integration：可访问的 ByClaw BE 和 Redis

## 安装

### 1. 把插件复制到 DSH 工作区

```sh
git clone https://github.com/korvo873/byclaw-dsh.git /path/to/byclaw-dsh
cp -R /path/to/byclaw-dsh/plugins/agent-teams /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/byclaw-integration /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-trellis /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-better-sidebar /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-diff-viewer /path/to/deepseek-harness/plugins/
cp -R /path/to/byclaw-dsh/plugins/dsh-codegraph /path/to/deepseek-harness/plugins/
```

目标目录已存在时先保留自己的改动，再按 Git diff 合并更新；不要直接覆盖一个有未提交修改的插件目录。

### 2. 安装依赖并构建

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
pnpm --filter @byclaw/dsh-better-sidebar run build
pnpm --filter @byclaw/dsh-diff-viewer run build
pnpm --filter @byclaw/dsh-codegraph run build
```

修改插件源码后需要重新运行对应包的构建命令。

### 3. 加入 DSH profile

下面以 `web` profile 为例；无 Web UI 的部署可替换为 `headless`：

```sh
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-trellis
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-better-sidebar
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-diff-viewer
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-codegraph
dsh --profile web --dump-config
```

`dsh plugin add` 会把包链接或安装进 profile，并根据各包的 `dsh.bundle.patch` 把插件层加入 `dsh.profile.bundles`。如果安装 `dsh-trellis` 时 pnpm 阻止 `node-pty`，请在该 profile 的 `pnpm-workspace.yaml` 中设置 `allowBuilds.node-pty: true` 后重新执行命令。

## 环境变量

复制仓库中的示例并填写部署值：

```sh
cp /path/to/byclaw-dsh/.env.example /path/to/deepseek-harness/.env
```

DSH 启动器读取启动工作目录下的 `.env`；已导出的进程变量优先于该文件和 `$DSH_HOME/.env`。不要提交填写后的 `.env`。

| 变量 | 是否必需 | 用途 |
| --- | --- | --- |
| `USER_CODE` | 启用 Integration 时必需 | ByClaw 登录授权；也可在插件 `userCode` 中显式配置 |
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

下面配置会话与团队插件；能力与 Web 插件使用各自 bundle 默认组合：

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

专家团链路是“主 Agent → 团长 → 团员”两级委派，因此 `agent-teams.memberMaxDepth` 必须至少为 `2`。如果 `BYCLAW_REDIS_MODEL_ENABLED=false`，还要在 `byclaw-dsh.config` 中提供本地 `provider` 和 `model`。

每个字段的语义、失败条件和限制由各插件 README 维护：

- [AgentTeams 配置与架构](./plugins/agent-teams/README.zh.md#配置)
- [ByClaw Integration 配置与架构](./plugins/byclaw-integration/README.zh.md#配置)

## 验证与启动

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

`--dump-config` 应显示 `agent-teams`、`byclaw-dsh`、`better-sidebar`、`trellis-workflow`、`dsh-diff-viewer`、`codegraph-mcp` 和 `dsh-codegraph`。Integration 启动时会先完成 Redis 订阅和一次阻塞式资源同步，再上线 Worker。

## 本地状态与安全

- AgentTeams 默认把团队状态写入会话工作区的 `.agent-teams/`。
- Integration 默认把模板与 Skill 缓存写入 DSH home 派生目录，并通过 Redis/ByClaw BE 读取授权资源。
- `.env`、Redis 密码、模型解密密钥、生成的 `lib/`、`node_modules/` 和运行状态不属于源码仓库。

## 开发

所有维护插件都从 DSH 根工作区执行验证。修改后运行覆盖对应包的最小命令；文档和包级行为应与包元数据、服务注入列表和 bundle patch 保持一致。
