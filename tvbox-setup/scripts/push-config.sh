#!/usr/bin/env bash
# Copy the configs onto the TV and print what to type into 设置.
# Usage: ./push-config.sh <serial> [vod.json] [live.txt]
set -euo pipefail

serial="${1:?usage: push-config.sh <serial> [vod.json] [live.txt]}"
here="$(cd "$(dirname "$0")/.." && pwd)"
vod="${2:-$here/config/vod-xhz-54sites.json}"
live="${3:-$here/config/live-cn-466.txt}"

adb -s "$serial" shell mkdir -p /sdcard/TV

# Keep whatever is there now, so a bad config is one pull away from undone.
stamp="$(date +%Y%m%d-%H%M%S)"
if adb -s "$serial" shell ls /sdcard/TV/vod.json >/dev/null 2>&1; then
  adb -s "$serial" shell "cp /sdcard/TV/vod.json /sdcard/TV/vod.json.bak-$stamp" 2>/dev/null || true
fi

adb -s "$serial" push "$vod"  /sdcard/TV/vod.json  >/dev/null
adb -s "$serial" push "$live" /sdcard/TV/live.txt >/dev/null

echo "pushed:"
adb -s "$serial" shell ls -l /sdcard/TV/vod.json /sdcard/TV/live.txt | tr -d '\r'

cat <<'EOF'

Now in TVBox 设置, type these WITHOUT the scheme prefix:
  the app prepends http:// on its own, and typing it duplicates the text.

  点播   f  ->  ile://TV/vod.json        (type "f", let it expand, then append)
  直播   f  ->  ile://TV/live.txt

Clear the field first (40x KEYCODE_DEL) or the old URL stays in front.
Restart the app afterwards:  adb shell am force-stop com.fongmi.android.tv
EOF
