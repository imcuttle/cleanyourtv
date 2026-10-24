# Sources

Free Chinese TV sources rot. This file is a snapshot, not a directory — every row says
**when** it was checked and **from where**, because the two disagree often enough to
matter.

Checked **2026-10-24**. `laptop` = from a machine on a VPN; `tv` = from the TV itself,
which is the only one that counts.

## Formats

| Shape | Looks like | Used for |
|---|---|---|
| Multi-warehouse | `{"urls":[{"name":"…","url":"…"}, …]}` | 点播. One address, many configs, falls back when one dies. |
| Single-file config | `{"sites":[…],"parses":[…],"spider":"…jar","lives":[…]}` | 点播. Predictable, small, keep offline. |
| `.m3u` | `#EXTM3U` + `#EXTINF` | 直播. Carries logos and EPG. |
| `.txt` | `名称,url` with `#genre#` group lines | 直播. No logos, parses anywhere. |

## 点播 — what actually plays

The short version, after a day of testing: **spider-based sites die, plain JSON APIs survive.**

A site entry with `"type": 1` and a direct `api` (`https://host/api.php/provide/vod`) is a
苹果CMS source. It returns a list, a detail and a **direct m3u8** — no spider jar, no 解析
service, nothing else that can rot. A `"type": 3` site with `api: "csp_Whatever"` depends on a
spider jar plus, usually, a web 解析 to turn a video page into a stream. When either link
breaks you get a grid that loads and a detail page that says `这里什么都没有 👀`.

Verified from the TV on 2026-10-24, all five listing **and playing** (183–288 KB/s, hardware
decoder running):

| Site | API | Note |
|---|---|---|
| 暴风 | `https://bfzyapi.com/api.php/provide/vod` | Line name `bfzym3u8`, direct m3u8. The one to keep. |
| 索尼 | `https://suoniapi.com/api.php/provide/vod` | |
| 量子 | `https://cj.lziapi.com/api.php/provide/vod` | |
| 非凡 | `http://cj.ffzyapi.com/api.php/provide/vod` | plain http |
| 海外看 | `https://haiwaikan.com/api.php/provide/vod` | |
| 快帆 | `https://api.kuaifan.tv/api.php/provide/vod` | **dead** from this network |

`config/vod-5-direct.json` is exactly this list, 暴风 first, no spider, no 解析. That is the
config to ship.

What failed, and why it matters:

| Symptom | Real cause |
|---|---|
| grid loads, detail says `这里什么都没有` | the spider site's detail API returns nothing — the site is broken, not your config |
| `播放地址解析失败` on every line | the site's play page needs a web 解析 and all six in the config (777 / jsonplayer / xmflv / 剖云 / Web聚合 / Json聚合) are dead |
| site list opens at the bottom / only 兒童, 高中… | TVBox reopens the picker at the *last used* site. A config ending in B站 edu sites (少儿/小学/初中/高中/戏曲) drops you somewhere empty. Keep working sites first. |
| everything empty right after `pm clear` | `pm clear` revokes storage permission. `file://TV/...` then reads nothing. Re-grant: `pm grant com.fongmi.android.tv android.RESOURCE…STORAGE` — see the note at the bottom. |

## 点播 — multi-warehouse

| Address | laptop | tv | Note |
|---|---|---|---|
| `http://xhztv.top/dc/` | ok | — | 小盒子 多仓. Resolves to a warehouse list, picked as the daily driver. |
| `https://ztha.top/TVBox/GYCK.json` | ok | — | 挺好分享, 13 warehouses. |
| `http://tv.nxog.top/m/` | **timeout** | — | 欧歌多仓 — the usual first recommendation, dead from this network. |
| `http://tvkj.top/DC.txt` | **403** | — | 天微. |
| `http://qixing.myhkw.com/DC.txt` | **530** | — | 七星, WAF. |
| `http://yuan.haitangw.net/box/` | **timeout** | — | 长青多线. |
| `http://xmbjm.fh4u.org/dc.txt` | **timeout** | — | 拾光. |
| `https://tv.youdu.fan:666` | **timeout** | — | 毒盒. |
| `https://tvbox.cainisi.cf` | **timeout** | — | 菜妮丝. |
| `https://gitee.com/guot54/YGBH777/raw/main/dc2.json` | **423** | — | 月光宝盒, gitee locked. |
| `https://gitlab.com/ygbh1/666/-/raw/main/dcang/ygbh.json` | **403** | — | 天微 Gitlab. |
| `https://atomgit.com/hengxing/hx/raw/master/hxzck.txt` | **HTML** | — | Returns a page, not a config. |

## 点播 — single file

| Address | laptop | Result |
|---|---|---|
| `http://xhztv.top/xhz` | ok | 54 sites, spider `Yoursmile.jar`, 6 解析, EPG/logo. Shipped as `config/vod-xhz-54sites.json`. |
| `https://ztha.top/TVBox/thdjk.json` | ok | 46 sites, 10 lives. |
| `http://home.jundie.top:81/top98.json` | ok | 24 sites, 15 解析. Spider path is relative (`./jar/top98_1.jar`), resolved against the config URL. |
| `http://xhztv.top/4k.json` | **invalid JSON** | 30 KB, parse error at line 54. Don't. |

## 直播

| Address | laptop | tv | Result |
|---|---|---|---|
| `raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u` | ok | — | 466 channels, shipped as `config/live-cn-466.txt` (converted to `.txt` groups). No CCTV1–5; 央视 only 5+/8/12/13 + CGTN. |
| `https://iptv-org.github.io/iptv/countries/cn.m3u` | ok | — | Mostly geo-blocked. Fallback only. |
| `http://xhztv.top/xhz/live.txt` | ok | — | 2444 channels, **has** CCTV1–15, but the 央视/卫视 entries sit on China Mobile/Unicom unicast IPs that this TV cannot reach (4 of 58 open). Keep as an archive, not the default. |
| `http://223.78.65.165:9901/tsfile/live/0006_1.m3u8?key=txiptv&playlive=1&authid=0` | ok | **ok** | CCTV5+. Playlist 200 *and* a 5.6 MB segment 200 from the TV. The one stream proven end to end. |
| `http://39.134.24.162/dbiptv.sn.chinamobile.com/…` | ok | **timeout** | China Mobile IPTV. Works from a VPN, unreachable from a China Telecom line. Classic trap. |
| `http://ali-m-l.cztv.com/channels/lantian/channel001/1080p.m3u8` | ok | **TCP open, no HTTP reply** | 浙江广电 CDN. |
| `http://gcalic.v.myalicdn.com/…`, `http://l.cztvcloud.com/…`, `http://live.metshop.top/…` | ok | TCP open | Scenery cams, Hong Kong drama/movie loops, Zhejiang local channels. Reachable, so they are the safe part of a hand-built list. |

## Reading the `tv` column

- **ok** — HTTP 200 with a real `#EXTM3U` body, fetched from the TV with
  `toybox nc` (see `scripts/probe-from-tv.sh`).
- **timeout** — no TCP handshake within 8 s. Gone.
- **TCP open, no HTTP reply** — the CDN accepts the connection and then ignores a plain
  HTTP/1.1 request. Probably wants TLS/SNI or is filtered. Playback fails.
- **—** — not measured from the TV; treat as unverified.

`ping` is deliberately absent from this table. Mobile/Unicom IPTV hops answer ICMP at
0–50 % while HTTP works fine, so a ping result says nothing.

## Adding a source

1. Fetch it on the laptop to see the format.
2. Probe it **from the TV**.
3. If it works, copy it under `/sdcard/TV/` and point the pref at `file://TV/…`.
4. Add a row here with today's date and both columns.

### If you ever `pm clear` the app

`pm clear` resets granted permissions, so `file://TV/…` silently reads nothing and the home
stays on the default `影视` placeholder with no 直播 button. Re-grant before anything else:

```bash
adb shell pm grant com.fongmi.android.tv android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.fongmi.android.tv android.permission.WRITE_EXTERNAL_STORAGE
```

That one line is worth remembering — it looked exactly like "the config is broken" for a long
time, and re-ordering the config never helped.

## 点播 — more sites for the web / iOS front-ends

Probed 2026-10-24 from the laptop (`ac=detail&pg=1`, all 20 items had a direct m3u8):

| Site | API | Note |
|---|---|---|
| 360 | `https://360zy.com/api.php/provide/vod` | AES-128 streams; flaky (timed out later the same day) |
| 樱花 | `https://m3u8.apiyhzy.com/api.php/provide/vod` | |
| 魔都 | `https://www.mdzyapi.com/api.php/provide/vod` | AES-128 streams; strong on 动漫 |
| 丫丫 | `https://cj.yayazy.net/api.php/provide/vod` | many categories incl. 4K, Netflix, 短剧 |
| 闪电 | `https://sdzyapi.com/api.php/provide/vod` | same category tree as 丫丫 |
| 电影天堂 | `http://caiji.dyttzyapi.com/api.php/provide/vod` | plain http |

Dead from this network: 红牛, 天空, 卧龙, 光速, 新浪, 无尽, 极速, 金鹰, 百度, ikun, 最大, 茅台, 虎牙, 1080, 优质, 火狐, 速播, 如意, 旺旺, 豆瓣资源.

索尼 answers lists but Cloudflare blocks `wd=` searches (403), so it never shows up in search
results. 海外看 fails TLS from here.
