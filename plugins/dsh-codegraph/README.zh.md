# @byclaw/dsh-codegraph

[English](README.md) | 中文

这个 DSH 私有工作区插件统一维护 CodeGraph 运行能力。bundle 通过 `codegraph-mcp` 装配 `@deepseek-ai/dsh-mcp-client`，并注册根 Agent 与委派 Agent 都会继承的 CodeGraph 系统提示词。

## 安装

把本目录复制到 `<deepseek-harness>/plugins/dsh-codegraph`，然后执行：

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-codegraph run verify
dsh plugin --profile web add /path/to/deepseek-harness/plugins/dsh-codegraph
dsh --profile web --dump-config
```

最终装配树必须同时包含 `codegraph-mcp` 和 `dsh-codegraph`。默认 MCP 命令为 `codegraph serve --mcp`；如果命令不在 `PATH`，设置 `CODEGRAPH_COMMAND`，或在 profile patch 中覆盖完整的 `codegraph-mcp.config`。

系统策略要求每次 CodeGraph 调用都把 Agent 当前运行上下文中的权威 cwd 作为 `projectPath`，MCP 进程 cwd 不用于选择项目。容器中可把 `CODEGRAPH_MCP_CWD` 设置为 `/` 等中立目录，避免扫描 DSH 安装目录来寻找默认项目；每次调用时通过 `projectPath` 选择真实项目的能力不受影响。MCP 进程无法启动或同步工具时插件会直接加载失败，避免出现“有提示词但没有工具”的假能力。

## 验证

```sh
pnpm --filter @byclaw/dsh-codegraph run verify
```

端到端能力测试的入站消息只写业务意图。任务结束后检查 DSH 会话事件，确认 Agent 自主选择了 `mcp__codegraph__codegraph_*` 工具。
