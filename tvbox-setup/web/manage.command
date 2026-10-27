#!/bin/bash
# TVBox 网页版 — macOS 管理入口（双击运行）：重启 / 更新后重启，默认停在上一次的操作。
# 和 start.command 用同一个 Node：优先带 node:sqlite 的 22.13+（账号功能要用），其次 .tools/ 里的便携版，最后系统里的 18+。
cd "$(dirname "$0")" || exit 1
V=v22.16.0
sqlite_ok() { "$1" -e 'require("node:sqlite")' >/dev/null 2>&1; }
NODE=""; OLD=""
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  if sqlite_ok node; then NODE=node; else OLD=node; fi
fi
[ -z "$NODE" ] && [ -x .tools/node/bin/node ] && sqlite_ok .tools/node/bin/node && NODE=.tools/node/bin/node
[ -z "$NODE" ] && [ -n "$OLD" ] && NODE=$OLD
[ -z "$NODE" ] && [ -x .tools/node/bin/node ] && NODE=.tools/node/bin/node
if [ -z "$NODE" ]; then
  ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
  echo "第一次运行：下载便携版 Node.js $V（约 45MB），只放在 $(pwd)/.tools …"
  mkdir -p .tools
  curl -fL "https://npmmirror.com/mirrors/node/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz \
    || curl -fL "https://nodejs.org/dist/$V/node-$V-darwin-$ARCH.tar.gz" -o .tools/node.tgz \
    || { echo "下载失败，请手动安装 Node.js 22.13+：https://nodejs.org"; read -r -p "按回车退出"; exit 1; }
  rm -rf .tools/node && tar -xzf .tools/node.tgz -C .tools && mv ".tools/node-$V-darwin-$ARCH" .tools/node && rm -f .tools/node.tgz
  NODE=.tools/node/bin/node
fi
exec "$NODE" manage.js "$@"
