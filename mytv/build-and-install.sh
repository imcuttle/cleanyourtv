#!/usr/bin/env bash
# 重新编译并安装新桌面（改了 launcher/app/src/main/res/values/config.xml 后运行）。
# 注意：本机型只认白名单包名 com.ts.launcher，且必须保留小米桌面 com.mitv.tvhome 启用。
set -euo pipefail
cd "$(dirname "$0")/.."
export TV_HOST="${TV_HOST:-192.168.5.49}"
export JAVA_HOME="$PWD/.toolchain/jdk-17.0.20.1+1/Contents/Home" ANDROID_HOME="$PWD/.toolchain/sdk"
(cd launcher && ./gradlew assembleRelease -PlauncherApplicationId=com.ts.launcher -q --console=plain)
t(){ tools/venv/bin/python -I tools/tv.py "$1"; }
tools/venv/bin/python -I tools/b64push.py launcher/app/build/outputs/apk/release/app-release.apk /data/local/tmp/tvhome.apk
t 'pm install -r /data/local/tmp/tvhome.apk; rm -f /data/local/tmp/tvhome.apk'
t 'cmd package set-home-activity --user 0 com.ts.launcher/com.gathin.tvhome.MainActivity'
t 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME' | tail -1
