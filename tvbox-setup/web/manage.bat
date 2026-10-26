@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title TVBox 管理
rem TVBox 网页版 — Windows 管理入口（双击运行）：重启 / 更新后重启，默认停在上一次的操作。
rem 没有 Node.js 18+ 时用 .tools\ 里的便携版（start.bat 第一次运行会下载）。

set "NODE="
where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" && set "NODE=node"
if not defined NODE if exist ".tools\node\node.exe" set "NODE=%~dp0.tools\node\node.exe"
if not defined NODE (
  echo 没有找到 Node.js 18+。先双击 start.bat 运行一次（会自动下载便携版），或到 https://nodejs.org 安装。
  pause
  exit /b 1
)
"%NODE%" manage.js %*
if errorlevel 1 pause
