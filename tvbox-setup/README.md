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
| 剪贴板 | ⌘/Ctrl+V anywhere → recognise sources in the text, confirm, add only new ones | banner when the clipboard has a link (system PasteButton, no prompt) |
| 历史 / 收藏 | 继续观看 with progress; delete one or clear all; 收藏 for 点播 and 直播 (hidden in 儿童) | same, under 我的 |
| 详情 | 分类 tag opens that category; 导演 / 演员 chips open their other works across all sources | same |
| 后台 | — | background audio, lock-screen controls, Picture-in-Picture when switching apps |
| 安全级别 | 儿童 · 标准 · 全部, per account (admin sets it; guests are 标准) | same |

### Web

```
web/start.command        # macOS — or start.bat on Windows
→ http://localhost:9988 and http://<this machine>:9988 for the rest of the LAN
```

**HTTPS.** `https://<host>:9988` works on the same port as http (the first byte of each connection tells TLS from plain HTTP;
set `HTTPS_PORT` to listen on a separate port instead, `TVBOX_HTTPS=0` turns it off).
Phones only expose the system share sheet (WeChat, Messages, …), Service Worker and clipboard APIs on https, so use this
address on the phone (the startup log prints it, with a QR code). With no certificate given it generates a self-signed one
with `openssl` into `web/data/tls/` (localhost, host name and LAN IPs; regenerated when the IPs change) — the browser warns once,
tap continue. For a warning-free setup point `TVBOX_TLS_CERT` / `TVBOX_TLS_KEY` at a real certificate. The origin differs
from http, so accounts and guest data are separate on the https address.

**Accounts, safety level and admin.** There is no access token: anyone who can reach the page opens it as a *guest* (safety level
「标准」, data kept in that browser). Register an account (user name + password) to keep history, progress, favourites and the
cover (竖版 / 横版 + size) setting on the server, per account, and to pick a level: 儿童 or 标准. The safety level belongs to the
account; only an admin account can use 「全部」 and only an admin can change anybody's level. The first start generates
`TVBOX_ADMIN_TOKEN` into `web/.env` (git-ignored) and prints it in the log: after registering, enter it in 设置 → 账号管理 to
turn that account into an admin (or use it on `/admin/` directly). Only admins can edit sources (点播源 / 直播源 / 导入 / 本地媒体,
and only while their own level is 「全部」) and see the 管理后台 at `/admin/` (users, sources, system). No parental PIN anymore.
Rotate the admin token: delete the line in `.env`, restart.

The server runs one worker per CPU core (`node:cluster`, set `WORKERS=n` to override); downloads,
config writes, ffmpeg and 豆瓣 rate-limiting live in one leader worker the others talk to over IPC.

Self-protection (`web/guard.js`): `node server.js` first starts a thin watcher that runs the real server as a child and restarts it
after a crash or when its heartbeat stops (backoff 1 s → 30 s). Inside, the primary watches the workers: a worker whose heartbeat
stops for 30 s is killed and restarted; a worker over its memory limit or whose event loop stays slow is replaced gracefully (the
new one starts first, the old one stops taking connections and finishes what it has), so users see no failed requests. Uncaught
errors are logged instead of killing a worker. `GET /api/health` shows the current memory / loop lag. Tunables (env or `.env`):
`TVBOX_MAX_RSS_MB` (default 20 % of RAM, 512–2048), `TVBOX_LAG_MS` (1500) and `TVBOX_LAG_WINDOWS` (4 × 5 s), `TVBOX_HANG_MS`
(30000), `TVBOX_MIN_LIFE_MS` (60000), `TVBOX_NO_SUPERVISOR=1` to run without the outer watcher.
Static files are held in memory pre-gzipped, JSON responses are gzipped, identical upstream requests
in flight are shared, and the stream relay drops its upstream fetch when the browser goes away. On
the page side every read belongs to the current view — switching pages aborts what is still pending,
so slow sources don't hold the browser's six connections. Cards are real links: ⌘/Ctrl-click opens a
title or channel in a new tab.

**Accounts (SQLite).** Settings → 账号管理 (or the avatar at the top right): register with a user name + password, stay signed in on
several accounts per device and switch with one tap (the page reloads on the new account). 观看历史 / 播放进度, 收藏, 直播收藏, the 沉浸
recommendation profile and recent searches belong to the account and are invisible to the others; sign in on another device and they
follow. Without an account the browser stays a 访客 exactly as before (data only in that browser); registering can carry the guest data
over. Passwords are scrypt-hashed, sessions are random tokens (stored hashed, one year rolling), logins are rate-limited; changing a
password signs the other devices out. Data is in `web/data/users.sqlite` (WAL, only the leader worker touches it; `node:sqlite`, no
dependency) and changes are batched from a persistent outbox, so offline / closing the tab loses nothing. `TVBOX_ALLOW_REGISTER=0`
closes registration. Needs **Node 22.13+** (`node:sqlite`); on older Node the feature switches itself off and the page behaves as a
guest. API: `/api/acct/{status,register,login,logout,me,sync,ops,import,clear,password,delete}` (session in `X-Session`).

**Player.** Full screen on a phone locks landscape for landscape videos (Android / Chrome: Fullscreen + Screen Orientation lock; iPhone
hands the video to the system player, which rotates by itself) and unlocks again on exit; the 沉浸 page's 全屏观看 button does it in
the same tap. Top right: one AirPlay-style 播放到 icon like iOS (on Safari/iOS it opens the system AirPlay picker, which lists TVs and Bluetooth headphones
together; elsewhere a single panel with 声音输出 — output device picker, Web Bluetooth scan, or how to connect in the system — and
电视 / 投屏 — Remote Playback on Chrome / Edge, otherwise copy the stream address / page
link). 更多 on a big screen holds 切换源; the 切换源 sheet tests every same-title source at once (`/api/speed?u=`: first byte + a
256 KB slice of the first segment) and shows signal bars, 畅通 / 良好 / 一般 / 较慢 / 不通 and the milliseconds, marks the fastest,
sorts the rest by network quality and keeps your position when you switch. In 沉浸 a swipe from the left / right screen edge outside
the bottom progress-bar zone is left to the system (back / close).

The launchers use the system Node.js (18+; 22.13+ if you want accounts — they prefer a Node that has `node:sqlite`) if there is one, otherwise download a portable
Node into `web/.tools/` (npmmirror first, nodejs.org as fallback). Nothing is installed
system-wide. On Windows, allow the firewall prompt for 专用网络 or other devices can't reach it.

State lives in `web/data/` (git-ignored): `sources.json`, `safety.json`, `users.sqlite`, `lives/` (live lists
edited as text), `downloads/`, `thumbs/`. Delete the folder to start over; the defaults come
from `config/vod-apps.json`.

Live covers and hover gifs are cut by **ffmpeg** when the server has it (PATH, `$FFMPEG`, or
`web/.tools/ffmpeg[.exe]`), cached 15 minutes and kept preview-sized: 320px JPEG covers (~8 KB),
240px / 6 fps / 2.5 s / 48-colour gifs (~130 KB). Without ffmpeg the browser plays a muted
mini-stream on hover and saves a frame as the cover, so it still fills in — just slower.

### iOS

```
ios/install.sh           # iPhone on USB, Developer Mode on
```

Generates the project with XcodeGen, builds, signs and installs with `devicectl`. With an
Apple ID in Xcode → Settings → Accounts it signs normally; without one it re-signs with any
development profile on this Mac that already covers the device. Free-account signatures
expire after 7 days — run it again.

### Clipboard → sources

Copy any text that has sources in it — 苹果CMS API URLs, m3u / txt links, raw stream URLs, a TVBox
config (URL or JSON), or a whole channel list — then press ⌘/Ctrl+V on the web page or tap the
banner on iOS. Each link is opened to see what it really is; names come from the text on the same
line. The confirm list marks what already exists, unchecks what doesn't answer, and adds the rest.
Loose stream URLs become one channel list. Browsers won't read the clipboard directly over plain
http on the LAN, so the web side relies on the paste event (or the box in 设置).

### Safety levels

- **儿童** — only sources marked 少儿 (the bundled ones whitelist cartoon categories), no 直播,
  no 豆瓣热门.
- **标准** (default) — hides sources marked 成人 and categories like 伦理 / 写真 / 福利.
- **全部** — no filtering.

Mark any source 少儿 or 成人 in 设置 (admins only). The level is per account, set at registration (儿童 / 标准) and changeable only by an admin in the 管理后台; only admin accounts can use 全部.

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
