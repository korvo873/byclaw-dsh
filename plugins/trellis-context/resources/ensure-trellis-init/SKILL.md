---
name: ensure-trellis-init
description: Prepare a project for Trellis by safely initializing Git and recursive submodules, building or refreshing a CodeGraph repository index, initializing Trellis, and running code-backed spec bootstrap. Use at the beginning of project work when the workspace root contains `.gitmodules` but does not contain `.trellis/`, independently of the optional automatic-hook switch.
---

# Ensure Trellis Init

Run this skill even when automatic initialization is disabled.
`BYCLAW_ENABLE_TRELLIS_INIT_HOOK` controls only the Worker/UserPromptSubmit
automatic path; do not inspect it or skip this requested workflow because of it.

Run the deterministic check before inspecting or modifying project files:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/ensure_trellis_init.sh" "$PWD"
```

When initialization is required, the checker runs these commands in order from
the Git root:

```bash
git submodule update --init --recursive
codegraph init -i "$project_root" # or: codegraph sync "$project_root"
codegraph status --json "$project_root"
trellis init -u "$USER_CODE" --claude -y
```

The checker requires a healthy CodeGraph index before Trellis starts. It creates
the index when `.codegraph/` is absent and synchronizes an existing index. A
CodeGraph command or health-check failure stops the workflow; do not fall back
to a full repository grep/read scan.

The checker serializes processes for one canonical project, retains the opened
project root, and rechecks project and `.gitmodules` identity before every
mutating phase. A waiter recomputes Git presence and completed state after it
acquires the lock.

If the workspace is not already a Git repository, require this configuration at
the top of its `.gitmodules`:

```ini
[environment]
url = https://github.com/example/workspace.git
branch = main
```

Read only `environment.url` and `environment.branch`, not similarly named
submodule fields. Initialize `origin`, fetch and check out that branch without
force, verify the fetched `.gitmodules` carries the same environment values,
then continue with recursive submodule initialization. Existing Git repositories
keep their current remote and branch.

Handle the result:

- `not_applicable` or `already_initialized`: Continue the user's task.
- `initialized`: Read
  [codegraph-bootstrap.md](references/codegraph-bootstrap.md), then immediately
  load `trellis-spec-bootstrap` with the `Skill` tool and complete its entire
  workflow using the prepared index. Do not continue the original task until it
  completes. If the newly generated skill is not yet available to the `Skill`
  tool in this session, use the `project_root` returned by the checker and read
  `$project_root/.claude/skills/trellis-spec-bootstrap/SKILL.md` directly. Follow
  it with references resolved relative to that skill directory. This direct read
  is the required fallback, not permission to skip the skill. After the
  bootstrap workflow completes, read
  [post-bootstrap-git.md](references/post-bootstrap-git.md) and follow that
  workflow exactly.
- Exit code `2`: Stop and ask the user to provide a non-empty `USER_CODE`.
- Any other nonzero exit: Stop and report the error. Do not continue with a
  partially populated workspace, retry with `--force`, delete conflicts, or
  substitute another Trellis command.

The submodule and CodeGraph commands must complete successfully before Trellis
starts so spec generation analyzes the recorded code revisions, including
nested submodules.

Do not run `trellis update`, `trellis upgrade`, add platform flags, or edit generated Trellis files unless the user separately requests it.
