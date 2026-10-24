# 小米电视 MiTV3S-43 (hancock, Android 4.4.4, 固件 7.7.21.1653) 优化记录 — 2026-10-22

TV IP: 192.168.5.55 · 改动前备份在 `backup/tv2-20261022-103838/`
配置：768 MB 内存，4.8 GB 存储（改动前只剩 684 MB）。

## 简洁桌面
主启动器 `minSdk 26`（Android 8.0）装不上，所以另写了一个轻量版 `launcher-lite/`：minSdk 19，没有 AndroidX，
APK 18 KB，占内存约 22 MB（小米桌面要 64 MB）。黑底、时钟日期、右上角「设置」、5 列应用网格；
B站、阿里云盘排在最前（`launcher-lite/app/src/main/res/values/strings.xml` 的 `pinned_apps`）。
这台固件不让选默认桌面，所以把小米桌面 `com.mitv.tvhome` 和带广告的屏保 `com.xiaomi.tv.gallery` 也 `pm block` 了，
Home 键就会回到简洁桌面。改了配置后运行 `mytv2/build-and-install.sh`（会自动点掉电视上的「安装确认」）。

## 做了什么
- 隐藏 22 个包，见 `debloat.txt`：统计/上报、广告（systemAdSolution）、酷云 ACR 收视追踪、推送、购物、
  电视管家、系统/应用升级、游戏 SDK、手机遥控中继、投屏、小米视频、说明书、健身房预装。
  这台固件会杀掉 `pm disable`，所以用的是 Android 4.4 的 `pm block`（隐藏，可用 `pm unblock` 恢复）。
- 动画速度改为 0.5x（窗口、过渡、动画时长）。
- 关闭开机广告：`settings put system boot_ad_switch 0`。
- 清理缓存：`/sdcard/miad/cache`（广告视频 300 MB）、`/sdcard/qcache/data`（爱奇艺播放器缓存 1.7 GB）、日志。
  可用空间 684 MB → 1.72 GB。
- 保留：B 站云视听、阿里云盘、儿童/学习类应用、语音、相册屏保、米家、输入法、应用商店、设置、信号源。

## 常用操作（在仓库根目录执行，先在电视上打开 ADB 调试）
- 恢复某个应用：`TV_HOST=192.168.5.55 tools/venv/bin/python -I tools/tv.py 'pm unblock <包名>'`
- 全部恢复（含小米桌面）：`mytv2/restore.sh`
- 只想要回小米桌面：`TV_HOST=192.168.5.55 tools/venv/bin/python -I tools/tv.py 'pm unblock com.mitv.tvhome'`
- 缓存又满了：重新删除 `/sdcard/miad/cache/*` 和 `/sdcard/qcache/data/*`
- ADB 每次重启都会自动关闭，用前到电视设置里重新打开
