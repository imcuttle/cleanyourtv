#!/bin/bash
# Build TVBox for the USB-connected iPhone and install it. No server, no Mac needed afterwards.
set -euo pipefail
cd "$(dirname "$0")"
command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate -q

DEV=$(xcrun devicectl list devices 2>/dev/null | awk '/connected/ && /iPhone|iPad/ {for(i=1;i<=NF;i++) if ($i ~ /^[0-9A-F-]{36}$/) {print $i; exit}}')
[ -n "$DEV" ] || { echo "没找到已连接的 iPhone（数据线连上并信任这台电脑）"; exit 1; }
UDID=$(xcrun devicectl device info details --device "$DEV" 2>/dev/null | awk '/udid:/ {print $NF}')

build() { xcodebuild -project TVBox.xcodeproj -scheme TVBox -configuration Release \
  -destination "id=$UDID" -derivedDataPath build -allowProvisioningUpdates "$@" build | grep -E "error:|BUILD" ; }

# 1) Normal path: Xcode has an Apple ID signed in (Xcode → Settings → Accounts).
if ! build >/dev/null 2>&1; then
  # 2) Fallback: reuse any existing team profile already on this Mac that covers this device.
  PROFILE=""
  for f in ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
    [ -f "$f" ] || continue
    P=$(security cms -D -i "$f" 2>/dev/null) || continue
    echo "$P" | grep -q "$UDID" || continue
    APPID=$(echo "$P" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)
    case "$APPID" in *.xctrunner|*\*) continue;; esac
    PROFILE="$f"; BID=${APPID#*.}; break
  done
  [ -n "$PROFILE" ] || { echo "没有可用签名：打开 Xcode → Settings → Accounts 登录 Apple ID 后重试"; exit 1; }
  echo "→ 用现有描述文件手动签名（bundle id: ${BID}）"
  build CODE_SIGNING_ALLOWED=NO PRODUCT_BUNDLE_IDENTIFIER="$BID"
  APP=build/Build/Products/Release-iphoneos/TVBox.app
  security cms -D -i "$PROFILE" > build/profile.plist
  plutil -extract Entitlements xml1 -o build/entitlements.plist build/profile.plist
  TEAM=$(plutil -extract TeamIdentifier.0 raw build/profile.plist)
  IDENTITY=$(security find-identity -v -p codesigning | awk -v t="$TEAM" '/Apple Development/ && $0 ~ t {print $2; exit}')
  [ -n "$IDENTITY" ] || IDENTITY=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
  cp "$PROFILE" "$APP/embedded.mobileprovision"
  codesign --force --sign "$IDENTITY" --entitlements build/entitlements.plist --timestamp=none "$APP"
fi

APP=build/Build/Products/Release-iphoneos/TVBox.app
xcrun devicectl device install app --device "$DEV" "$APP" | tail -2
BID=$(plutil -extract CFBundleIdentifier raw "$APP/Info.plist")
xcrun devicectl device process launch --device "$DEV" "$BID" >/dev/null && echo "✓ 已安装并启动 TVBox"
