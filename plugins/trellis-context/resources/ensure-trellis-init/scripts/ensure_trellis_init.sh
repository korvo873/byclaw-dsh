#!/usr/bin/env bash

set -u

cleanup_failed_git_bootstrap() {
  local project_root="$1"
  local bootstrap_backup="$2"
  local fetched_modules="$3"
  local git_metadata_owned="${4:-0}"

  if [[ -n "$bootstrap_backup" && -f "$bootstrap_backup" ]]; then
    if ! mv -f "$bootstrap_backup" "$project_root/.gitmodules"; then
      printf 'ensure-trellis-init: failed to restore bootstrap file; recover it from %s\n' "$bootstrap_backup" >&2
    fi
  fi
  if [[ -n "$bootstrap_backup" ]]; then
    rmdir "${bootstrap_backup%/*}" 2>/dev/null || true
  fi
  if [[ -n "$fetched_modules" ]]; then
    rm -f "$fetched_modules"
  fi
  if [[ "$git_metadata_owned" == "1" ]]; then
    rm -rf -- "$project_root/.git"
  fi
}

bootstrap_git_repository() {
  local project_root="$1"
  local diagnostic_root="${2:-$project_root}"
  local modules_file="$project_root/.gitmodules"
  local environment_url environment_branch remote_ref bootstrap_branch
  local fetched_modules=""
  local bootstrap_backup=""
  local bootstrap_backup_dir=""
  local git_metadata_owned=0

  environment_url="$(git config -f "$modules_file" --get environment.url 2>/dev/null || true)"
  environment_branch="$(git config -f "$modules_file" --get environment.branch 2>/dev/null || true)"
  if [[ -z "$environment_url" || -z "$environment_branch" ]]; then
    printf 'ensure-trellis-init: non-Git workspace requires environment.url and environment.branch in %s\n' "$modules_file" >&2
    return 1
  fi
  if [[ "$environment_url" == -* ]]; then
    printf 'ensure-trellis-init: environment.url must not start with a dash: %s\n' "$modules_file" >&2
    return 1
  fi
  if ! git check-ref-format "refs/heads/$environment_branch" >/dev/null 2>&1; then
    printf 'ensure-trellis-init: invalid environment.branch in %s\n' "$modules_file" >&2
    return 1
  fi
  if [[ -e "$project_root/.git" || -L "$project_root/.git" ]]; then
    printf 'ensure-trellis-init: workspace has unusable Git metadata: %s\n' "$project_root/.git" >&2
    return 1
  fi

  fetched_modules="$(mktemp "${TMPDIR:-/tmp}/ensure-trellis-fetched.XXXXXX")" || return 1
  bootstrap_backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/ensure-trellis-bootstrap.XXXXXX")" || {
    rm -f "$fetched_modules"
    return 1
  }
  bootstrap_backup="$bootstrap_backup_dir/.gitmodules"
  remote_ref="refs/remotes/origin/$environment_branch"
  bootstrap_branch="byclaw-bootstrap-empty"
  if [[ "$environment_branch" == "$bootstrap_branch" ]]; then
    bootstrap_branch="byclaw-bootstrap-empty-tmp"
  fi

  if ! mkdir "$project_root/.git"; then
    cleanup_failed_git_bootstrap \
      "$project_root" "$bootstrap_backup" "$fetched_modules" "$git_metadata_owned"
    printf 'ensure-trellis-init: Git metadata appeared before initialization: %s\n' "$project_root/.git" >&2
    return 1
  fi
  git_metadata_owned=1
  if ! git -C "$project_root" init -q -b "$bootstrap_branch" ||
     ! git -C "$project_root" remote add origin "$environment_url" ||
     ! GIT_TERMINAL_PROMPT=0 git -C "$project_root" fetch origin \
       "refs/heads/$environment_branch:$remote_ref" ||
     ! git -C "$project_root" show "$remote_ref:.gitmodules" >"$fetched_modules"; then
    cleanup_failed_git_bootstrap \
      "$project_root" "$bootstrap_backup" "$fetched_modules" "$git_metadata_owned"
    printf 'ensure-trellis-init: failed to fetch environment branch %s\n' "$environment_branch" >&2
    return 1
  fi

  if [[ "$(git config -f "$fetched_modules" --get environment.url 2>/dev/null || true)" != "$environment_url" ||
        "$(git config -f "$fetched_modules" --get environment.branch 2>/dev/null || true)" != "$environment_branch" ]]; then
    cleanup_failed_git_bootstrap \
      "$project_root" "$bootstrap_backup" "$fetched_modules" "$git_metadata_owned"
    printf 'ensure-trellis-init: fetched .gitmodules environment does not match bootstrap configuration\n' >&2
    return 1
  fi

  mv "$modules_file" "$bootstrap_backup"
  if ! git -C "$project_root" checkout -q -b "$environment_branch" --track "$remote_ref"; then
    cleanup_failed_git_bootstrap \
      "$project_root" "$bootstrap_backup" "$fetched_modules" "$git_metadata_owned"
    printf 'ensure-trellis-init: failed to check out environment branch %s without overwriting workspace files\n' "$environment_branch" >&2
    return 1
  fi

  rm -f "$bootstrap_backup" "$fetched_modules"
  rmdir "$bootstrap_backup_dir"
  printf 'status=git_initialized project_root=%q remote=%q branch=%q\n' \
    "$diagnostic_root" "$environment_url" "$environment_branch"
}

ensure_codegraph_index() {
  local project_root="$1"
  local diagnostic_root="${2:-$project_root}"
  local index_dir="$project_root/.codegraph"
  local status_json

  if [[ -d "$index_dir" ]]; then
    if ! codegraph sync "$project_root"; then
      printf 'ensure-trellis-init: CodeGraph sync failed for %s\n' "$diagnostic_root" >&2
      return 1
    fi
  elif [[ -e "$index_dir" ]]; then
    printf 'ensure-trellis-init: .codegraph exists but is not a directory: %s\n' "$diagnostic_root/.codegraph" >&2
    return 1
  elif ! codegraph init -i "$project_root"; then
    printf 'ensure-trellis-init: CodeGraph initialization failed for %s\n' "$diagnostic_root" >&2
    return 1
  fi

  if ! status_json="$(codegraph status --json "$project_root")"; then
    printf 'ensure-trellis-init: CodeGraph health check failed for %s\n' "$diagnostic_root" >&2
    return 1
  fi
  if ! CODEGRAPH_STATUS_JSON="$status_json" python3 -c '
import json
import os
import sys

status = json.loads(os.environ["CODEGRAPH_STATUS_JSON"])
healthy = (
    status.get("initialized") is True
    and int(status.get("fileCount", 0)) > 0
    and int(status.get("nodeCount", 0)) > 0
)
sys.exit(0 if healthy else 1)
'; then
    printf 'ensure-trellis-init: CodeGraph health check failed for %s\n' "$diagnostic_root" >&2
    return 1
  fi
}

locked_transaction() {
  local mode="$1"
  shift
  local state_dir="${TRELLIS_CONTEXT_STATE_DIR:?TRELLIS_CONTEXT_STATE_DIR is required}"
  local helper="${TRELLIS_CONTEXT_TRANSACTION_HELPER:-}"
  if [[ -n "${transaction_test_hook:-}" && -n "${transaction_test_fault:-}" ]]; then
    python3 "$helper" --test-hook "$transaction_test_hook" --test-fault "$transaction_test_fault" \
      "locked-$mode" "$state_dir" "$project_root" \
      "${TRELLIS_CONTEXT_LOCKED_STATE_FD:?locked state descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_ROOT_FD:?locked root descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_LOCK_FD:?locked lock descriptor is required}" "$@"
  elif [[ -n "${transaction_test_hook:-}" ]]; then
    python3 "$helper" --test-hook "$transaction_test_hook" "locked-$mode" \
      "$state_dir" "$project_root" \
      "${TRELLIS_CONTEXT_LOCKED_STATE_FD:?locked state descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_ROOT_FD:?locked root descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_LOCK_FD:?locked lock descriptor is required}" \
      "$@"
  elif [[ -n "${transaction_test_fault:-}" ]]; then
    python3 "$helper" --test-fault "$transaction_test_fault" "locked-$mode" \
      "$state_dir" "$project_root" \
      "${TRELLIS_CONTEXT_LOCKED_STATE_FD:?locked state descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_ROOT_FD:?locked root descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_LOCK_FD:?locked lock descriptor is required}" \
      "$@"
  else
    python3 "$helper" "locked-$mode" \
      "$state_dir" "$project_root" \
      "${TRELLIS_CONTEXT_LOCKED_STATE_FD:?locked state descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_ROOT_FD:?locked root descriptor is required}" \
      "${TRELLIS_CONTEXT_LOCKED_LOCK_FD:?locked lock descriptor is required}" \
      "$@"
  fi
}

transaction_status() {
  TRELLIS_CONTEXT_TRANSACTION_JSON="$1" python3 -c '
import json
import os

value = json.loads(os.environ["TRELLIS_CONTEXT_TRANSACTION_JSON"])
status = value.get("status")
if not isinstance(status, str):
    raise RuntimeError("transaction helper output has no status")
print(status)
'
}

transaction_field() {
  TRELLIS_CONTEXT_TRANSACTION_JSON="$1" TRELLIS_CONTEXT_TRANSACTION_FIELD="$2" python3 -c '
import json
import os

value = json.loads(os.environ["TRELLIS_CONTEXT_TRANSACTION_JSON"])
field = os.environ["TRELLIS_CONTEXT_TRANSACTION_FIELD"]
if field not in ("markerDev", "markerIno", "recordDigest"):
    raise RuntimeError("unsupported transaction identity field")
result = value.get(field)
if not isinstance(result, str) or not result:
    raise RuntimeError(f"transaction helper output has no {field}")
if field == "recordDigest":
    valid = len(result) == 64 and all(character in "0123456789abcdef" for character in result)
else:
    valid = result.isdecimal()
if not valid:
    raise RuntimeError(f"transaction helper output has malformed {field}")
print(result)
'
}

run_locked_phase() {
  project_root="$1"
  git_repository_present="$2"
  shift 2
  transaction_test_hook=""
  transaction_test_fault=""
  while [[ "${1:-}" == "--test-hook" || "${1:-}" == "--test-fault" ]]; do
    if [[ "$1" == "--test-hook" ]]; then
      transaction_test_hook="${2:?--test-hook requires a path}"
    else
      transaction_test_fault="${2:?--test-fault requires a stage}"
    fi
    shift 2
  done
  if (( $# != 0 )); then
    printf 'ensure-trellis-init: unexpected locked-phase arguments\n' >&2
    return 1
  fi

  local locked_git_root=""
  git_repository_present=0
  if locked_git_root="$(git rev-parse --show-toplevel 2>/dev/null)" &&
     [[ "$locked_git_root" == "$project_root" ]]; then
    git_repository_present=1
  fi

  local transaction_json transaction_state
  local advance_marker_dev advance_marker_ino advance_record_digest
  if [[ -d .trellis ]]; then
    if ! transaction_json="$(locked_transaction inspect)" ||
       ! transaction_state="$(transaction_status "$transaction_json")"; then
      printf 'ensure-trellis-init: cannot validate pending transaction in %s\n' \
        "${TRELLIS_CONTEXT_STATE_DIR:-}" >&2
      return 1
    fi
    if [[ "$transaction_state" == "present" &&
          ! -f .claude/skills/trellis-spec-bootstrap/SKILL.md ]]; then
      :
    else
      printf 'status=already_initialized project_root=%q pending_bootstrap=inspect\n' "$project_root"
      return 0
    fi
  elif [[ -e .trellis ]]; then
    printf 'ensure-trellis-init: .trellis exists but is not a directory: %s\n' "$project_root/.trellis" >&2
    return 1
  fi

  if ! transaction_json="$(locked_transaction ensure)" ||
     ! transaction_state="$(transaction_status "$transaction_json")"; then
    printf 'ensure-trellis-init: cannot create or validate pending transaction in %s\n' \
      "${TRELLIS_CONTEXT_STATE_DIR:-}" >&2
    return 1
  fi
  if [[ "$transaction_state" == "mismatch" ]]; then
    printf 'status=not_applicable project_root=%q reason=stale_transaction\n' "$project_root"
    return 0
  fi
  if [[ "$transaction_state" != "created" && "$transaction_state" != "present" ]]; then
    printf 'ensure-trellis-init: transaction helper returned unexpected status: %s\n' "$transaction_state" >&2
    return 1
  fi

  if [[ "$git_repository_present" == "0" ]]; then
    transaction_json="$(locked_transaction revalidate before-git-bootstrap)" || return 1
    advance_marker_dev="$(transaction_field "$transaction_json" markerDev)" || return 1
    advance_marker_ino="$(transaction_field "$transaction_json" markerIno)" || return 1
    advance_record_digest="$(transaction_field "$transaction_json" recordDigest)" || return 1
    bootstrap_git_repository . "$project_root" || return 1
    locked_transaction advance \
      "$advance_marker_dev" "$advance_marker_ino" "$advance_record_digest" >/dev/null || return 1
  fi

  locked_transaction revalidate before-git-submodule >/dev/null || return 1
  if ! git submodule update --init --recursive; then
    printf 'ensure-trellis-init: git submodule update failed for %s\n' "$project_root" >&2
    return 1
  fi

  locked_transaction revalidate before-codegraph >/dev/null || return 1
  ensure_codegraph_index . "$project_root" || return 1

  locked_transaction revalidate before-trellis >/dev/null || return 1
  if ! trellis init -u "$USER_CODE" --claude -y; then
    printf 'ensure-trellis-init: trellis init failed for %s\n' "$project_root" >&2
    return 1
  fi

  if [[ ! -d .trellis ]]; then
    printf 'ensure-trellis-init: trellis init succeeded without creating %s\n' "$project_root/.trellis" >&2
    return 1
  fi
  if [[ ! -f .claude/skills/trellis-spec-bootstrap/SKILL.md ]]; then
    printf 'ensure-trellis-init: trellis-spec-bootstrap is missing after initialization: %s\n' \
      "$project_root/.claude/skills/trellis-spec-bootstrap/SKILL.md" >&2
    return 1
  fi
  if ! transaction_json="$(locked_transaction inspect)" ||
     ! transaction_state="$(transaction_status "$transaction_json")" ||
     [[ "$transaction_state" != "present" ]]; then
    printf 'ensure-trellis-init: project identity changed after Trellis initialization: %s\n' \
      "$project_root" >&2
    return 1
  fi

  printf 'status=initialized project_root=%q user=%q codegraph_index=%q bootstrap_skill=%q\n' \
    "$project_root" "$USER_CODE" "$project_root/.codegraph" \
    "$project_root/.claude/skills/trellis-spec-bootstrap/SKILL.md"
}

if [[ "${1:-}" == "--locked-phase" ]]; then
  shift
  run_locked_phase "$@"
  exit $?
fi

workspace_dir="${1:-$PWD}"
git_repository_present=0
if (( $# > 0 )); then
  shift
fi
transaction_test_hook=""
transaction_test_fault=""
while [[ "${1:-}" == "--test-hook" || "${1:-}" == "--test-fault" ]]; do
  if [[ "$1" == "--test-hook" ]]; then
    transaction_test_hook="${2:?--test-hook requires a path}"
  else
    transaction_test_fault="${2:?--test-fault requires a stage}"
  fi
  shift 2
done
if (( $# != 0 )); then
  printf 'ensure-trellis-init: unexpected arguments\n' >&2
  exit 1
fi

if [[ ! -d "$workspace_dir" ]]; then
  printf 'ensure-trellis-init: workspace is not a directory: %s\n' "$workspace_dir" >&2
  exit 1
fi

if project_root="$(git -C "$workspace_dir" rev-parse --show-toplevel 2>/dev/null)"; then
  git_repository_present=1
else
  project_root="$(cd "$workspace_dir" && pwd -P)" || {
    printf 'ensure-trellis-init: cannot resolve workspace: %s\n' "$workspace_dir" >&2
    exit 1
  }
fi

if [[ ! -e "$project_root/.gitmodules" ]]; then
  if [[ -d "$project_root/.trellis" ]]; then
    printf 'status=already_initialized project_root=%q pending_bootstrap=none\n' "$project_root"
    exit 0
  fi
  if [[ -e "$project_root/.trellis" ]]; then
    printf 'ensure-trellis-init: .trellis exists but is not a directory: %s\n' "$project_root/.trellis" >&2
    exit 1
  fi
  printf 'status=not_applicable project_root=%q reason=no_gitmodules\n' "$project_root"
  exit 0
fi

if [[ ! -f "$project_root/.gitmodules" ]]; then
  printf 'ensure-trellis-init: .gitmodules is not a regular file: %s\n' "$project_root/.gitmodules" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ensure-trellis-init: python3 command was not found in PATH\n' >&2
  exit 1
fi

if [[ -z "${USER_CODE:-}" ]]; then
  printf 'ensure-trellis-init: USER_CODE is required to initialize %s\n' "$project_root" >&2
  exit 2
fi

if ! command -v trellis >/dev/null 2>&1; then
  printf 'ensure-trellis-init: trellis command was not found in PATH\n' >&2
  exit 1
fi

if ! command -v codegraph >/dev/null 2>&1; then
  printf 'ensure-trellis-init: codegraph command was not found in PATH\n' >&2
  exit 1
fi

state_dir="${TRELLIS_CONTEXT_STATE_DIR:-}"
helper="${TRELLIS_CONTEXT_TRANSACTION_HELPER:-}"
if [[ -z "$state_dir" || "$state_dir" != /* ]]; then
  printf 'ensure-trellis-init: TRELLIS_CONTEXT_STATE_DIR must be absolute\n' >&2
  exit 1
fi
if [[ -z "$helper" || "$helper" != /* || ! -f "$helper" || -L "$helper" ]]; then
  printf 'ensure-trellis-init: TRELLIS_CONTEXT_TRANSACTION_HELPER must name the bundled regular file\n' >&2
  exit 1
fi
if [[ -n "$transaction_test_hook" && -n "$transaction_test_fault" ]]; then
  python3 "$helper" --test-hook "$transaction_test_hook" --test-fault "$transaction_test_fault" \
    lock-exec "$state_dir" "$project_root" "${BASH_SOURCE[0]}" "$git_repository_present"
elif [[ -n "$transaction_test_hook" ]]; then
  python3 "$helper" --test-hook "$transaction_test_hook" lock-exec \
    "$state_dir" "$project_root" "${BASH_SOURCE[0]}" "$git_repository_present"
elif [[ -n "$transaction_test_fault" ]]; then
  python3 "$helper" --test-fault "$transaction_test_fault" lock-exec \
    "$state_dir" "$project_root" "${BASH_SOURCE[0]}" "$git_repository_present"
else
  python3 "$helper" lock-exec \
    "$state_dir" "$project_root" "${BASH_SOURCE[0]}" "$git_repository_present"
fi
