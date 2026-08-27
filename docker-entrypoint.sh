#!/usr/bin/env bash
set -Eeuo pipefail

cd /workspace

# 默认启动 web profile；传入参数时允许覆盖为 headless 或其他 dsh 命令参数。
if (($# == 0)); then
    set -- web
fi

exec pnpm dsh "$@"
