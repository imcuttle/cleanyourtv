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

## What is in here

| Path | What |
|---|---|
| `SKILL.md` | The whole procedure, written as an agent skill. Start here if you are an assistant. |
| `config/vod-5-direct.json` | **Use this one.** Five 苹果CMS sites with direct APIs — no spider jar, no 解析. All five list and play. |
| `config/vod-xhz-54sites.json` | A 54-site spider-config. Loads, but most sites can't produce a playable URL. Kept as a reference for the shape, not as a daily driver. |
| `config/live-cn-466.txt` | 466-channel 直播 list in TVBox `.txt` format with groups. |
| `sources.md` | Where sources come from, and which ones answered — with the date. |
| `scripts/` | discover / push / probe / verify. |
| `shots/` | What it looks like when it works. |

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
