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
