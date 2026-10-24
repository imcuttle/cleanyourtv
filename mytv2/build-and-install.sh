#!/usr/bin/env bash
# 重新编译并安装 Android 4.4 简洁桌面（launcher-lite）。安装时电视会弹「安装确认」，脚本会自动按确定。
set -euo pipefail
cd "$(dirname "$0")/.."
export TV_HOST="${TV_HOST:-192.168.5.55}"
export JAVA_HOME="$PWD/.toolchain/jdk-17.0.20.1+1/Contents/Home" ANDROID_HOME="$PWD/.toolchain/sdk"
(cd launcher-lite && ./gradlew assembleRelease -q --console=plain)
t(){ tools/venv/bin/python -I tools/tv.py "$@"; }
t --push launcher-lite/app/build/outputs/apk/release/app-release.apk /data/local/tmp/lite.apk
t 'pm install -r /data/local/tmp/lite.apk' &
sleep 12; t 'input keyevent 23'; wait
t 'rm -f /data/local/tmp/lite.apk; input keyevent 3'
