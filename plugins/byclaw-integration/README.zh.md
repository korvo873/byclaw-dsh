# @byclaw/dsh-integration

[English](README.md) | 中文

`@byclaw/dsh-integration` 是 DeepSeek Harness（DSH）接入 ByClaw 的独立插件。它不修改 DSH 或 ByClaw 源码，通过 DSH 插件扩展点、`@byclaw/by-framework` 和独立的 AgentTeams 插件完成资源同步、模型装配、消息入站及多 Agent 调度。

## 安装到 DSH

该包是从 DSH 源码检出目录构建的私有工作区包，不发布到 npm registry。把本目录放在 `plugins/byclaw-integration`，先安装 AgentTeams，再构建两个本地包并加入目标 profile：

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh --profile web --dump-config
```

把仓库根目录的 [`.env.example`](../../.env.example) 复制到 DSH 启动目录，填写部署值，并确保生成的 `.env` 不被 Git 跟踪。包内 patch 会启用该插件；`USER_CODE`、Redis、ByClaw BE 或所选模型路由无效时，插件启动失败。

## 运行结构

插件注册 `BYCLAW_DSH` Worker，并把 ByClaw 授权资源投影为两类可复用模板：

- 数字员工：`byclaw-employee-<resourceId>`，调用时实例化一个普通 DSH 子 Agent，不创建团队。
- 专家团：`byclaw-group-<resourceId>`，调用时先实例化专家团自己的团长 Agent；团长再通过 `byclaw-team-<resourceId>` 创建本次任务的 AgentTeams 运行团队。

主 Agent 只负责发现资源和选择模板，不代替专家团团长。临时团队完成任务并汇总后由团长调用 `agent_teams_delete` 解散；DSH 根会话、团长会话和团员会话继续持久化，因此 ByClaw FE 仍可查看完整父子会话。

```text
ByClaw 入站
  -> BYCLAW_DSH Worker
  -> DSH 主 Agent
       -> 单数字员工模板 -> 普通子 Agent
       -> 专家团模板 -> 团长 Agent -> AgentTeams 团员 Agent
```

主 Agent 派发后通过 DSH 的子 Agent 结算事件暂停和唤醒；专家团团长通过 AgentTeams 成员事件暂停和唤醒。两条链路都不轮询。

## 动态资源与 Skill

插件先订阅 Redis 变更频道，再执行一次阻塞式冷启动同步；只有订阅和冷启动代次都成功后，Worker 才会上线。运行期间在以下时机刷新：

- 调用 `byclaw_list_resources` 或实例化模板前；
- 收到 Redis 频道 `byai:pub:dig_employee_change` 的变更通知时。

Redis 负责登录授权、候选资源 ID 发现、模型配置和变更通知，不作为数字员工或专家团内容的最终来源。每次冷启动或热更新都通过 `digitalEmployeeController/findDetailsById` 读取员工和专家团的当前字段；专家团提示词、模型、有效成员和配置版本来自 `orchestrators/resolve-runtime`。冷启动期间收到的 Redis 信号进入同一串行同步队列，在当前代次完成后继续执行。

每次刷新都会在快照实时目录前取得独占代际协调器，暂存完整一代 Skill、数字员工模板、专家团模板和 AgentTeams 适配器，并持续持有协调器直至发布、回滚和备份清理完成。模板实例化、基于模板的 AgentTeams 创建和模板列表读取使用共享准入，AgentTeams 模板保存使用独占准入。因此，并发调用方只能使用完整的上一代或完整的新一代数据，发布后获准的保存操作会保留无关模板。卸载期间，协调器拒绝新准入，排空已准入操作和刷新任务，关闭 Worker、会话与 Redis 资源，最后移除服务。刷新成功后删除已撤销授权的 ByClaw 自有产物，同时保留无关文件；刷新失败时保留最后一代完整数据。首次启动失败则直接失败，避免 Worker 带着空资源上线。

数字员工 Persona 投影遵循 ByClaw 的指令归一化规则：`relPrompt` 优先于 `corePersonaDefinition`，嵌套 JSON 提示记录保留标题，`ability`、`processingFlow` 和 `coreCompetencies` 分别形成独立章节，并在单数字员工与专家团成员提示词中各渲染一次。专家团团长模板先加入不可被覆盖的 DSH 与 AgentTeams 编排、附件、失败处理和结算规则，再追加经授权的 `resolve-runtime` 业务提示词。刷新还会移除遗留的 `byclaw-group-*` AgentTeams 适配器，同时保留无关模板。

数字员工 Skill 按 `baiying-enhance` 的下载语义同步到 `agentTemplateDir/byclaw-skills`。携带凭据的资源目录和 Skill 请求仅访问所配置 `baseUrl` 的同源地址，并禁止自动跟随重定向。Skill 路径写入员工模板和专家团成员适配器，实例化时只在对应 Agent 的 DSH 标准作用域 Skill 注册表中注册。模型可见目录和 Skill 正文加载由标准 Skill 工具负责；集成插件不注册第二个 `skill` 工具，也不影响主 Agent 或其他成员。

`byclaw_list_resources` 只向主 Agent 返回路由所需的 `id/code/name/description/template_id/invocation`，专家团额外返回精简成员姓名和角色。子 Agent 的 Skill、工具、Persona、模型和执行参数不会进入路由表；调用 `byclaw_instantiate_template` 后，插件再从本地模板为该 Agent 动态加载这些运行资源。

## 动态模型

`BYCLAW_REDIS_MODEL_ENABLED` 为所有经本插件入站或实例化的 Agent 选择运行态模型来源。该变量默认开启；未设置、空值、`true`、`1`、`on` 或 `yes` 都会启用 Redis 模型解析。开启时：

- 主 Agent：每次 ByClaw 入站时读取 Redis 当前唯一默认 LLM。
- 单数字员工：优先使用员工 `prologue.modelId`，未配置时使用默认 LLM。
- 专家团团长：使用专家团运行配置中的模型 ID。
- 专家团团员：使用对应数字员工的模型 ID，未配置时使用默认 LLM；创建团队时冻结本次运行所用 provider/model。

模型目录来自 Redis Hash `byai:aimodel:typelist` 的 `LLM` 字段，模型连接配置来自 `byai:aimodel:config`。每个模型映射为唯一 provider `baiying-m-<instanceId>`，支持 Anthropic Messages、OpenAI Completions 和 OpenAI Responses。加密鉴权在内存中解密，密钥、Token 和请求头不会写入模板、AgentTeams 文件或 DSH 会话事件。

启用 Redis 模型解析时，按“当前配置 -> 最后一次成功绑定 -> 插件配置的 `provider`/`model`”降级；默认项不唯一、模型缺失或配置无效会在最早可判定位置报错，不静默选择任意模型。

`false`、`0`、`off` 或 `no` 会关闭 Redis 模型解析。此时主 Agent、数字员工、专家团团长和专家团团员全部使用本地配置的 `provider`/`model`；资源中的模型 ID 不参与执行，插件也不会读取 Redis AI 模型 Hash 或注册 ByClaw 动态模型路由。关闭 Redis 模型但没有同时配置两个本地字段，或传入其他开关值，都会导致插件启动失败。

## ByClaw 消息映射

- ByAI 入站可通过 `extra_payload.cwd` 指定新建 DSH 根会话的绝对工作目录；未提供时使用插件 `workspace`。插件把外部 `session_id` 与解析后的目录一次性记录为 `byclaw/session-workspace`，用同一会话空间声明包装模型入站内容，并在恢复时拒绝冲突目录。每个可继续子 Agent 都会在尚未发布的创建窗口从在线父会话复制该持久命名空间，保留自己独立的 DSH 会话 ID，并在任务中接收只含 cwd 的 `delegation-workspace` 声明。
- 每条 `AskAgent` 入站会按顺序输出终端可见的生命周期日志：收到命令及其标识；继承的 ByClaw 会话命名空间、DSH ID、实际 `cwd` 和根／委派作用域；当前可见的 CodeGraph 能力数量；新建、恢复或继续会话；不含密钥的模型解析信息（`sourceModelId`、provider、model、protocol 和解析来源）；携带完整指令的任务启动。数字员工或专家团子 Agent 完成组合时，另输出一条日志，只列出该模板自己的 Skill 名称和本地路径。插件不会额外写入登录授权、Redis 密码、模型端点或模型密钥；由于完整指令可能包含敏感内容，运维方必须把这些日志作为对话数据管理。
- DSH 文本块 -> `answerDelta`
- DSH reasoning 块 -> `reasoningLogDelta`
- `ask_user_question` -> `contentType=3014` 的结构化 ByClaw 提问卡片；`ResumeCommand` 回填并唤醒原调用
- `todo_write` 与兼容工具名 `task_plan` -> `todo/write` 会话事件 -> `contentType=2008` 的任务计划卡片；计划事件使用 `<入站消息ID>:plan`，并把入站消息 ID 作为 `parent_message_id`
- 子 Agent 创建、运行、等待、完成或失败 -> 带 DSH 会话 ID、父会话 ID 和委派深度的状态事件
- Worker 终态只发送完成信号，不重复发送已经流式输出的最终正文

## 配置

```yaml
- insert:
    - id: byclaw-dsh
      name: '@byclaw/dsh-integration'
      config:
        enabled: true
        userCode: !!js process.env.USER_CODE
        baseUrl: 'http://123.56.153.229:8080'
```

Redis 连接只读取标准 `REDIS_*` 环境变量。默认 ByClaw BE 地址为 `http://123.56.153.229:8080`，可通过 `baseUrl` 覆盖。Redis 模型模式还需提供用于解密 ByClaw 模型鉴权的 `BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX`。如需运行态只使用本地 DSH 模型路由，请设置 `BYCLAW_REDIS_MODEL_ENABLED=false`，并同时配置 `provider` 和 `model`。DSH 启动器会读取启动工作目录下的 `.env`；已导出的进程环境变量优先于该文件和 `$DSH_HOME/.env`。

专家团链路包含“主 Agent -> 团长 -> 团员”两级委派，因此 AgentTeams 配置必须允许深度 2：

```yaml
- id: agent-teams
  config:
    memberProvider: spawn
    memberMaxDepth: 2
```

常用可选项包括 `catalogDir`、`agentTemplateDir`、`skillCacheDir`、`workspace`、`workerId`、`maxConcurrency`、`refreshChannel`、`subagentProvider`、`agentPreset`，以及在 Redis 模式中用作降级、在本地模式中作为必填运行模型的 `provider`/`model`。每个 ByClaw 根会话都会显式挂载 `agentPreset`，默认值为 `standard`；根 Agent 与委派 Agent 只获得该 preset 实际组合的编码工具和作用域 Skill。只有 CodeGraph MCP 工具对该 Agent 的精确作用域可见时，系统提示词才会出现 CodeGraph 策略，其中只列出可见操作，并要求每次调用把继承的 cwd 作为 `projectPath`；Trellis 策略仍由已启用的 `trellis-context` 插件及当前工作区状态独立决定。

`agentTypes` 可覆盖 Worker 实际消费的完整 AgentType 列表。缺省时仍注册 `BYCLAW_DSH` 与 `BYCLAW_DSH_<userCode>`。临时替换默认超级助手 Worker 时，以 ByClaw BE 实际报出的目标类型为准；当前默认超级助手入口使用 `['BY_SUPER']`。单一且完全相同的 AgentType 列表会沿用 by-framework 为原 Worker 派生的消费组，避免创建新消费组重放历史消息。接管前必须确认原 Worker 已停止或通过 `WorkerManager.suspendWorker` 暂停，回切时先停止 DSH 再恢复原 Worker。

## 验证

```sh
pnpm verify
```

该命令覆盖资源解析、模型动态装配、Skill 缓存、模板投影、异步暂停/唤醒、`ask_user`、任务计划和 `BYCLAW_DSH` 命令桥。真实环境可在 Worker 上线后执行：

```sh
node scripts/live-e2e.mjs '我有哪些数字员工？请简洁列出他们分别能帮我做什么。'
E2E_CWD=/absolute/project/path node scripts/live-e2e.mjs '请找架构助手分析项目架构。'
```

未设置 `E2E_SESSION_ID` 时，冒烟脚本会随机生成纯数字雪花 `session_id`；如需继续已有 ByAI 会话，则把现有数字雪花 ID 写入 `E2E_SESSION_ID`。

能力验收的入站指令只描述用户业务意图。Trellis 是否自动注入、是否按需读取规范，以及 Agent 是否自主调用 CodeGraph，应在任务结束后通过 DSH 会话事件确认；在入站指令中点名这些机制不能证明自动行为。
