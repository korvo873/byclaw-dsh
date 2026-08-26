# Post-bootstrap Git workflow

After `trellis-spec-bootstrap` completes, perform these steps in order:

1. Verify that the Trellis spec files were generated successfully.
2. The Worker resolved Git identity exclusively through `GH_TOKEN` and GitHub
   API before Claude started. Require non-empty `BYCLAW_GIT_USER_NAME` and
   `BYCLAW_GIT_USER_EMAIL`; stop if either value is missing. Never attempt to
   read, print, persist, or independently use `GH_TOKEN`; never use cached
   GitHub CLI credentials for identity lookup.
3. Set identity only in the current repository:

   ```bash
   git config --local user.name "$BYCLAW_GIT_USER_NAME"
   git config --local user.email "$BYCLAW_GIT_USER_EMAIL"
   ```

   Never use global or pre-existing Git identity as a fallback.
4. Inspect `git status`. Stage only files created or modified by this Trellis
   workflow; do not include unrelated pre-existing changes. Keep `.codegraph/`
   and CodeGraph-generated host integration files such as
   `.cursor/rules/codegraph.mdc` untracked unless the user separately asks to
   version them. The index is local analysis state, not a Trellis spec artifact.
5. Create exactly one `git commit` with the message
   `chore: initialize Trellis project specs`.
6. Determine the current branch and whether it has an upstream. Stop if HEAD is
   detached. Perform exactly one push: use `git push` when an upstream exists;
   otherwise use `git push -u origin <current-branch>`. The user has explicitly
   authorized this one push.

Do not continue the original request until every step succeeds. If spec
generation, commit, or push fails, stop and report the error. Never force-push,
amend an existing commit, discard unrelated changes, or include unrelated
pre-existing changes.
