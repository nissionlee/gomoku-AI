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

echo [1/3] 检查 Cloudflare 授权状态...
call wrangler.cmd whoami 2>&1 | findstr "authenticated" >nul
if not errorlevel 1 goto do_login
goto do_deploy

:do_login
echo.
echo [提示] 尚未登录 Cloudflare 或登录已过期。
echo 正在为您打开浏览器授权页面，请在网页中点击 Allow 授权...
echo.
call wrangler.cmd login
if errorlevel 1 (
    echo [错误] 授权未完成，请重试。
    pause
    exit /b 1
)
echo [成功] Cloudflare 授权已完成！
echo.

:do_deploy
echo [2/3] 准备发布并上传至 Cloudflare Pages: gomoku-ai...
node deploy.js
if errorlevel 1 (
    echo.
    echo [错误] 发布未完成，请检查上方提示信息。
    pause
    exit /b 1
)

echo.
echo ========================================================
echo [3/3] 发布成功！
echo 线上网址: https://gomoku-ai.pages.dev
echo 控制台:   https://dash.cloudflare.com/20ee6c4aae0fb0bf58206d8235b1da2e/pages/view/gomoku-ai
echo ========================================================
echo.
pause
