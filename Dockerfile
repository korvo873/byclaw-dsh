# --- 基础阶段：安装各阶段共用的开发工具链 ---
FROM python:3.12-slim AS base

ARG NVM_VERSION=0.40.3
ARG NODE_VERSION=22.19.0
ARG PNPM_VERSION=11.7.0
# Python slim 基于 Debian；先使用 HTTP 阿里云镜像安装 ca-certificates，APT 仍校验仓库签名。
ARG APT_MIRROR=http://mirrors.aliyun.com

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NVM_DIR=/opt/nvm \
    NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DSH_HOME=/home/byclaw/.dsh \
    CODEGRAPH_MCP_CWD=/ \
    PATH=/opt/nvm/current/bin:/usr/local/bin:$PATH

# 创建非 root 用户
RUN groupadd --gid 1001 byclaw \
    && useradd --uid 1001 --gid byclaw --create-home --shell /bin/bash byclaw

# 安装系统工具、JDK 21 和 Maven；Python 3.12 由基础镜像提供。
RUN set -eux; \
    sed -i -E \
        -e "s|https?://deb.debian.org|${APT_MIRROR}|g" \
        -e "s|https?://security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        fd-find \
        git \
        jq \
        less \
        make \
        maven \
        netcat-openbsd \
        openssh-client \
        openjdk-21-jdk-headless \
        pkg-config \
        procps \
        psmisc \
        ripgrep \
        rsync \
        sqlite3 \
        tar \
        tree \
        unzip \
        zip \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# 全局配置 npm 和 pip 国内源，root 与 byclaw 均生效
RUN printf '%s\n' \
        "registry=${NPM_CONFIG_REGISTRY}" \
        > /etc/npmrc \
    && printf '%s\n' \
        '[global]' \
        "index-url = ${PIP_INDEX_URL}" \
        'timeout = 120' \
        > /etc/pip.conf

ARG NVM_SOURCE_BASE=https://cdn.jsdelivr.net/gh/nvm-sh/nvm
ARG NVM_SH_SHA256=390260ab9eb1da20e8bc0ebea2ee90f528d53e5e9f6e13b16717db4af454df9d
ARG NVM_EXEC_SHA256=e6b7a2bafac6994e1ba14282cff82c75476fba0788f68a9ecf558dfdf3331621
ARG NVM_BASH_COMPLETION_SHA256=b7eb3bf03d59b61e451957b020640aa55fe8bf47fb39d85d244e259f445d2fbe

# 从 CDN 下载固定版本的 NVM 必需文件，避免通过 Git 安装
RUN set -eux; \
    mkdir -p "${NVM_DIR}"; \
    for file_spec in \
        "nvm.sh:${NVM_SH_SHA256}" \
        "nvm-exec:${NVM_EXEC_SHA256}" \
        "bash_completion:${NVM_BASH_COMPLETION_SHA256}"; do \
        file_name="${file_spec%%:*}"; \
        file_sha256="${file_spec#*:}"; \
        curl -fL \
            --retry 5 \
            --retry-delay 2 \
            --connect-timeout 10 \
            --max-time 120 \
            "${NVM_SOURCE_BASE}@v${NVM_VERSION}/${file_name}" \
            -o "${NVM_DIR}/${file_name}"; \
        echo "${file_sha256}  ${NVM_DIR}/${file_name}" | sha256sum -c -; \
    done; \
    chmod 0755 "${NVM_DIR}/nvm-exec"

# 单独安装 Node.js，下载失败时不会使 NVM 源码层失效
RUN . "${NVM_DIR}/nvm.sh" \
    && nvm install "${NODE_VERSION}" \
    && nvm alias default "${NODE_VERSION}" \
    && ln -s "${NVM_DIR}/versions/node/v${NODE_VERSION}" "${NVM_DIR}/current"

# node-gyp 直接使用 Node 发行包内置 headers，避免回源 nodejs.org
ENV npm_config_nodedir=/opt/nvm/current

# 全局 Node.js 工具独立成层，便于定位并缓存 npm 下载
RUN npm install --global \
        "pnpm@${PNPM_VERSION}" \
        @colbymchenry/codegraph@1.6.0 \
    && npm cache clean --force \
    && chown -R byclaw:byclaw "${NVM_DIR}"

# 登录 shell 自动加载 NVM；current/bin 让 docker exec 等非登录 shell 也能直接使用 Node
RUN printf '%s\n' \
        'export NVM_DIR="/opt/nvm"' \
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' \
        '[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"' \
        > /etc/profile.d/nvm.sh \
    && chmod 0644 /etc/profile.d/nvm.sh


# --- 构建阶段：安装依赖、编译 DSH 与 ByClaw 插件 ---
FROM base AS builder

ARG DSH_REPOSITORY=https://githubfast.com/deepseek-ai/deepseek-harness.git
ARG DSH_REF=master

# 拉取 DSH 源码工作区；插件的 workspace:* 依赖必须在该 workspace 中解析
RUN git clone --depth 1 --branch "${DSH_REF}" "${DSH_REPOSITORY}" /workspace

# 将本项目维护的插件复制到 DSH 工作区
COPY --chown=byclaw:byclaw plugins/ /workspace/plugins/

# 远程 DSH master 可能尚未把外部插件目录加入 pnpm workspace
RUN if ! grep -qxF '  - plugins/*' /workspace/pnpm-workspace.yaml; then \
        sed -i '/^linkWorkspacePackages:/i\  - plugins/*\n' /workspace/pnpm-workspace.yaml; \
    fi

WORKDIR /workspace

# 安装 DSH 与插件依赖，并构建运行所需产物
RUN pnpm config set registry "${NPM_CONFIG_REGISTRY}" \
    && pnpm install --no-frozen-lockfile \
    && pnpm run build \
    && pnpm --filter @byclaw/dsh-trellis run test \
    && pnpm --filter @byclaw/dsh-agent-teams run build \
    && pnpm --filter @byclaw/dsh-agent-teams run verify \
    && pnpm --filter @byclaw/dsh-integration run verify \
    && pnpm --filter @byclaw/dsh-better-sidebar run build \
    && pnpm --filter @byclaw/dsh-diff-viewer run build \
    && pnpm --filter @byclaw/dsh-codegraph run verify

# 将全部 ByClaw 插件加入默认 web profile，并在构建时确认 bundle 已生效
RUN pnpm dsh plugin --profile web add \
        /workspace/plugins/agent-teams \
        /workspace/plugins/byclaw-integration \
        /workspace/plugins/dsh-trellis \
        /workspace/plugins/dsh-better-sidebar \
        /workspace/plugins/dsh-diff-viewer \
        /workspace/plugins/dsh-codegraph \
    && test -f /home/byclaw/.dsh/profiles/web/node_modules/@byclaw/dsh-trellis/lib/index.js \
    && node --input-type=module --eval \
        "await import('file:///home/byclaw/.dsh/profiles/web/node_modules/@byclaw/dsh-trellis/lib/index.js')" \
    && pnpm dsh --profile web --dump-config \
        | tee /tmp/dsh-web-config.yml \
    && grep -q -- "baseUrl: http://byclaw-be-standalone:8086" /tmp/dsh-web-config.yml \
    && for plugin_id in \
        agent-teams \
        byclaw-dsh \
        better-sidebar \
        trellis-workflow \
        dsh-diff-viewer \
        dsh-codegraph \
        codegraph-mcp; do \
        grep -q -- "${plugin_id}" /tmp/dsh-web-config.yml; \
    done \
    && rm -f /tmp/dsh-web-config.yml


# --- 运行阶段：只接收构建结果与运行配置 ---
FROM base AS runtime

WORKDIR /workspace

COPY --from=builder --chown=byclaw:byclaw /workspace /workspace
COPY --from=builder --chown=byclaw:byclaw /home/byclaw/.dsh /home/byclaw/.dsh
COPY --chown=byclaw:byclaw docker-entrypoint.sh /usr/local/bin/byclaw-dsh-entrypoint
RUN chmod 0755 /usr/local/bin/byclaw-dsh-entrypoint \
    && chown -R byclaw:byclaw /workspace /home/byclaw/.dsh

USER byclaw

ENTRYPOINT ["/usr/local/bin/byclaw-dsh-entrypoint"]
CMD ["web"]
