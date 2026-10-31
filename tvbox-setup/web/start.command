#!/bin/bash
# TVBox 网页版 — macOS 一键启动（双击运行）。优先用带 node:sqlite 的 Node.js 22.13+（账号功能要用）；
# 没有就自动下载便携版到 .tools/，不改系统。系统里只有 Node 18 / 20 时仍然能用，只是账号功能是关的。
cd "$(dirname "$0")" || exit 1
V=v22.16.0
sqlite_ok() { "$1" -e 'require("node:sqlite")' >/dev/null 2>&1; }
NODE=""; OLD=""
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  if sqlite_ok node; then NODE=node; else OLD=node; fi
fi
[ -z "$NODE" ] && [ -x .tools/node/bin/node ] && sqlite_ok .tools/node/bin/node && NODE=.tools/node/bin/node
if [ -z "$NODE" ]; then
  ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
  echo "下载便携版 Node.js $V（约 45MB，账号功能需要 22.13+），只放在 $(pwd)/.tools …"
  mkdir -p .tools
  if curl -fL "https://npmmirror.com/mirrors/node/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz \
    || curl -fL "https://nodejs.org/dist/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz; then
    rm -rf .tools/node && tar -xzf .tools/node.tgz -C .tools && mv ".tools/node-$V-darwin-$ARCH" .tools/node && rm -f .tools/node.tgz
    NODE=.tools/node/bin/node
  elif [ -n "$OLD" ]; then
    echo "下载失败，先用系统的 Node.js（账号功能不可用，升级到 Node 22.13+ 后重启即可）。"
    NODE=$OLD
  else
    echo "下载失败，请手动安装 Node.js 22.13+：https://nodejs.org"; read -r -p "按回车退出"; exit 1
  fi
fi
command -v ffmpeg >/dev/null 2>&1 || echo "提示：装了 ffmpeg（brew install ffmpeg）后，直播封面和悬停预览由服务端生成，更快。"
# 没有访问令牌，打开网页不需要口令。管理员令牌第一次启动由 server.js 在 .env 里生成 TVBOX_ADMIN_TOKEN，并在这个窗口里打印。
export PORT=${PORT:-9988}
(sleep 1.5; open "http://localhost:$PORT") &
exec "$NODE" server.js
