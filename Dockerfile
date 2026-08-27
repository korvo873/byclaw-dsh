# dsh 基础开发环境
FROM ubuntu:24.04

ARG NVM_VERSION=0.40.3
ARG NODE_VERSION=22.19.0
ARG PNPM_VERSION=11.7.0
ARG DSH_REPOSITORY=https://github.com/deepseek-ai/deepseek-harness.git
ARG DSH_REF=main
# 基础镜像尚未安装 ca-certificates，先用 HTTP 引导安装证书；APT 仍校验仓库签名。
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
    PATH=/opt/nvm/current/bin:/usr/local/bin:$PATH

# 创建非 root 用户
RUN groupadd --gid 1001 byclaw \
    && useradd --uid 1001 --gid byclaw --create-home --shell /bin/bash byclaw

# 安装系统工具、Python 3.12、JDK 21 和 Maven
# Ubuntu arm64 使用 ubuntu-ports，amd64 使用 ubuntu；两者都切到国内镜像。
RUN set -eux; \
    architecture="$(dpkg --print-architecture)"; \
    case "${architecture}" in \
        arm64|armhf|ppc64el|riscv64|s390x) \
            sed -i -E "s|https?://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}/ubuntu-ports|g" \
                /etc/apt/sources.list.d/ubuntu.sources \
            ;; \
        amd64|i386) \
            sed -i -E \
                -e "s|https?://archive.ubuntu.com/ubuntu|${APT_MIRROR}/ubuntu|g" \
                -e "s|https?://security.ubuntu.com/ubuntu|${APT_MIRROR}/ubuntu|g" \
                /etc/apt/sources.list.d/ubuntu.sources \
            ;; \
        *) \
            echo "Unsupported architecture: ${architecture}" >&2; \
            exit 1 \
            ;; \
    esac; \
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
        python-is-python3 \
        python3 \
        python3-pip \
        python3-venv \
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

# 系统级安装 NVM，并预装默认 Node.js 与 pnpm
RUN git clone --depth 1 --branch "v${NVM_VERSION}" \
        https://github.com/nvm-sh/nvm.git "${NVM_DIR}" \
    && chown -R byclaw:byclaw "${NVM_DIR}" \
    && . "${NVM_DIR}/nvm.sh" \
    && nvm install "${NODE_VERSION}" \
    && nvm alias default "${NODE_VERSION}" \
    && ln -s "${NVM_DIR}/versions/node/v${NODE_VERSION}" "${NVM_DIR}/current" \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && chown -R byclaw:byclaw "${NVM_DIR}"

# 登录 shell 自动加载 NVM；current/bin 让 docker exec 等非登录 shell 也能直接使用 Node
RUN printf '%s\n' \
        'export NVM_DIR="/opt/nvm"' \
        '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' \
        '[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"' \
        > /etc/profile.d/nvm.sh \
    && chmod 0644 /etc/profile.d/nvm.sh \
    && mkdir -p /workspace \
    && chown -R byclaw:byclaw /workspace

# 拉取 DSH 源码工作区；插件的 workspace:* 依赖必须在该 workspace 中解析
RUN rmdir /workspace \
    && git clone --depth 1 --branch "${DSH_REF}" "${DSH_REPOSITORY}" /workspace

# 将本项目维护的插件复制到 DSH 工作区
COPY --chown=byclaw:byclaw plugins/ /workspace/plugins/

WORKDIR /workspace

# 安装 DSH 与插件依赖，并构建运行所需产物
RUN pnpm install --no-frozen-lockfile \
    && pnpm run build \
    && pnpm --filter @byclaw/dsh-agent-teams run build \
    && pnpm --filter @byclaw/dsh-integration run build \
    && pnpm --filter @byclaw/dsh-better-sidebar run build \
    && pnpm --filter @byclaw/dsh-diff-viewer run build \
    && pnpm --filter @byclaw/dsh-codegraph run build

# 将全部 ByClaw 插件加入默认 web profile，并在构建时确认 bundle 已生效
RUN pnpm dsh plugin --profile web add \
        /workspace/plugins/agent-teams \
        /workspace/plugins/byclaw-integration \
        /workspace/plugins/dsh-trellis \
        /workspace/plugins/dsh-better-sidebar \
        /workspace/plugins/dsh-diff-viewer \
        /workspace/plugins/dsh-codegraph \
    && pnpm dsh --profile web --dump-config \
        | tee /tmp/dsh-web-config.yml \
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

COPY --chown=byclaw:byclaw docker-entrypoint.sh /usr/local/bin/byclaw-dsh-entrypoint
RUN chmod 0755 /usr/local/bin/byclaw-dsh-entrypoint \
    && chown -R byclaw:byclaw /workspace /home/byclaw/.dsh

USER byclaw

ENTRYPOINT ["/usr/local/bin/byclaw-dsh-entrypoint"]
CMD ["web"]
