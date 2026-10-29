@echo off
chcp 65001 >nul
title 部署五子棋到 Cloudflare Pages

echo ========================================================
echo        弈境五子棋 · Cloudflare Pages 一键安全发布
echo ========================================================
echo.

cd /d "%~dp0"

set "PATH=%APPDATA%\npm;C:\Users\nission\AppData\Local\Programs\WorkBuddyAI\resources\vendor\PortableGit\cmd;C:\Program Files\nodejs;%PATH%"

echo [1/3] 检查 Cloudflare 授权状态...
call wrangler.cmd whoami >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ⚠️ 尚未登录 Cloudflare 账号或授权已过期。
    echo 正在自动为您打开浏览器进行 Cloudflare 授权...
    echo （请在弹出的浏览器页面中点击 "Allow / 允许授权"）
    echo.
    call wrangler.cmd login
    if %errorlevel% neq 0 (
        echo ❌ 授权未完成，请重试或检查网络连接。
        pause
        exit /b 1
    )
    echo ✅ 授权成功！
    echo.
) else (
    echo ✅ Cloudflare 授权状态正常！
    echo.
)

echo [2/3] 准备发布包并上传至 Cloudflare Pages (gomoku-ai)...
node deploy.js
if %errorlevel% neq 0 (
    echo ❌ 部署过程出现错误，请检查上方日志。
    pause
    exit /b 1
)

echo.
echo ========================================================
echo [3/3] 🚀 发布成功！
echo 访问网址: https://gomoku-ai.pages.dev
echo CF 控制台: https://dash.cloudflare.com/20ee6c4aae0fb0bf58206d8235b1da2e/pages/view/gomoku-ai
echo ========================================================
echo.
pause
