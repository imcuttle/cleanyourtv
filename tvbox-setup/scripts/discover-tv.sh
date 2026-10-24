#!/usr/bin/env bash
# Find an Android TV that already has wireless debugging on.
# Prints the adb serial on the last line. Usage: ./discover-tv.sh [ip[:port]]
set -uo pipefail

ip="${1:-}"

if [ -n "$ip" ]; then
  case "$ip" in *:*) ;; *) ip="$ip:5555" ;; esac
  adb connect "$ip" >/dev/null 2>&1
fi

# Anything already paired shows up here. Filter to TV-ish product names, but
# fall back to "whatever adb can see" so a phone-shaped TV still works.
serial="$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | head -1)"

if [ -z "$serial" ]; then
  cat >&2 <<'EOF'
No device. On the TV:
  Settings -> Device Preferences -> About -> tap "Build" 7 times
  back -> Developer options -> USB debugging on  (and Network/ADB debugging if present)
Then either plug in USB once and run `adb tcpip 5555`, or pass the TV's IP:
  ./discover-tv.sh 192.168.1.50
EOF
  exit 1
fi

{
  echo "serial:   $serial"
  echo "model:    $(adb -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
  echo "android:  $(adb -s "$serial" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
  player="$(adb -s "$serial" shell pm list packages com.fongmi.android.tv 2>/dev/null | tr -d '\r')"
  if [ -n "$player" ]; then
    echo "tvbox:    installed ($(adb -s "$serial" shell dumpsys package com.fongmi.android.tv 2>/dev/null | grep -m1 versionName | tr -d '\r '))"
  else
    echo "tvbox:    not installed"
  fi
} >&2

echo "$serial"
