#!/bin/bash
# TVBox 网页版 — macOS 一键启动（双击运行）。没有 Node.js 18+ 时自动下载便携版到 .tools/，不改系统。
cd "$(dirname "$0")" || exit 1
V=v22.11.0
NODE=""
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  NODE=node
elif [ -x .tools/node/bin/node ]; then
  NODE=.tools/node/bin/node
else
  ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
  echo "第一次运行：下载便携版 Node.js $V（约 45MB），只放在 $(pwd)/.tools …"
  mkdir -p .tools
  curl -fL "https://npmmirror.com/mirrors/node/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz \
    || curl -fL "https://nodejs.org/dist/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz \
    || { echo "下载失败，请手动安装 Node.js 18+：https://nodejs.org"; read -r -p "按回车退出"; exit 1; }
  rm -rf .tools/node && tar -xzf .tools/node.tgz -C .tools && mv ".tools/node-$V-darwin-$ARCH" .tools/node && rm -f .tools/node.tgz
  NODE=.tools/node/bin/node
fi
command -v ffmpeg >/dev/null 2>&1 || echo "提示：装了 ffmpeg（brew install ffmpeg）后，直播封面和悬停预览由服务端生成，更快。"
export PORT=${PORT:-9988}
(sleep 1.5; open "http://localhost:$PORT") &
exec "$NODE" server.js
