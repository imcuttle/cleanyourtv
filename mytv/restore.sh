#!/usr/bin/env bash
# 一键恢复：重新启用所有被停用的包，把主页还给小米桌面，开机广告开关复原。
set -euo pipefail
cd "$(dirname "$0")/.."
export TV_HOST="${TV_HOST:-192.168.5.49}"
t(){ tools/venv/bin/python -I tools/tv.py "$1"; }
grep -vE '^[[:space:]]*(#|$)' mytv/debloat.txt | awk '{print $1}' | while read -r p; do t "pm enable --user 0 $p"; done
t 'cmd package set-home-activity --user 0 com.mitv.tvhome/.MainActivityUserMode'
t 'settings delete system boot_ad_switch'
t 'input keyevent KEYCODE_HOME'
echo "已恢复。新桌面仍安装着，不要可在 设置→应用 里卸载 com.ts.launcher"
