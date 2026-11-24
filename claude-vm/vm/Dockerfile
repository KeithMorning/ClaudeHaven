FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH

# 国内 apt 镜像（加速；如需官方源可删掉这一行）
RUN sed -i -E 's@https?://(archive|security)\.ubuntu\.com@http://mirrors.ustc.edu.cn@g' /etc/apt/sources.list

# 基础桌面 + VNC + noVNC + 工具
#
# 关于字体：这里**故意不装** fonts-noto-cjk。
#   · 体积：光那一个包就有 200MB+，占了安装包很大一块；
#   · 观感：之前终端用 Noto Sans Mono CJK 当等宽字体，会给每个字符按全角算格子，
#           英文被撑成「一字符一格」的服务器控制台样子，根本没法读。
#   现在统一用 Fira Code（拉丁等宽，无连字陷阱）+ 系统自带 DejaVu 做界面字体。
RUN apt-get update && apt-get install -y --no-install-recommends \
    locales tzdata \
    openbox tint2 feh xterm x11-xserver-utils xauth \
    python3-gi gir1.2-vte-2.91 \
    tigervnc-standalone-server tigervnc-common tigervnc-tools \
    novnc websockify xz-utils \
    fonts-firacode fonts-jetbrains-mono fonts-symbola fonts-noto-color-emoji fonts-dejavu-core \
    git curl wget aria2 ca-certificates gnupg sudo dbus-x11 \
    openssh-client netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# 区域语言环境（en_US 必装；其余供地区预设使用）
RUN sed -i -E 's/^# *((en_US|en_GB|ja_JP|de_DE)\.UTF-8)/\1/' /etc/locale.gen \
    && locale-gen

# WSL 运行配置（导入为 WSL 发行版时自动挂载 Windows 盘符，供工作区使用）
RUN printf '[automount]\nenabled = true\nroot = /mnt/\noptions = "metadata,umask=22,fmask=11"\n\n[interop]\nenabled = true\nappendWindowsPath = false\n' > /etc/wsl.conf

# Node.js 20（npmmirror 国内镜像，避免 nodesource 慢）
RUN set -eu; \
    case "$TARGETARCH" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac; \
    node_dist="node-v20.18.1-linux-$node_arch"; \
    aria2c -x8 -s8 -q -d /tmp -o node.tar.xz "https://npmmirror.com/mirrors/node/v20.18.1/$node_dist.tar.xz" \
    && mkdir -p /usr/local/lib/nodejs \
    && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
    && ln -sf "/usr/local/lib/nodejs/$node_dist/bin/node" /usr/local/bin/node \
    && ln -sf "/usr/local/lib/nodejs/$node_dist/bin/npm" /usr/local/bin/npm \
    && ln -sf "/usr/local/lib/nodejs/$node_dist/bin/npx" /usr/local/bin/npx \
    && rm -f /tmp/node.tar.xz \
    && test "$(node -p 'process.arch')" = "$node_arch" && npm -v

# Google Chrome（真实 UA，用于容器内 claude.ai 登录）
RUN aria2c -x16 -s16 -k1M -q -d /tmp -o chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_${TARGETARCH}.deb" \
    && test "$(dpkg-deb -f /tmp/chrome.deb Architecture)" = "$TARGETARCH" \
    && apt-get update \
    && apt-get install -y /tmp/chrome.deb \
    && google-chrome-stable --version \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI（官方包，走 npmmirror 镜像）
# 装完立刻清干净：npm 更新失败会留下 @anthropic-ai/.claude-code-XXXXXXXX 暂存目录，
# node 头文件和 npm 缓存同样只在构建时有用。
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @anthropic-ai/claude-code \
    && claude_bin="$(npm prefix -g)/bin/claude" \
    && if [ "$claude_bin" != /usr/local/bin/claude ]; then ln -sf "$claude_bin" /usr/local/bin/claude; fi \
    && claude --version \
    && rm -rf /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/.claude-code-* \
    && rm -rf /usr/local/lib/nodejs/*/include \
    && npm cache clean --force \
    && rm -rf /root/.npm /root/.cache \
    && rm -rf /usr/share/doc/*

# ---------------------------------------------------------------------------
# 模块一：容器内自带代理内核（mihomo）+ TUN 全局接管
#   · 内核随镜像运行，宿主 Clash 只是「导入/编辑 YAML」的辅助工具，运行时不依赖它。
#   · GeoIP/GeoSite 必须预置：TUN 模式下 DNS 会指向内核自己（127.0.0.1:53），
#     若启动时才去下载 MMDB，就会撞上「DNS 已指向自己但还没监听」的死锁
#     （2026-11-16 spike 实测踩到：can't download MMDB: dns resolve failed）。
#   · iproute2 只为排障方便；实际加 /32 主机路由复用 net-guard.py 的 AF_NETLINK。
#   · 内核二进制按 Buildx 提供的目标架构选择。
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends gzip iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in amd64) A=amd64-compatible ;; arm64) A=arm64 ;; *) exit 1 ;; esac; \
    V=v1.19.34; \
    aria2c -x8 -s8 -q -d /tmp -o mihomo.gz \
      "https://github.com/MetaCubeX/mihomo/releases/download/$V/mihomo-linux-$A-$V.gz"; \
    gzip -dc /tmp/mihomo.gz > /usr/local/bin/mihomo; \
    rm -f /tmp/mihomo.gz; \
    chmod 755 /usr/local/bin/mihomo; \
    mkdir -p /opt/mihomo; \
    aria2c -x8 -s8 -q -d /opt/mihomo -o geoip.metadb \
      "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb"; \
    aria2c -x8 -s8 -q -d /opt/mihomo -o geosite.dat \
      "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat" || true; \
    ls -lh /usr/local/bin/mihomo /opt/mihomo/

# 脚本与桌面资源（主题 / 启动器 / 串流页面 / 欢迎页）
COPY scripts/ /opt/scripts/
COPY config/ /opt/config/
COPY assets/wallpaper/claude-haven.png /opt/wall/source.png
COPY config/themes/Claude /usr/share/themes/Claude
RUN chmod +x /opt/scripts/*.sh \
    && cp /opt/config/apps/*.desktop /usr/share/applications/ 2>/dev/null || true

# 默认区域（运行时可被 -e / wsl env 覆盖）
ENV TZ=America/New_York
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US:en

EXPOSE 6080 5901 7890
ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
