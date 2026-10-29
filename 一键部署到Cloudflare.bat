@echo off
chcp 65001 >nul
title Cloudflare Pages 发布五子棋

cd /d "%~dp0"

set "PATH=%APPDATA%\npm;C:\Users\nission\AppData\Local\Programs\WorkBuddyAI\resources\vendor\PortableGit\cmd;C:\Program Files\nodejs;%PATH%"

echo.
echo ========================================================
echo        弈境五子棋 Cloudflare Pages 安全发布
echo ========================================================
echo.

echo [1/2] 准备发布包并上传至 Cloudflare Pages: gomoku-ai...
node deploy.js
if errorlevel 1 (
    echo.
    echo [错误] 发布未完成，请检查上方提示信息。
    pause
    exit /b 1
)

echo.
echo ========================================================
echo [2/2] 🚀 发布成功！
echo 官方分配域名: https://gomoku-ai-b2f.pages.dev
echo 自定义域名:   https://5.1000rocks.com
echo CF 控制台:    https://dash.cloudflare.com/20ee6c4aae0fb0bf58206d8235b1da2e/pages/view/gomoku-ai
echo ========================================================
echo.
pause
