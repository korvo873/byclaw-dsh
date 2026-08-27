#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
required_assets=(
    "plugins/dsh-trellis/lib/index.js"
    "plugins/dsh-trellis/lib/client.js"
    "plugins/dsh-trellis/lib/types/index.d.ts"
)

for asset in "${required_assets[@]}"; do
    if git -C "${repo_root}" check-ignore -q -- "${asset}"; then
        echo "required image asset is ignored by Git: ${asset}" >&2
        exit 1
    fi
    if [[ ! -f "${repo_root}/${asset}" ]]; then
        echo "required image asset is missing: ${asset}" >&2
        exit 1
    fi
done
