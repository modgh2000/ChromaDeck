@echo off
chcp 65001 >nul
title ChromaDeck 中英文版 - 一键打包 Windows EXE 安装包
echo ============================================================================
echo   ChromaDeck v0.8.2 (中英文双语版) - Windows EXE 安装包一键构建工具
echo ============================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20+: https://nodejs.org/
    pause
    exit /b 1
)

where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Rust (cargo)，请先安装 Rust 工具链: https://rustup.rs/
    pause
    exit /b 1
)

echo [1/3] 正在安装前端依赖 (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo [错误] npm install 失败！
    pause
    exit /b 1
)

echo.
echo [2/3] 正在编译并生成 Windows EXE 安装包 (npm run tauri build)...
call npm run tauri build
if %errorlevel% neq 0 (
    echo [错误] Tauri 构建失败！
    pause
    exit /b 1
)

echo.
echo [3/3] 正在生成便携版压缩包 (npm run bundle:portable)...
call npm run bundle:portable

echo.
echo ============================================================================
echo   构建完成！生成的安装包位于以下路径：
echo   1. NSIS EXE 安装程序: src-tauri\target\release\bundle\nsis\ChromaDeck_0.8.2_x64-setup.exe
echo   2. MSI 安装程序:      src-tauri\target\release\bundle\msi\ChromaDeck_0.8.2_x64_en-US.msi
echo   3. 独立可执行文件:    src-tauri\target\release\chromadeck.exe
echo   4. 便携版 ZIP:        src-tauri\target\release\bundle\ChromaDeck_0.8.2_x64-portable.zip
echo ============================================================================
explorer "src-tauri\target\release\bundle"
pause
