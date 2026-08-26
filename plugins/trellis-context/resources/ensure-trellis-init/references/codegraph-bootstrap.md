# CodeGraph-backed Trellis bootstrap

Use the prepared CodeGraph index as the primary repository-analysis source for
`trellis-spec-bootstrap`. The index path returned by the checker belongs to the
resolved Git root and already includes initialized nested submodules.

## Analysis sequence

1. Call `codegraph_status` and require a healthy, non-empty index.
2. Call `codegraph_context` once for the repository architecture and spec
   bootstrap task. Use the entry points and relationships it returns to choose
   package and layer boundaries.
3. Call `codegraph_explore` once for the small set of related symbols that need
   source-backed rules. For a specific execution path use `codegraph_trace`;
   for a risky boundary use `codegraph_impact`.
4. Use `codegraph_files` for indexed directory structure and
   `codegraph_search` for named symbols. Use literal search or direct reads only
   for text, configuration, or details the graph does not represent.
5. Write Trellis specs from those results and cite real paths and symbols. Do
   not repeat the same discovery with a file-reading sub-agent or broad grep.

When CodeGraph MCP tools are unavailable in the current host session, use the
CLI against the returned project root:

```bash
codegraph status "$project_root"
codegraph context --path "$project_root" "repository architecture and Trellis spec boundaries"
codegraph files --path "$project_root"
codegraph query --path "$project_root" "SymbolName"
```

Check each command's local `--help` if the installed CLI uses different option
names. Do not rebuild the index during this analysis pass; the checker has
already initialized or synchronized it.

The `.codegraph/` database and generated host-integration rules are local
analysis state. Keep them available for the current bootstrap, but do not stage
or commit them with Trellis specs unless the user separately requests it.
