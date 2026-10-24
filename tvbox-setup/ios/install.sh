#!/bin/bash
# Build TVBox, sign it and install it on the iPhone (USB or same Wi-Fi). No server, no Mac needed afterwards.
#   install.sh          always rebuild + re-sign + install, then launch
#   install.sh --auto   only when the installed signature expires within RENEW_DAYS (used by the launchd job)
# Free Apple IDs sign for 7 days; schedule.sh runs --auto every few hours so the app never lapses.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v xcodegen >/dev/null || brew install xcodegen

AUTO=0; [ "${1:-}" = "--auto" ] && AUTO=1
RENEW_DAYS=${RENEW_DAYS:-3}
# Keep the bundle id the app was first installed under, so history / favorites / sources survive updates.
BID=${TVBOX_BUNDLE_ID:-com.moyuyc.WebDriverAgentRunner}
APP=build/Build/Products/Release-iphoneos/TVBox.app
STATE=build/last-install   # "<signature expiry epoch> <device id>"
LOG=build/xcodebuild.log
mkdir -p build

log() { echo "[$(date '+%F %T')] $*"; }
notify() { osascript -e "display notification \"$1\" with title \"TVBox 签名\"" >/dev/null 2>&1 || true; }
fail() { log "✗ $1"; notify "$1"; exit 1; }
expiry_of() {  # ExpirationDate of a .mobileprovision, as epoch seconds
  local d; d=$(security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null) || return 1
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$d" +%s
}

if [ $AUTO = 1 ] && [ -f "$STATE" ]; then
  read -r EXP _ < "$STATE"
  LEFT=$(( (EXP - $(date +%s)) / 86400 ))
  [ "$LEFT" -ge "$RENEW_DAYS" ] && { log "签名还剩 ${LEFT} 天，跳过"; exit 0; }
  log "签名还剩 ${LEFT} 天，开始续签"
fi

# USB shows "connected"; a paired phone on the same Wi-Fi shows "available (paired)".
DEV=$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone|iPad/ && !/unavailable/ && (/connected/ || /available/) {for(i=1;i<=NF;i++) if ($i ~ /^[0-9A-F-]{36}$/) {print $i; exit}}')
if [ -z "$DEV" ]; then
  [ $AUTO = 1 ] && { log "手机不在线（解锁并连同一 Wi-Fi），下次再试"; exit 0; }
  fail "没找到 iPhone：数据线连上并信任，或手机解锁并和 Mac 在同一 Wi-Fi"
fi
UDID=$(xcrun devicectl device info details --device "$DEV" 2>/dev/null | awk '/udid:/ {print $NF}')

xcodegen generate -q
rm -rf "$APP"
build() { xcodebuild -project TVBox.xcodeproj -scheme TVBox -configuration Release -destination generic/platform=iOS \
  -derivedDataPath build PRODUCT_BUNDLE_IDENTIFIER="$BID" "$@" build > "$LOG" 2>&1; }

# Xcode keeps reusing a local profile until it has actually expired, so set aside the ones about to lapse
# (put back if Xcode can't make a new one) to make it issue a fresh 7-day profile.
PROFILES=~/Library/Developer/Xcode/UserData/Provisioning\ Profiles
ASIDE=build/profiles-aside; rm -rf "$ASIDE"; mkdir -p "$ASIDE"
for f in "$PROFILES"/*.mobileprovision; do
  [ -f "$f" ] || continue
  security cms -D -i "$f" 2>/dev/null | grep -q "\.${BID}</string>" || continue
  [ "$(expiry_of "$f")" -lt $(( $(date +%s) + RENEW_DAYS * 86400 )) ] && mv "$f" "$ASIDE/"
done

# 1) Xcode is signed in to the Apple ID (Xcode → Settings → Accounts): it creates / renews the profile itself.
if build -allowProvisioningUpdates; then
  log "→ Xcode 自动签名（${BID}）"
else
  mv "$ASIDE"/*.mobileprovision "$PROFILES"/ 2>/dev/null || true
  grep -q "No Accounts" "$LOG" && log "⚠ Xcode 没有登录 Apple ID，无法续签新描述文件"
  # 2) Fallback: a still-valid team profile on this Mac that covers this device and bundle id.
  PROFILE=""; NOW=$(date +%s)
  for f in ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
    [ -f "$f" ] || continue
    P=$(security cms -D -i "$f" 2>/dev/null) || continue
    echo "$P" | grep -q "$UDID" || continue
    APPID=$(echo "$P" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)
    [ "${APPID#*.}" = "$BID" ] || continue
    [ "$(expiry_of "$f")" -gt "$NOW" ] || continue
    PROFILE="$f"; break
  done
  [ -n "$PROFILE" ] || fail "签名失败：Xcode → Settings → Accounts 登录 Apple ID 后重试（ios/build/xcodebuild.log）"
  log "→ 用现有描述文件手动签名（${BID}）"
  build CODE_SIGNING_ALLOWED=NO || fail "编译失败（ios/build/xcodebuild.log）"
  security cms -D -i "$PROFILE" > build/profile.plist
  plutil -extract Entitlements xml1 -o build/entitlements.plist build/profile.plist
  TEAM=$(plutil -extract TeamIdentifier.0 raw build/profile.plist)
  IDENTITY=$(security find-identity -v -p codesigning | awk -v t="$TEAM" '/Apple Development/ && $0 ~ t {print $2; exit}')
  [ -n "$IDENTITY" ] || IDENTITY=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
  cp "$PROFILE" "$APP/embedded.mobileprovision"
  codesign --force --sign "$IDENTITY" --entitlements build/entitlements.plist --timestamp=none "$APP"
fi

EXP=$(expiry_of "$APP/embedded.mobileprovision") || fail "App 里没有签名描述文件"
xcrun devicectl device install app --device "$DEV" "$APP" > build/devicectl.log 2>&1 \
  || fail "安装失败：手机锁屏或不在同一 Wi-Fi？（ios/build/devicectl.log）"
echo "$EXP $DEV" > "$STATE"
log "✓ 已安装 TVBox，签名有效至 $(date -r "$EXP" '+%F %H:%M')（还剩 $(( (EXP - $(date +%s)) / 86400 )) 天）"
if [ $AUTO = 1 ]; then
  notify "已自动续签，有效至 $(date -r "$EXP" '+%m-%d')"
else
  xcrun devicectl device process launch --device "$DEV" "$BID" >/dev/null 2>&1 || true
fi
