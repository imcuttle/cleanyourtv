# TVBox setup

CleanYourTV gets the ads off the TV. This puts something back on it: **TVBox** — live
channels plus on-demand — installed over ADB, configured from your laptop, with the
configs copied onto the TV so they keep working after the source URLs die.

No root. Nothing uninstalled. The stock launcher stays.

```
laptop ──adb──▶ TV ──▶ com.fongmi.android.tv
                        └── /sdcard/TV/   configs, offline
```

## Quick start

```bash
# 1. find the TV (USB debugging already on)
./scripts/discover-tv.sh

# 2. install the player
adb -s "$SERIAL" install -r TVBox-5.7.9.apk

# 3. copy configs on, and point the app at them
./scripts/push-config.sh "$SERIAL"
#    点播 → file://TV/vod.json
#    直播 → file://TV/live.txt      (type these in 设置, see SKILL.md §3)

# 4. prove it plays (screenshots lie — see SKILL.md §5)
./scripts/verify-playback.sh "$SERIAL"
```

## Same sources on other screens

The TV runs FongMi TVBox. For everything that isn't an Android TV there are two more
front-ends over the same 苹果CMS sources and live lists — both Netflix-style, both with
every source editable in the app rather than baked in.

| | Web (B/S) — `web/` | iPhone / iPad — `ios/` |
|---|---|---|
| Runs as | one Node process, zero npm deps; any browser on the LAN | native SwiftUI app, talks to the sites directly — no server |
| Start | `web/start.bat` (Windows) · `web/start.command` (macOS), double-click | `ios/install.sh` with the phone on USB |
| 点播 | home rows, hero, 分类, search across **all** sources, 换源, 继续观看 | same |
| 豆瓣 | rating on every poster + detail, 热门剧集 / 热门电影 rows | same |
| 直播 | m3u / m3u8 lists, TVBox txt, single .m3u8; cover per channel, hover = 3 s live gif | same; long-press = muted live preview |
| 下载 | on the server (AES-128 decrypted), playable by every device on the LAN, export as one file | on the device (AVAssetDownloadTask), offline playback |
| 源 | edit / reorder / 测速 (点播 + 直播, one click) / import a TVBox config URL / edit a live list as text | same |
| 安全级别 | 儿童 · 标准 · 全部, optional parent PIN | same |

### Web

```
web/start.command        # macOS — or start.bat on Windows
→ http://localhost:9988 and http://<this machine>:9988 for the rest of the LAN
```

The launchers use the system Node.js 18+ if there is one, otherwise download a portable
Node into `web/.tools/` (npmmirror first, nodejs.org as fallback). Nothing is installed
system-wide. On Windows, allow the firewall prompt for 专用网络 or other devices can't reach it.

State lives in `web/data/` (git-ignored): `sources.json`, `safety.json`, `lives/` (live lists
edited as text), `downloads/`, `thumbs/`. Delete the folder to start over; the defaults come
from `config/vod-apps.json`.

Live covers and hover gifs are cut by **ffmpeg** when the server has it (PATH, `$FFMPEG`, or
`web/.tools/ffmpeg[.exe]`), cached 15 minutes. Without ffmpeg the browser plays a muted
mini-stream on hover and saves a frame as the cover, so it still fills in — just slower.

### iOS

```
ios/install.sh           # iPhone on USB, Developer Mode on
```

Generates the project with XcodeGen, builds, signs and installs with `devicectl`. With an
Apple ID in Xcode → Settings → Accounts it signs normally; without one it re-signs with any
development profile on this Mac that already covers the device. Free-account signatures
expire after 7 days — run it again.

### Safety levels

- **儿童** — only sources marked 少儿 (the bundled ones whitelist cartoon categories), no 直播,
  no 豆瓣热门.
- **标准** (default) — hides sources marked 成人 and categories like 伦理 / 写真 / 福利.
- **全部** — no filtering.

Mark any source 少儿 or 成人 in 设置. Set a PIN and both the level and the source list need it.

## What is in here

| Path | What |
|---|---|
| `SKILL.md` | The whole procedure, written as an agent skill. Start here if you are an assistant. |
| `config/vod-5-direct.json` | **Use this one on the TV.** Five 苹果CMS sites with direct APIs — no spider jar, no 解析. All five list and play. |
| `config/vod-apps.json` | Default sources for web + iOS: eleven 苹果CMS sites (direct m3u8, checked 2026-10-24) plus three 少儿 views, and the two live lists. |
| `config/vod-xhz-54sites.json` | A 54-site spider-config. Loads, but most sites can't produce a playable URL. Kept as a reference for the shape, not as a daily driver. |
| `config/live-cn-466.txt` | 466-channel 直播 list in TVBox `.txt` format with groups. |
| `sources.md` | Where sources come from, and which ones answered — with the date. |
| `scripts/` | discover / push / probe / verify. |
| `shots/` | What it looks like when it works. |
| `web/` | Browser front-end + LAN server. |
| `ios/` | iPhone / iPad app. |

## The three things that cost the most time

1. **Test reachability from the TV, not your laptop.** If your laptop is on a VPN it will
   fetch sources the TV can never reach. `scripts/probe-from-tv.sh` runs the probe on the
   device.
2. **A black screenshot is not a failed stream.** Hardware video decoding draws to an
   overlay `screencap` cannot see. Check the decoder and the rx rate instead.
3. **Don't type `http://` into the address dialog.** It expands the first character and
   you get `http://ttp://…`. Type the bare host and let it prepend the scheme.

Everything else, including the error-message decoder ring, is in `SKILL.md`.

## Removing it

```bash
adb -s "$SERIAL" uninstall com.fongmi.android.tv
```

Nothing else was touched, so that is the whole rollback. If you also want the configs
gone: `adb shell rm -rf /sdcard/TV`.
