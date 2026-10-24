#!/usr/bin/env bash
# Decide whether the TV is actually playing, without trusting the screenshot.
#
# Hardware decoding draws to an overlay that `screencap` renders black, so a black
# png means nothing. Two signals that do mean something:
#   - the video decoder is running (logcat)
#   - wlan0 is receiving at video bitrate (/proc/net/dev)
#
# Usage: ./verify-playback.sh <serial> [seconds]
set -uo pipefail

serial="${1:?usage: verify-playback.sh <serial> [seconds]}"
secs="${2:-4}"

echo "== decoder =="
dec="$(adb -s "$serial" logcat -d -t 400 2>/dev/null | grep -icE 'AmlogicVideoDecoder|MediaCodec|OMX|CCodec')"
if [ "$dec" -gt 0 ]; then
  echo "  active ($dec lines in the last 400)"
else
  echo "  idle  -> not decoding; playback is not happening"
fi

echo "== network =="
rate="$(adb -s "$serial" shell "
  a=\$(grep wlan0 /proc/net/dev | tr -s ' ' | cut -d' ' -f3)
  sleep $secs
  b=\$(grep wlan0 /proc/net/dev | tr -s ' ' | cut -d' ' -f3)
  echo \$(( (b-a)/$secs/1024 ))
" 2>/dev/null | tr -d '\r')"
echo "  ${rate:-0} KB/s in"

if [ "${rate:-0}" -gt 100 ]; then
  echo "  -> streaming"
elif [ "${rate:-0}" -gt 10 ]; then
  echo "  -> slow, probably stalling on a segment"
else
  echo "  -> nothing coming in; the URL is dead or blocked"
fi

echo "== screenshot (black is normal for video) =="
out="/tmp/tvbox-$(date +%H%M%S).png"
adb -s "$serial" exec-out screencap -p > "$out" 2>/dev/null
echo "  $out"
echo
echo "Verdict: decoder active + >100 KB/s = playing. A black png does not change that."
