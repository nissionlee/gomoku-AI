@echo off
chcp 65001 >nul
title 弈 - 本地五子棋

cd /d "%~dp0"
if "%PORT%"=="" set PORT=5180

echo.
echo   ============================================
echo      弈 - 本地五子棋
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] 没有找到 Node.js
  echo.
  echo   请先安装 Node.js 18 或更高版本：
  echo       https://nodejs.org
  echo.
  echo   安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

rem 已经在运行就不重复启动，直接开页面
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   服务已经在运行了，直接打开页面。
  start "" http://127.0.0.1:%PORT%
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo   正在启动本地服务...
echo.
echo   ----------------------------------------------------
echo    停止服务：直接关闭本窗口，或双击「停止五子棋.bat」
echo   ----------------------------------------------------
echo.

rem 延迟 2 秒再开浏览器，等端口真正就绪
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://127.0.0.1:%PORT%"

node "server.mjs"

echo.
echo   服务已停止。
pause
