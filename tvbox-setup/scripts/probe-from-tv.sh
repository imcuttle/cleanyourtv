#!/usr/bin/env bash
# Probe URLs FROM the TV, not from your laptop.
#
# Why: the dev machine is usually behind a VPN and will happily fetch sources the TV
# can never reach. This asks the TV instead, using toybox nc because Android has no curl.
#
# http:// only — plain nc cannot do TLS. For an https source, check the host's TCP port
# and then confirm playback on the TV itself.
#
# Usage: ./probe-from-tv.sh <serial> url [url ...]
#        ./probe-from-tv.sh <serial> -f urls.txt
set -uo pipefail

serial="${1:?usage: probe-from-tv.sh <serial> <url| -f file> ...}"
shift

urls=()
if [ "${1:-}" = "-f" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && urls+=("$line")
  done < "${2:?missing file}"
else
  urls=("$@")
fi

[ "${#urls[@]}" -gt 0 ] || { echo "no urls" >&2; exit 1; }

ok=0; bad=0; skip=0
for url in "${urls[@]}"; do
  case "$url" in
    http://*) ;;
    https://*) printf 'SKIP  %s  (tls, nc cannot)\n' "$url"; skip=$((skip+1)); continue ;;
    *) printf 'SKIP  %s  (not a url)\n' "$url"; skip=$((skip+1)); continue ;;
  esac

  rest="${url#http://}"
  hostport="${rest%%/*}"
  path="/${rest#*/}"
  case "$hostport" in
    *:*) host="${hostport%:*}"; port="${hostport##*:}" ;;
    *)   host="$hostport";       port=80 ;;
  esac

  # On-device: raw HTTP/1.0 GET, 8s budget, first 200 bytes is plenty to tell
  # "playlist" from "404 page" from "nothing at all".
  out="$(adb -s "$serial" shell \
    "printf 'GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: okhttp/3.12.0\r\n\r\n' '$path' '$hostport' | toybox nc -w 8 '$host' '$port' 2>/dev/null | head -c 200" \
    2>/dev/null | tr -d '\r')"

  if printf '%s' "$out" | grep -q '200'; then
    if printf '%s' "$out" | grep -q 'EXTM3U'; then
      printf 'OK    %s\n' "$url"; ok=$((ok+1))
    else
      printf 'HTTP  %s  (200 but not a playlist)\n' "$url"; bad=$((bad+1))
    fi
  elif [ -z "$out" ]; then
    printf 'DEAD  %s  (no reply — unreachable from this TV)\n' "$url"; bad=$((bad+1))
  else
    printf 'FAIL  %s  %s\n' "$url" "$(printf '%s' "$out" | head -1)"; bad=$((bad+1))
  fi
done

printf '\n%d ok, %d bad, %d skipped\n' "$ok" "$bad" "$skip"
