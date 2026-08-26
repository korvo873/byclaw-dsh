# @byclaw/dsh-trellis-context

[English](README.md) | 中文

这是一个选择启用的 Cordis 插件，用于初始化 Trellis 仓库，并把仓库自有的 bootstrap、SessionStart、规范和工作流上下文追加到获准提示词所在的同一个 DeepSeek Harness 模型步骤中。包内 patch 会安装处于禁用状态的 `trellis-context` 配置项；受信任 profile 必须设置 `enabled: true`。

## 安装到 DSH

该包是从 DSH 源码检出目录构建的私有工作区包，不发布到 npm registry。把本目录放在 `plugins/trellis-context`，再构建本地包并加入目标 profile：

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-trellis-context run build
dsh plugin --profile web add /path/to/deepseek-harness/plugins/trellis-context
dsh --profile web --dump-config
```

安装后插件仍处于禁用状态。把仓库根目录的 [`.env.example`](../../.env.example) 复制到 DSH 启动目录并设置 `USER_CODE`，再由受信任 profile 用 `enabled: true` 覆盖 `trellis-context` 配置项。运行环境还需要 Git、`bash`、`python3`，并且 shell provider 与 DSH 进程必须看到同一份仓库文件。

## 配置

| 配置 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 仅当值严格为 `true` 时启用仓库检测与上下文注入。 |
| `userCode` | `process.env.USER_CODE` | 非空 Trellis 身份。两个来源都未提供身份时，插件启用会失败。 |
| `resourceDir` | 随包发布的 `resources/ensure-trellis-init` | 包含初始化器脚本和 bootstrap 工作流参考的目录。 |
| `stateDir` | `$DSH_HOME/state/trellis-context` | 插件自有事务目录的绝对路径。每个既有父目录必须归 root 或进程用户所有且不可由 group/world 写入；新建组件使用 `0700`，最终目录必须归进程用户所有且 mode 为 `0700`，并拒绝符号链接。 |
| `timeoutMs` | `120000` | 用于 Git 检测、初始化和每个钩子的正安全整数超时。 |

插件需要 `ctx.shell`、`ctx.sessions` 和 `ctx.systemPrompt`。`ctx.sandboxPolicy` 可用时，每个 shell 请求都会携带根据当前 Agent 会话解析的策略；该服务不可用时，由已配置的 shell executor 提供回退策略。profile 通常以 `@byclaw/dsh-trellis-context/cordis.patch.yml` 为基础，用受信任身份和 `enabled: true` 替换该配置项的配置。

## 准入与持久状态

pre-step 监听器会先委托下游。下游拒绝或获准的消息列表为空时，插件会直接返回，不产生 Git、初始化器、钩子或文件系统副作用。对于非空准入，插件使用最终下游消息作为 UserPromptSubmit 输入，解析规范 Git 根目录，运行初始化器，并追加一条 plugin 来源的 `user/message`。Agent Loop 会在派发模型请求前记录该消息，因此模型可见的每个 Trellis 输入都是持久的。

每个持久会话的第一次获准提示词会运行仓库中的 Trellis SessionStart 钩子，保留经过校验的 `hookSpecificOutput.additionalContext`，再加入 UserPromptSubmit 返回的 workflow state。生成的钩子通常会返回 `Available indexes (read on demand)` 以及 `.trellis/spec/**/index.md` 路径列表。部分生成钩子会在配置的包名含路径分隔符时漏掉更深层索引；插件会递归枚举 `.trellis/spec` 下的索引路径，并且只追加钩子输出中缺失的路径。插件不会打开索引或规则正文。Agent 通过正常文件工具按任务需要打开相关索引及其链接规则。如果该提示词初始化了 Trellis，消息还会包含生成的 `trellis-spec-bootstrap` Skill，要求先用 CodeGraph 分析再处理原请求，把 `.claude/skills/trellis-spec-bootstrap/SKILL.md` 指定为直接读取的回退路径，并包含 bootstrap 后 Git 工作流。之后的提示词只添加 workflow state。

系统提示词组装会从每个 Agent 的 `SessionHeader.cwd` 向上查找，并且只在同时发现 `.trellis` 与生成的 SessionStart 钩子时贡献 Trellis 消费策略。该策略要求 Agent 把 `plugin:trellis-context` 消息作为权威工作流输入，按需读取公布的索引和规则，不要求入站任务点名 Trellis。完成必要的初始化预检后，任务点名的目标被某个已公布索引覆盖时，Agent 必须在首次 CodeGraph 或原生代码探索前读取该索引；根 Agent 和委派 Agent 都要遵守。pre-step 中完成初始化的仓库会在当前请求收到明确的 bootstrap 与 Hook 消息；由于 DSH 在 pre-step 准入之前组装系统段落，系统策略从下一次组装开始生效。

在修改项目前，随包 POSIX helper 会获取按规范根目录摘要确定的、仅属主可访问的进程间锁。它保留项目根目录描述符，把 helper 进程切换到该目录，并在持锁状态重新检查状态以及执行每个 Git bootstrap、submodule、CodeGraph 和 Trellis 阶段期间一直持锁。加锁脚本只使用相对项目操作数；每个阶段开始前，helper 都会把规范根目录项和 `.gitmodules` 项、元数据及摘要与保留的根目录和当前记录进行比较。等待方会在所有者退出后获取同一把锁，重新判断 Git 是否存在，重新检查 `.trellis` 和记录，并且不会重复已完成的修改。

helper 会先写入并 fsync 一个唯一的仅属主可访问临时 inode，再通过描述符相对、不可替换的硬链接安装最终文件名，删除临时名称并 fsync `stateDir`，从而发布版本化 JSON 记录。重试会删除 helper 自有的不完整发布残留，并在修改项目前观察到一条完整最终记录或发布一条记录。记录文件名是规范根目录摘要；内容把该路径绑定到根目录 device/inode，以及 `.gitmodules` 的 device/inode、稳定元数据和 SHA-256 内容摘要。与当前项目实例不匹配的记录会通过描述符相对重命名进入仅属主可访问的 stale quarantine，不能触发替换项目的初始化或 bootstrap 发布。在支持的非 Git bootstrap 中，checkout 会继续使用同一个保留根目录和锁；checkout 后，helper 会立即以获取到的 `.gitmodules` 身份原子替换完全匹配的旧记录，然后才执行后续阶段。

helper 使用 no-follow 标志相对于保留的父目录描述符打开状态路径的每个组件，验证所有权和可写 mode，并比较每个已打开描述符与其目录项。记录创建、检查、quarantine 和删除只对保留的最终描述符使用等价于 `openat`/`mkdirat`/`renameat`/`unlinkat` 的 Python `dir_fd` 操作。它只为身份验证重新打开完整目录链，绝不会回到绝对路径名执行修改。中断的自有初始化会保留记录，之后的进程会补齐缺失的 bootstrap 资源；没有匹配记录的既有 `.trellis` 会返回 `already_initialized`。既有 Trellis 仓库不需要 `.gitmodules`；该文件只用于判定是否执行自动初始化。初始化器会用 `pending_bootstrap=none` 标记这种结果，因此准入在验证私有状态目录后不会检查事务记录。

事务会跨越取消、钩子失败、HMR 和进程重启，直到确切包含 bootstrap 的 plugin `user/message` 持久化。发布监听器会先让所有同步 `session/event` 观察者完成事件入队，再调用 `ctx.sessions.flush(session)`。随后它要求已配置的 `ctx.sessionPersistence`，用 `readFrom()` 从 bootstrap 序号读取物理日志，并且仅当存储事件的序号、来源、内容和消息身份与预期完全相同时才删除事务。只有 telemetry flush 观察者、没有持久化实现、flush／读取失败、持久事件不匹配或生命周期取消时都会保留重试状态。持久事件与事务同时存在时，会话回放会抑制重复 bootstrap 文本，同一精确事件检查允许清理陈旧状态。

SessionStart 去重检查已记录的 `trellis-context` 消息，而不是进程内存。因此恢复顶层会话时会保留一次性结果。进程内子会话会忽略 `seedLength` 之前继承的事件，获得自己的原样 SessionStart 钩子上下文，并记录自己的标记，供之后的子会话轮次及恢复使用。

## 文件、钩子与失败

钩子 JSON 通过 shell stdin 传递，并且只接受匹配的 `hookSpecificOutput.additionalContext`。格式错误、重复、不匹配、缺失或为空的钩子输出都会在模型请求前拒绝该步骤。超时、取消、空或非零退出码、截断输出、无效初始化器状态、缺少生成资源、无效 UTF-8、包含关系失败、不安全状态目录和事务替换都会报告规范项目根目录或事务路径及操作。

模型可见的 bootstrap 资源与仓库钩子脚本只打开一次，并且不跟随路径名的最终组件。插件会验证描述符身份与规范包含关系，然后从该描述符读取。每个仓库钩子都会从已验证描述符复制到仅属主可访问的临时可执行文件；shell 运行冻结副本，插件在进程结束后将其删除。回退索引扫描会忽略隐藏项和符号链接，并且只读取目录项；该插件不会打开规范文件正文。

同一进程中的并发提示词只共享当前正在进行的初始化器操作；第一个调用方的不可变沙箱策略快照控制该共享运行，独立进程则通过项目锁串行执行，并在等待后重新检查状态。每个进程内调用方独立等待；所有调用方都取消后才取消共享运行，并且该运行在结束前保持合并。终态结果不会缓存，因此之后的提示词会使用该次准入的当前策略再次运行幂等初始化器脚本。完整的已捕获 pre-step 调用会在等待下游 `next()` 之前进入生命周期跟踪。插件卸载和 HMR（热模块替换）会中止组合后的生命周期／请求信号，并在资源释放结束前等待受阻的下游 continuation、已获准工作、钩子运行、持久化屏障、事务清理和初始化器底层进程；屏障期间发生取消会保留事务以供重试。

初始化器解析与合并工具从 `@byclaw/dsh-trellis-context/initializer` 导出。使用 `pnpm --filter @byclaw/dsh-trellis-context run build` 构建该包。

## 模型体验

### 同步骤 Trellis 仓库上下文

#### 模型看到什么

对于既有 Trellis 工作区，第一次模型请求之前的系统提示词已经包含根据 cwd 发现的消费策略。持久会话的第一次获准提示词会追加一条用户消息，其中包含经过校验的 SessionStart `additionalContext`、递归发现的缺失索引路径，以及 UserPromptSubmit workflow state。完整索引路径列表为 Agent 提供按任务读取规范的导航，但不会预加载索引或规则正文。初始化器返回 `initialized` 时，消息前部还会加入生成的 bootstrap Skill，以及包自有的 CodeGraph 和 bootstrap 后工作流指令。之后的提示词只包含新的 workflow state。消息来源为 `plugin: trellis-context`；传输诊断、钩子 `systemMessage`、规范文件内容和初始化器状态输出均不会进入模型请求。

#### Token 影响

系统策略只在受信任 profile 启用插件，并且能从 Agent cwd 发现已初始化 Trellis 根目录时出现。消息输入还要求下游准入非空、当前目录属于 Git 仓库且初始化器结果适用。钩子输出受 shell 输出上限限制。SessionStart 与生成的 bootstrap 文本按上述规则在每个持久会话或初始化中添加一次，workflow state 则添加到每个获准提示词。

#### KV Cache 影响

仅追加。Trellis 消息位于最终下游消息之后，保留先前轮次可复用的前缀。依赖数据的工作流文本和首次会话／bootstrap 内容会扩展当前请求，但不会替换较早的请求 token。

## 已知限制与推迟工作

- **需要本地或共享的仓库文件系统** — Git、初始化器和钩子通过配置的 shell 执行，而描述符验证与读取使用 harness 进程文件系统。只有远程 shell 能看到相同规范路径与字节时才能使用该模式；否则必须在远程 harness 进程内组合此插件。
- **只有本地进程内子会话会继承该监听器** — 在另一个 harness 进程中运行的子会话需要自己的已启用插件组合和持久日志。
- **需要 Python 与 POSIX shell** — 随包初始化器通过 `bash` 运行，仓库钩子通过 `python3` 运行，事务安全依赖 Python 的 POSIX `dir_fd` 操作与 `O_NOFOLLOW`；`stateDir` 不能位于 `/tmp` 等 group/world 可写父目录之下。
- **插件命令仍受沙箱策略约束** — 受限会话必须允许所有必要副作用。特别是，当 `stateDir` 位于会话工作区之外时，会话策略必须为 `danger-full-access`；插件自身不会扩大当前会话策略。
- **规范按需读取** — Trellis SessionStart 钩子与回退路径扫描会提供索引路径，但插件不会预加载索引或规则正文；Agent 必须按当前任务打开相关路径。
