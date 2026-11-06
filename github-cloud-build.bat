@echo off
chcp 65001 >nul
title ChromaDeck 中英文版 - 方案二：一键推送到 GitHub 云端自动打包 EXE
echo ============================================================================
echo   ChromaDeck v0.8.2 (中英文双语版) - GitHub Actions 免环境云端打包助手
echo ============================================================================
echo.
echo 本脚本无需你在本地安装 Rust 或 Visual Studio C++ 编译工具，
echo 只需将本项目推送到你的 GitHub 仓库，GitHub 云端将自动编译生成 EXE 安装包！
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 未检测到本地 Git。
    echo 你可以直接打开浏览器访问 https://github.com/new 新建一个仓库，
    echo 然后点击 "uploading an existing file"，将 .github/workflows/build-windows-exe.yml 拖入上传即可自动打包！
    pause
    exit /b 1
)

set /p REPO_URL="请输入你在 GitHub 新建或 Fork 的仓库地址 (例如 https://github.com/你的用户名/ChromaDeck.git): "
if "%REPO_URL%"=="" (
    echo [错误] 仓库地址不能为空！
    pause
    exit /b 1
)

echo.
echo [1/3] 正在初始化本地 Git 仓库并提交中英文双语源码...
if not exist ".git" (
    git init
    git branch -M main
)
git add -A
git commit -m "feat(i18n): complete Chinese/English language switching & Windows EXE workflow"

echo.
echo [2/3] 正在推送到 GitHub 远程仓库触发 Actions 自动编译...
git remote remove origin >nul 2>nul
git remote add origin "%REPO_URL%"
git push -u origin main --force
if %errorlevel% neq 0 (
    echo [错误] 推送失败，请检查仓库地址或登录权限。
    pause
    exit /b 1
)

echo.
echo [3/3] 推送成功！GitHub Actions 已开始在云端编译 Windows EXE 安装包（约需 3~5 分钟）。
echo 编译完成后，你可在仓库的 Actions 或 Releases 页面直接下载 ChromaDeck_0.8.2_x64-setup.exe！
pause
