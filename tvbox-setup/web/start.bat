@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title TVBox
rem TVBox 网页版 — Windows 一键启动（双击运行）。优先用带 node:sqlite 的 Node.js 22.13+（账号功能要用）；
rem 没有就自动下载便携版到 .tools\，不改系统。系统里只有 Node 18 / 20 时仍然能用，只是账号功能是关的。

set "NODE="
set "OLD="
where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" && set "OLD=node"
if defined OLD node -e "require('node:sqlite')" >nul 2>nul && set "NODE=node"
if not defined NODE if exist ".tools\node\node.exe" ".tools\node\node.exe" -e "require('node:sqlite')" >nul 2>nul && set "NODE=%~dp0.tools\node\node.exe"
if not defined NODE (
  echo 下载便携版 Node.js 22（约 30MB，账号功能需要 22.13 以上），只放在本目录 .tools 里……
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $v='v22.16.0'; $z=Join-Path $env:TEMP ('node-'+$v+'.zip'); try { Invoke-WebRequest ('https://npmmirror.com/mirrors/node/'+$v+'/node-'+$v+'-win-x64.zip') -OutFile $z -UseBasicParsing } catch { Invoke-WebRequest ('https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-x64.zip') -OutFile $z -UseBasicParsing }; New-Item -ItemType Directory -Force '.tools' | Out-Null; Remove-Item -Recurse -Force '.tools\node' -ErrorAction SilentlyContinue; Expand-Archive $z -DestinationPath '.tools' -Force; Rename-Item ('.tools\node-'+$v+'-win-x64') 'node'; Remove-Item $z"
  if errorlevel 1 (
    if defined OLD (
      echo 下载失败，先用系统的 Node.js，账号功能不可用，升级到 Node 22.13 以上后重启即可。
      set "NODE=node"
    ) else (
      echo 下载失败，请手动安装 Node.js 22.13 以上：https://nodejs.org
      pause
      exit /b 1
    )
  ) else set "NODE=%~dp0.tools\node\node.exe"
)

where ffmpeg >nul 2>nul || if not exist ".tools\ffmpeg.exe" echo 提示：把 ffmpeg.exe 放进 .tools 文件夹后，直播封面和悬停预览由服务端生成，更快。
echo 第一次运行时 Windows 防火墙会询问，勾选「专用网络」并允许，局域网里其他设备才能访问。
rem 没有访问令牌，打开网页不需要口令。管理员令牌第一次启动由 server.js 在 .env 里生成 TVBOX_ADMIN_TOKEN，并在这个窗口里打印。
if not defined PORT set "PORT=9988"
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
"%NODE%" server.js
pause
