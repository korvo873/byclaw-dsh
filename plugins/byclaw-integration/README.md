# @byclaw/dsh-integration

English | [中文](README.zh.md)

`@byclaw/dsh-integration` is an independent DeepSeek Harness (DSH) plugin for ByClaw. It does not modify DSH or ByClaw source code. It uses DSH plugin extension points, `@byclaw/by-framework`, and the separate AgentTeams plugin to synchronize resources, configure models, receive messages, and coordinate multiple agents.

## Install in DSH

This private workspace package is built from a DSH source checkout and is not published to the npm registry. Place this directory at `plugins/byclaw-integration`, install AgentTeams first, then build and add both local packages to the target profile:

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-agent-teams run build
pnpm --filter @byclaw/dsh-integration run build
dsh plugin --profile web add /path/to/deepseek-harness/plugins/agent-teams
dsh plugin --profile web add /path/to/deepseek-harness/plugins/byclaw-integration
dsh --profile web --dump-config
```

Copy the repository [`.env.example`](../../.env.example) to the DSH launch directory, fill the deployment values, and keep the resulting `.env` untracked. The bundled patch enables this plugin; startup fails when `USER_CODE`, Redis, ByClaw BE, or the selected model route is invalid.

## Runtime structure

The plugin registers a `BYCLAW_DSH` Worker and projects ByClaw-authorized resources into two reusable template kinds:

- Digital employees: `byclaw-employee-<resourceId>` creates one ordinary DSH child agent without creating a team.
- Expert groups: `byclaw-group-<resourceId>` first creates the group's dedicated leader agent. The leader then creates a task-specific AgentTeams runtime team through `byclaw-team-<resourceId>`.

The main agent only discovers resources and selects templates; it does not replace an expert group's leader. After a temporary team completes and its leader synthesizes the result, the leader removes it with `agent_teams_delete`. The DSH root, leader, and member sessions remain durable, so the ByClaw frontend can still display the complete parent/child session hierarchy.

```text
ByClaw 入站
  -> BYCLAW_DSH Worker
  -> DSH 主 Agent
       -> 单数字员工模板 -> 普通子 Agent
       -> 专家团模板 -> 团长 Agent -> AgentTeams 团员 Agent
```

After the main agent delegates, DSH subagent-settlement events pause and wake it. An expert-group leader pauses and wakes through AgentTeams member events. Neither path polls.

## Dynamic resources and Skills

The plugin subscribes to the Redis change channel before running one blocking cold-start synchronization. The Worker starts only after the subscription and cold-start generation succeed. The plugin then refreshes resources:

- before `byclaw_list_resources` or template instantiation;
- when Redis publishes a change on `byai:pub:dig_employee_change`.

Redis supplies login authorization, candidate resource-ID discovery, model configuration, and change notifications; it is not the final source for digital-employee or expert-group content. Every cold or hot synchronization loads current employee and group fields from `digitalEmployeeController/findDetailsById`. Expert-group prompts, models, effective members, and configuration versions come from `orchestrators/resolve-runtime`. A Redis signal received during cold start enters the same serialized synchronization queue and runs after the active generation.

Each refresh acquires the exclusive generation coordinator before snapshotting the live catalogs, stages a complete generation of Skills, digital-employee templates, expert-group templates, and AgentTeams adapters, then holds the coordinator through publication, rollback, and backup cleanup. Template instantiation, template-backed AgentTeams creation, and template listing use shared admission; AgentTeams template saving uses exclusive admission. Concurrent consumers therefore use either the complete preceding generation or the complete replacement, and a save admitted after publication keeps its unrelated template. During unload the coordinator rejects new admission, drains admitted operations and refresh work, closes Worker, session, and Redis resources, then removes the service. A successful refresh removes revoked ByClaw-owned artifacts while preserving unrelated files; a failed refresh retains the last complete generation. A first-startup failure fails immediately so a Worker cannot start with empty resources.

Digital-employee persona projection follows ByClaw instruction normalization: `relPrompt` takes precedence over `corePersonaDefinition`; nested JSON prompt records retain their headings; and `ability`, `processingFlow`, and `coreCompetencies` become separate sections rendered once for both direct employees and expert-group members. Expert-group leader templates prepend non-overridable DSH and AgentTeams orchestration, attachment, failure-handling, and settlement rules, then append the authorized `resolve-runtime` business prompt. Refresh also removes legacy `byclaw-group-*` AgentTeams adapters while preserving unrelated templates.

Digital-employee Skills synchronize into `agentTemplateDir/byclaw-skills` using the `baiying-enhance` download semantics. Credential-bearing catalog and Skill requests remain on the configured `baseUrl` origin and do not follow redirects automatically. The plugin writes each Skill path to the employee template and expert-group member adapter, then registers it in the standard DSH scoped Skill registry only for the corresponding agent during instantiation. The standard Skill tool owns the model-visible catalog and Skill-body loading; the integration does not register a second `skill` tool or affect the main agent and other members.

`byclaw_list_resources` returns only `id/code/name/description/template_id/invocation` needed for main-agent routing, plus compact member names and roles for expert groups. Child-agent Skills, tools, personas, models, and execution parameters do not enter the routing catalog. After `byclaw_instantiate_template`, the plugin dynamically loads those runtime resources from the local template for that agent.

## Dynamic models

`BYCLAW_REDIS_MODEL_ENABLED` selects the runtime model source for every agent received or instantiated through this plugin. The variable is enabled by default; unset, empty, `true`, `1`, `on`, and `yes` enable Redis model resolution. When enabled:

- Main agent: reads the current unique default LLM from Redis for every ByClaw inbound message.
- Digital employee: uses `prologue.modelId` when configured, otherwise the default LLM.
- Expert-group leader: uses the model ID from the expert group's runtime configuration.
- Expert-group member: uses its digital employee's model ID when configured, otherwise the default LLM. Team creation freezes the provider/model used for that run.

The model catalog is Redis Hash `byai:aimodel:typelist` field `LLM`; connection configuration is `byai:aimodel:config`. Each model maps to a unique `baiying-m-<instanceId>` provider and supports Anthropic Messages, OpenAI Completions, and OpenAI Responses. Encrypted authorization is decrypted in memory. Keys, tokens, and request headers are never written to templates, AgentTeams files, or DSH session events.

With Redis model resolution enabled, resolution falls back from current configuration to the last successful binding, then to the plugin's configured `provider`/`model`. A non-unique default, missing model, or invalid configuration fails at the earliest resolvable point; the plugin never silently selects an arbitrary model.

`false`, `0`, `off`, or `no` disables Redis model resolution. In that mode the main agent, digital employees, expert-group leaders, and expert-group members all use the configured local `provider`/`model`; resource model IDs are ignored for execution, and the plugin does not read the Redis AI-model Hashes or register dynamic ByClaw model routes. Disabling Redis models without both local fields, or supplying any other switch value, fails plugin startup.

## ByClaw message mapping

- ByAI ingress may set `extra_payload.cwd` to an absolute working directory for a new DSH root session; otherwise the plugin `workspace` is used. The plugin records the external `session_id` and resolved directory once as `byclaw/session-workspace`, frames inbound model input with the same session-workspace declaration, and rejects a conflicting directory on resume. Every continuable child copies that durable namespace from its live parent during unpublished creation, retains its own DSH session ID, and receives a cwd-only `delegation-workspace` task declaration.
- Every inbound `AskAgent` writes terminal-visible lifecycle logs in order: received command identifiers; inherited ByClaw session namespace, DSH ID, effective `cwd`, and root/delegated scope; currently visible CodeGraph capability count; new, resumed, or continued session; non-secret model resolution (`sourceModelId`, provider, model, protocol, and resolution source); and task start with the complete instruction. When a digital-employee or expert-group child is composed, another log lists only that template's Skill names and local paths. The plugin does not add login authorization, Redis passwords, endpoints, or model credentials; because an instruction can contain sensitive text, operators must treat these logs as conversation data.
- DSH text blocks -> `answerDelta`
- DSH reasoning blocks -> `reasoningLogDelta`
- `ask_user_question` -> structured ByClaw question card with `contentType=3014`; `ResumeCommand` fills the answer and wakes the originating call
- `todo_write` and compatibility tool `task_plan` -> `todo/write` session event -> task-plan card with `contentType=2008`; a plan event uses `<inbound message ID>:plan` and records the inbound message ID as `parent_message_id`
- Child-agent creation, running, waiting, completion, or failure -> status event carrying DSH session ID, parent session ID, and delegation depth
- A Worker terminal state sends only a completion signal and does not repeat final text already sent in the stream

## Configuration

```yaml
- insert:
    - id: byclaw-dsh
      name: '@byclaw/dsh-integration'
      config:
        enabled: true
        userCode: !!js process.env.USER_CODE
        baseUrl: 'http://123.56.153.229:8080'
```

The Redis connection reads only standard `REDIS_*` environment variables. The default ByClaw backend address is `http://123.56.153.229:8080` and `baseUrl` overrides it. Redis model mode also requires `BAIYING_AIMODEL_AUTH_TOKEN_SM4_KEY_HEX` to decrypt ByClaw model authorization. Set `BYCLAW_REDIS_MODEL_ENABLED=false` and configure both `provider` and `model` to use only the local DSH model route at runtime. The DSH launcher reads `.env` from its launch working directory, with an already exported process value taking precedence over that file and `$DSH_HOME/.env`.

An expert-group path delegates twice—main agent to leader to member—so the AgentTeams configuration must allow depth 2:

```yaml
- id: agent-teams
  config:
    memberProvider: spawn
    memberMaxDepth: 2
```

Common optional settings are `catalogDir`, `agentTemplateDir`, `skillCacheDir`, `workspace`, `workerId`, `maxConcurrency`, `refreshChannel`, `subagentProvider`, `agentPreset`, and the local `provider`/`model` used as the Redis-mode fallback or as the required model in local mode. Every ByClaw root session explicitly mounts `agentPreset`; its default is `standard`. Root and delegated agents receive the coding tools and scoped Skills actually composed by that preset. A CodeGraph system policy appears only when CodeGraph MCP tools are visible to the exact Agent scope, lists only visible operations, and requires every call to pass the inherited cwd as `projectPath`; Trellis policy remains independently owned by the enabled `trellis-context` plugin and the current workspace state.

`agentTypes` overrides the complete AgentType list consumed by the Worker. By default, the plugin still registers `BYCLAW_DSH` and `BYCLAW_DSH_<userCode>`. When temporarily replacing the default super-assistant Worker, use the target type actually reported by the ByClaw backend; the current default super-assistant entry uses `['BY_SUPER']`. One identical AgentType list reuses the consumer group that by-framework derived for the original Worker, avoiding historical-message replay in a new consumer group. Before takeover, confirm that the original Worker has stopped or suspend it with `WorkerManager.suspendWorker`; on rollback, stop DSH before restoring the original Worker.

## Verification

```sh
pnpm verify
```

This command covers resource parsing, dynamic model configuration, Skill caching, template projection, asynchronous pause/wake, `ask_user`, task plans, and the `BYCLAW_DSH` command bridge. After the Worker is online in a real environment, run:

```sh
node scripts/live-e2e.mjs '我有哪些数字员工？请简洁列出他们分别能帮我做什么。'
E2E_CWD=/absolute/project/path node scripts/live-e2e.mjs '请找架构助手分析项目架构。'
```

The smoke generates a random numeric Snowflake `session_id` when `E2E_SESSION_ID` is omitted. Set `E2E_SESSION_ID` to an existing numeric Snowflake to continue that ByAI conversation.

Capability verification prompts should contain only the user's business intent. Confirm Trellis injection, on-demand spec reads, and autonomous CodeGraph calls from the resulting DSH session events; naming those mechanisms in the inbound instruction does not prove automatic behavior.
