@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title TVBox 管理
rem TVBox 网页版 — Windows 管理入口（双击运行）：重启 / 更新后重启，默认停在上一次的操作。
rem 和 start.bat 用同一个 Node：优先带 node:sqlite 的 22.13+（账号功能要用），其次 .tools\ 里的便携版，最后系统里的 18+。

set "NODE="
set "OLD="
where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" && set "OLD=node"
if defined OLD node -e "require('node:sqlite')" >nul 2>nul && set "NODE=node"
if not defined NODE if exist ".tools\node\node.exe" ".tools\node\node.exe" -e "require('node:sqlite')" >nul 2>nul && set "NODE=%~dp0.tools\node\node.exe"
if not defined NODE if defined OLD set "NODE=node"
if not defined NODE if exist ".tools\node\node.exe" set "NODE=%~dp0.tools\node\node.exe"
if not defined NODE (
  echo 没有找到 Node.js 18 以上。先双击 start.bat 运行一次，会自动下载便携版，或到 https://nodejs.org 安装。
  pause
  exit /b 1
)
"%NODE%" manage.js %*
if errorlevel 1 pause
