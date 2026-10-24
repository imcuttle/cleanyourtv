# 红米电视 MiTV-ASTP0 (mulan, Android 9, 固件 22.8.5.1321) 清理记录 — 2026-10-21

TV IP: 192.168.5.49 · 改动前的完整备份在 `backup/20261021-201759/`

## 做了什么
- 停用（未卸载）23 个包，见 `debloat.txt`：小米统计/上报、推送、云控、广告内容、商城/购物插件、
  电视管家、系统升级、游戏 SDK、小爱唤醒与音箱联动、手机遥控中继、乐播/Miracast/小米互联投屏、小米视频。
- 关闭开机广告：`settings put system boot_ad_switch 0`
- 新桌面：cleanyourtv 启动器，用白名单包名 `com.ts.launcher` 编译，设为默认主页。
  小米桌面 `com.mitv.tvhome` 保持启用（停用它会导致没有可用主页）。
- 保留：B 站（云视听小电视）、极光、CCTV、奇异果、CIBN、夸克TV、阿里云盘、Kodi、Nova、当贝市场、
  搜狗输入法、小米设置、应用商店、蓝牙遥控、HDMI/信号源、AirPlay。

## 常用操作（在仓库根目录执行，先在电视上打开 ADB 调试）
- 重新启用某个应用：`TV_HOST=192.168.5.49 tools/venv/bin/python -I tools/tv.py 'pm enable --user 0 <包名>'`
- 全部恢复：`mytv/restore.sh`
- 改 Dock 顺序：编辑 `launcher/app/src/main/res/values/config.xml` 的 `dock_apps`，再运行 `mytv/build-and-install.sh`
- 换壁纸/主题：`tools/theme.sh themes/<名字>`（本机包名不同，主题文件位置是
  `/sdcard/Android/data/com.ts.launcher/files/config.json`）
- 系统升级后广告会回来：`TV_HOST=192.168.5.49 tools/disable.sh mytv/debloat.txt`，再运行 `mytv/build-and-install.sh`
- ADB 每次重启都会自动关闭：设置 → 账号与安全 → ADB 调试 → 允许
