# The Bot's computer installs only the Playwright browser it launches.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM node:24.18.1-bookworm-slim AS node-toolchain
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun-toolchain

FROM ubuntu:24.04

# The Bun image digest pins the amd64/arm64 release bytes, including if its tag changes.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Ubuntu's primary mirror can serve a package index that disagrees with its own release file for
# hours ("File has unexpected size ... Mirror sync in progress?"), and then every build here fails.
# The Azure mirror is public and kept in step, so apt reads from it unless UBUNTU_MIRROR says
# otherwise (arm64 reads ports.ubuntu.com, which this leaves alone). Retries cover a dropped download.
ARG UBUNTU_MIRROR=http://azure.archive.ubuntu.com/ubuntu
RUN sed -i "s#http://archive.ubuntu.com/ubuntu/\?#${UBUNTU_MIRROR}/#; s#http://security.ubuntu.com/ubuntu/\?#${UBUNTU_MIRROR}/#" /etc/apt/sources.list.d/ubuntu.sources \
  && printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries
COPY --from=node-toolchain /usr/local /usr/local
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
# `--no-shell`: every launch names a Chromium channel (`browser-runtime.ts`), and Playwright runs
# the full build for a named channel even when headless, so the headless shell is never started. It
# was 340 MB unpacked and about 106 MB of every download. The bunx package cache goes too: Bun
# writes it under both BUN_INSTALL and the home directory, 35 MB the image never reads.
# git, python3 and ripgrep are a Bot's coding tools: cloning and diffing, the scripts and tests most
# projects run, and `computer_grep`, which uses rg when it is there and plain grep otherwise.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils git python3 ripgrep \
  && ln -s bun /usr/local/bin/bunx \
  && bunx --bun "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/* /var/lib/apt/lists/*

# 生成与读取文档的环境：员工在这台电脑上用 Python 写 Word、Excel、PPT、PDF，用 markitdown 把收到的
# PDF、Office 文件转成文字来读，用 pandoc 做 markdown 与 Word 互转。中文字体必须有：没有它，PDF 和
# PPT 里的中文是方块。Noto CJK 给排版和浏览器用；文泉驿微米黑是 TrueType 轮廓，reportlab 只能嵌这种。
# Python 库装在 /opt/xiongbao-docs，系统 python3 直接 import 得到（见 docker/docs-toolchain/install.sh）。
# 装完当场生成一遍各类文件再读回来（selfcheck.py），出不了中文就构建失败。LibreOffice 太大，只在单镜像里装。
COPY docker/docs-toolchain /opt/docs-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv fontconfig fonts-noto-cjk fonts-wqy-microhei pandoc \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
  && rm -rf /var/lib/apt/lists/* \
  && sh /opt/docs-toolchain/install.sh /opt/docs-toolchain/requirements.txt \
  && python3 /opt/docs-toolchain/selfcheck.py --require-pandoc \
  && rm -rf /root/.cache /tmp/*

# 外部编码员工（云电脑里只有 Claude Code，2026-11-19 拍板）：员工在自己的这台电脑里跑 Claude Code。ACP 适配器和它带的
# Claude Code 在构建时就装好，员工启动时不再 `npx -y` 下载任何东西。版本在 docker/acp-adapters/package.json 里钉到精确版本、
# 锁在 bun.lock：@agentclientprotocol/claude-agent-acp@0.107.0（自带 Claude Code）。Codex 不预装：Codex 员工只能在用户自己
# 配对的电脑上跑（runtime 为 device）。Claude Code 是专有许可，用户已知晓并决定预装（规格 §8.2）。
# 要换版本，改 package.json、重生成 bun.lock，并同步 runner/src/acp/manifest.ts 的 ACP_MANIFEST。
# 装完当场跑一遍，装不全或版本不对就构建失败。体积约 0.43 GB（Claude Code 约 350 MB，其余是依赖）。
# 独立成一步，放在会常变的源码拷贝之前，改源码不会重装这一层。装进 /opt/xiongbao-acp，不碰系统的 node 和 bun。
WORKDIR /opt/xiongbao-acp
COPY docker/acp-adapters/package.json docker/acp-adapters/bun.lock ./
RUN bun install --frozen-lockfile --production \
  && test "$(node node_modules/.bin/claude-agent-acp --version)" = "0.107.0" \
  && rm -rf /root/.cache /root/.bun /usr/local/install/cache /tmp/*
ENV XIONGBAO_ACP_ADAPTERS_DIR=/opt/xiongbao-acp
# Where the agents' own state and the adapters' start folder live (acp-cloud.ts). Not the workspace: that is the
# employee's own folder, and nothing of the agents' belongs in its files.
ENV XIONGBAO_ACP_STATE_DIR=/var/lib/xiongbao-acp
RUN mkdir -p /var/lib/xiongbao-acp

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY agent-computer/src ./src
# index.ts imports ../../shared/file-download at runtime (shared/computer-control is type-only and
# erased), and the Bot's browser routes import ../../shared/xiongbao-browser and ../../shared/bot-browser,
# so the files they need go where those paths resolve from /app/src.
COPY shared/file-download.ts shared/env-aliases.ts shared/apply-env-aliases.ts /shared/
# A Bot's browser's contract, and the tab and address requests it shares, which its routes check
# requests against. They import zod, and a module resolves its imports from its own directory upward, which
# from /shared never reaches /app/node_modules: so /shared is given that tree to resolve from, rather
# than a second install.
COPY shared/xiongbao-browser.ts shared/bot-browser.ts /shared/
# The header names the server sends and src/wire-headers.ts reads (both sides take them from here).
COPY shared/wire-headers.ts /shared/
RUN ln -s /app/node_modules /shared/node_modules

# The external employees' host (src/acp-cloud.ts): the runner's own ACP host, which an owner's machine runs too.
# It reaches only its own folder (runner/src/acp: the host, the client, the launch manifest, the path facts, the
# login PATH, discovery), the transport the client is built on (mcp-client.ts and the bundled-runtime.ts it
# starts children with), the idle time (idle.ts, alone in a file so the MCP bridge does not come with it), and
# shared/acp.ts. A module resolves its imports from its own directory, so they go where `../../runner/...` and
# `../../shared/...` resolve from /app/src.
COPY runner/src/acp /runner/src/acp
COPY runner/src/idle.ts runner/src/mcp-client.ts runner/src/bundled-runtime.ts /runner/src/
COPY shared/acp.ts /shared/

# The X server's socket directory and the keysym names its keyboard data needs, as the root Dockerfile
# has them: Xvfb as any user but root refuses to make the first, and xkbcomp warns at every start
# without the second. See docker/x11/XKeysymDB.
RUN install -d -m 1777 /tmp/.X11-unix
COPY docker/x11/XKeysymDB /usr/share/X11/XKeysymDB

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
