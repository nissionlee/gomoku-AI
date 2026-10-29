@echo off
chcp 65001 >nul
title 弈 - 本地五子棋 - 停止

cd /d "%~dp0"
setlocal enabledelayedexpansion

if "%PORT%"=="" set PORT=5180

echo.
echo   ============================================
echo      弈 - 本地五子棋 - 停止服务
echo   ============================================
echo.

set FOUND=0
set KILLED=0

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  set "TPID=%%p"
  if not "!TPID!"=="0" (
    set FOUND=1
    set "IMG="
    for /f "tokens=1" %%n in ('tasklist /FI "PID eq !TPID!" /NH 2^>nul') do set "IMG=%%n"

    if /i "!IMG!"=="node.exe" (
      echo   结束 node 进程 PID !TPID! ...
      taskkill /PID !TPID! /F >nul 2>nul
      if !errorlevel! equ 0 (
        set KILLED=1
        echo   [OK] 已停止
      ) else (
        echo   [!] 结束失败，可能需要管理员权限
      )
    ) else (
      echo   [!] 端口 %PORT% 被 !IMG! 占用，不是本程序，已跳过
    )
  )
)

if !KILLED! equ 1 (
  echo.
  echo   服务已停止，浏览器页面可以关掉了。
) else (
  if !FOUND! equ 0 (
    echo   端口 %PORT% 上没有正在运行的服务。
    echo   可能已经停止过了，或者用的是别的端口。
  )
)

echo.
pause
