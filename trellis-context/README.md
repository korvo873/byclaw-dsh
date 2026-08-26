# @byclaw/dsh-trellis-context

English | [中文](README.zh.md)

Opt-in Cordis plugin that initializes Trellis repositories and appends repository-owned bootstrap, SessionStart, specification, and workflow context to the same DeepSeek Harness model step that admitted the prompt. The package patch installs the `trellis-context` row disabled; a trusted profile must set `enabled: true`.

## Install in DSH

This private workspace package is built from a DSH source checkout and is not published to the npm registry. Place this directory at `plugins/trellis-context`, then build and add the local package to the target profile:

```sh
cd /path/to/deepseek-harness
pnpm install
pnpm --filter @byclaw/dsh-trellis-context run build
dsh plugin --profile web add /path/to/deepseek-harness/plugins/trellis-context
dsh --profile web --dump-config
```

Installation keeps the plugin disabled. Copy the repository [`.env.example`](../.env.example) to the DSH launch directory, set `USER_CODE`, and override the `trellis-context` row with `enabled: true` in a trusted profile. The runtime also requires Git, `bash`, `python3`, and a shell provider that sees the same repository files as the DSH process.

## Configuration

| Config | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Activates repository detection and context injection only when exactly `true`. |
| `userCode` | `process.env.USER_CODE` | Non-empty Trellis identity. Activation fails when neither source supplies one. |
| `resourceDir` | bundled `resources/ensure-trellis-init` | Directory containing the initializer script and bootstrap workflow references. |
| `stateDir` | `$DSH_HOME/state/trellis-context` | Absolute plugin-owned transaction directory. Every existing parent must be owned by root or the process user and must not be group/world-writable; new components use `0700`, the final directory must be process-owned mode `0700`, and symbolic links are rejected. |
| `timeoutMs` | `120000` | Positive safe-integer timeout applied to Git detection, initialization, and each hook. |

The plugin requires `ctx.shell`, `ctx.sessions`, and `ctx.systemPrompt`. When `ctx.sandboxPolicy` is available, every shell request carries the policy resolved from the active Agent session; otherwise the configured shell executor supplies its fallback policy. A profile normally starts from `@byclaw/dsh-trellis-context/cordis.patch.yml` and replaces the row configuration with its trusted identity and `enabled: true`.

## Admission and durable state

The pre-step listener delegates first. A downstream rejection or an admitted empty message list returns without Git, initializer, hook, or filesystem side effects. For a non-empty admission, the plugin uses the final downstream messages as UserPromptSubmit input, resolves the canonical Git root, runs the initializer, and appends one plugin-sourced `user/message`. The Agent Loop records that message before deriving the model request, so every model-visible Trellis input is durable.

The first admitted prompt in each durable session runs the repository's Trellis SessionStart hook and preserves its validated `hookSpecificOutput.additionalContext`, followed by workflow state from UserPromptSubmit. The generated hook normally returns an `Available indexes (read on demand)` list of `.trellis/spec/**/index.md` paths. Some generated hooks omit deeper indexes when a configured package name contains path separators; the plugin recursively enumerates index pathnames below `.trellis/spec` and appends only paths absent from the Hook output. It never opens index or rule bodies. The agent opens the relevant indexes and linked rules through its normal file tools. If that prompt initialized Trellis, the message also includes the generated `trellis-spec-bootstrap` Skill, requires CodeGraph analysis before the original request, names `.claude/skills/trellis-spec-bootstrap/SKILL.md` as the direct-read fallback, and includes the post-bootstrap Git workflow. Later prompts add workflow state only.

System-prompt assembly walks upward from each Agent's `SessionHeader.cwd` and contributes a Trellis consumption policy only when it finds both `.trellis` and the generated SessionStart hook. The policy tells the Agent to treat `plugin:trellis-context` messages as authoritative workflow input and read advertised indexes and rules on demand without requiring the inbound task to name Trellis. After any required initialization precheck, a named target covered by an advertised index requires reading that index before the first CodeGraph or native code exploration. The requirement applies to root and delegated Agents. A repository initialized during pre-step receives the explicit bootstrap and Hook message in that request; the system policy is effective from its next assembly because DSH assembles system sections before pre-step admission.

Before project mutation, the bundled POSIX helper acquires an owner-only interprocess lock keyed by the canonical-root digest. It retains the project-root directory descriptor, changes the helper process to that directory, and holds the lock across the under-lock state recheck and every Git bootstrap, submodule, CodeGraph, and Trellis phase. The locked script uses relative project operands; before each phase the helper compares the canonical root entry and `.gitmodules` entry, metadata, and digest with the retained root and current record. A waiter acquires the same lock after the owner exits, recomputes Git presence, rechecks `.trellis` and the record, and does not repeat completed mutation.

The helper publishes the versioned owner-only JSON record by writing and fsyncing a unique temporary inode, installing it at the final name with a descriptor-relative no-replace hard link, removing the temporary name, and fsyncing `stateDir`. A retry removes helper-owned incomplete publication residue and either observes one complete final record or publishes one before project mutation. The record filename is the canonical-root digest; its contents bind that path to the root device/inode and the `.gitmodules` device/inode, stable metadata, and SHA-256 content digest. A record that does not match the current project instance is renamed descriptor-relatively to an owner-only stale quarantine and cannot cause initialization or bootstrap publication for the replacement project. During supported non-Git bootstrap, checkout keeps the same retained root and lock; immediately after checkout the helper atomically replaces the exact old record with the fetched `.gitmodules` identity before any later phase.

The helper opens every state-path component relative to a retained parent descriptor with no-follow flags, validates ownership and writable modes, and compares each opened descriptor with its directory entry. Record create, inspect, quarantine, and removal use only `openat`/`mkdirat`/`renameat`/`unlinkat`-equivalent Python `dir_fd` operations against the retained final descriptor. It reopens the full directory chain only for identity validation and never returns to an absolute pathname for mutation. An interrupted owned initialization retains the record and a later process finishes missing bootstrap resources, while a pre-existing `.trellis` without a matching record returns `already_initialized`. An existing Trellis repository does not need `.gitmodules`; that file gates automatic initialization only. The initializer marks this result with `pending_bootstrap=none`, so admission skips record inspection after validating the private state directory.

The transaction survives cancellation, failed hooks, HMR, and process restart until the exact bootstrap-bearing plugin `user/message` is durable. The publication listener yields until every synchronous `session/event` observer has enqueued the event and calls `ctx.sessions.flush(session)`. It then requires the configured `ctx.sessionPersistence`, reads the physical log from the bootstrap sequence with `readFrom()`, and removes the transaction only when the stored event exactly matches the expected sequence, source, content, and message identity. Telemetry-only flush observers, absent persistence, flush/read failure, a mismatched durable event, and lifecycle cancellation retain retry state. If a durable event and transaction coexist, session replay suppresses duplicate bootstrap text and the same exact-event check permits stale-state cleanup.

SessionStart deduplication inspects recorded `trellis-context` messages rather than process memory. Resuming a top-level session therefore retains the one-shot result. An in-process child ignores inherited seed events up to `seedLength`, receives its own unchanged SessionStart hook context, and records its own marker for later child turns and resume.

## Files, hooks, and failures

Hook JSON is sent through shell stdin and only matching `hookSpecificOutput.additionalContext` is accepted. Malformed, duplicate, mismatched, missing, or empty hook output rejects the step before a model request. Timeout, cancellation, null or non-zero exit, truncated output, invalid initializer status, missing generated resources, invalid UTF-8, containment failures, insecure state directories, and transaction replacement report the canonical project root or transaction path and operation.

Model-visible bootstrap resources and repository hook scripts are opened once without following the final pathname component. The plugin validates descriptor identity and canonical containment, then reads that descriptor. Each repository hook is copied from its validated descriptor into an owner-only temporary executable; the shell runs the frozen copy and the plugin removes it after process settlement. The fallback index scan ignores hidden entries and symbolic links and reads directory entries only; specification file bodies are not opened by this plugin.

Concurrent prompts in one process share only an initializer operation that is currently in flight; the first caller's immutable sandbox-policy snapshot governs that shared run, while independent processes serialize through the project lock and recheck state after waiting. Each in-process caller waits independently; the shared run is cancelled after all callers cancel and remains coalesced until it settles. Terminal results are not cached, so a later prompt reruns the idempotent initializer script with that admission's current policy. The complete captured pre-step invocation enters lifecycle tracking before it awaits downstream `next()`. Plugin unload and HMR abort the combined lifecycle/request signals and await blocked downstream continuations, admitted work, hook runs, persistence barriers, transaction cleanup, and the initializer's underlying process before disposal settles; cancellation during a barrier leaves the transaction for retry.

Initializer parsing and coalescing utilities are exported from `@byclaw/dsh-trellis-context/initializer`. Build the package with `pnpm --filter @byclaw/dsh-trellis-context run build`.

## Model Experience

### Same-step Trellis repository context

#### What the model sees

For an existing Trellis workspace, the system prompt contains a cwd-derived consumption policy before the first model request. On the first admitted prompt for a durable session, one appended user message contains the validated SessionStart `additionalContext`, any missing recursively discovered index paths, and UserPromptSubmit workflow state. The complete index-path list gives the agent task-specific navigation without preloading index or rule bodies. An initializer result of `initialized` prefixes the generated bootstrap Skill and the package-owned CodeGraph and post-bootstrap instructions. Later prompts contain only fresh workflow state. The message source is `plugin: trellis-context`; transport diagnostics, hook `systemMessage`, specification file contents, and initializer status output are excluded.

#### Token effect

The system policy is conditional on an enabled trusted profile and an initialized Trellis root discoverable from the Agent cwd. The message contribution additionally requires a non-empty downstream admission, a Git repository, and an applicable initializer result. Hook output is capped by the shell output limit. SessionStart and generated bootstrap text are added once per durable session or initialization as described above, while workflow state is added to every admitted prompt.

#### KV Cache effect

Append-only. The Trellis message follows the final downstream messages and preserves the reusable prefix from prior turns. Its data-dependent workflow text and first-session/bootstrap additions extend the current request but do not replace earlier request tokens.

## Known Limitations and Deferred Work

- **Local or shared repository filesystem required** — Git, initializer, and hooks execute through the configured shell, while descriptor validation and reads use the harness process filesystem. A remote shell works only when it sees the same canonical paths and bytes; otherwise this plugin must be composed inside that remote process.
- **Only local in-process child sessions inherit this listener** — a child running in another harness process needs its own enabled plugin composition and durable log.
- **Python and POSIX shell are required** — the bundled initializer runs with `bash`, repository hooks run with `python3`, and transaction safety requires Python's POSIX `dir_fd` operations and `O_NOFOLLOW`; `stateDir` cannot descend through a group/world-writable parent such as `/tmp`.
- **Sandbox policy still governs plugin commands** — a confined session must permit every required effect. In particular, a `stateDir` outside the session workspace requires a `danger-full-access` session policy; the plugin never widens the active session policy itself.
- **Specification reads are on demand** — the Trellis SessionStart hook and fallback pathname scan supply index paths, but the plugin does not preload index or rule bodies; the agent must open the relevant paths for the current task.
