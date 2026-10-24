#!/bin/bash
# Keep TVBox signed forever: a launchd job runs `install.sh --auto` every 4 hours (and at login).
# It does nothing until the signature has < 3 days left, then re-signs and installs over Wi-Fi / USB.
#   schedule.sh            install / refresh the job
#   schedule.sh --remove   remove it
#   schedule.sh --status   show the job and the last log lines
set -euo pipefail
cd "$(dirname "$0")"
LABEL=com.moyuyc.tvbox.resign
PLIST=~/Library/LaunchAgents/$LABEL.plist
LOGF=~/Library/Logs/tvbox-resign.log

case "${1:-}" in
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "✓ 已移除自动续签"; exit 0 ;;
  --status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|run interval" || echo "未安装"
    [ -f build/last-install ] && { read -r EXP _ < build/last-install; echo "当前签名有效至 $(date -r "$EXP" '+%F %H:%M')"; }
    echo "--- $LOGF"; tail -n 8 "$LOGF" 2>/dev/null || true; exit 0 ;;
esac

mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PWD/install.sh</string><string>--auto</string></array>
  <key>StartInterval</key><integer>14400</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGF</string>
  <key>StandardErrorPath</key><string>$LOGF</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ 自动续签已开启：每 4 小时检查一次，剩不到 3 天就重签并安装（日志 ${LOGF}）"
