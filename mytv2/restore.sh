#!/bin/sh
# Undo the MiTV3S-43 debloat: unblock every package in debloat.txt and reset animation speed.
cd "$(dirname "$0")/.." || exit 1
export TV_HOST="${TV_HOST:-192.168.5.55}"
for p in $(grep -v '^#' mytv2/debloat.txt); do
  tools/venv/bin/python -I tools/tv.py "pm unblock $p"
done
for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  tools/venv/bin/python -I tools/tv.py "settings put global $k 1"
done
