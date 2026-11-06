# ChromaDeck (中英文双语完整版)

基于 [miiidev/ChromaDeck](https://github.com/miiidev/ChromaDeck) 改造的 Windows 多显示器独立色彩预设管理器，新增**完整的中英文（`中文` / `EN`）实时无刷新切换功能**。

## 新增国际化（i18n）改造亮点

1. **全局中英文双语架构 (`src/lib/i18n.tsx`)**
   - 支持 **简体中文 (`zh`)** 与 **English (`en`)** 一键实时切换，自动记忆语言偏好至 `localStorage`（`chromadeck.locale`），首次启动自动识别系统语言。
   - 顶部标题栏右侧内置 `[中文 | EN]` 双语分段切换器，同时支持全局快捷键 `Alt + L` 随时切换语言。
2. **全界面与交互组件完整汉化**
   - **顶部导航与底部状态栏 (`src/App.tsx`)**：应用副标题、异常重试横幅、底部色彩守护状态指示灯、预设/显示器/锁定统计栏、开机自启开关（`开机自启` / `Autostart`）、立即重新应用（`重新应用` / `Reapply`）。
   - **显示器管理面板 (`src/components/MonitorSidebar.tsx`)**：显示器计数、屏幕编号识别（`识别屏幕` / `Identify`）、全屏拖拽投放提示（`所有显示器` / `All monitors`）、显示器在线/默认/已分配/离线胶囊徽章、重命名内联编辑器、硬件色彩重置（`重置` / `Reset`）、硬件实时状态探测（`探测` / `Probe`）及预设解锁。
   - **预设库与筛选器 (`src/components/MonitorList.tsx` & `PresetCard.tsx`)**：预设搜索框（支持 `/` 与 `Ctrl+F`）、分类筛选下拉框（`全部分类` / `未分类`）、空状态引导、卡片 `使用中`（`IN USE`）徽章、预设复制（自动添加 `(副本)` / `(copy)`）、编辑、删除与锁定提示。
   - **预设编辑器 (`src/components/PresetEditor.tsx`)**：17 种颜色标签与 8 种几何形状标签完整中文化、10 色块 sRGB 原始/调节后实时对比预览、6 项核心色彩参数滑块（伽马 Gamma、亮度、对比度、数字振动、饱和度、色相）、ICC/ICM 配置文件导入及表单校验提示（`src/lib/validation.ts`）。
   - **应用与删除弹窗 (`ApplyDialog.tsx`、`DeletePresetDialog.tsx`、`UndoToast.tsx`、`IdentifyOverlay.tsx`)**：色彩后端支持度检测提示、逐项调节结果反馈（`已应用` / `已跳过` / `失败`）、拖拽撤销浮动通知、全屏显示器编号识别遮罩。
3. **Windows 系统托盘菜单实时双语同步 (`src-tauri/src/lib.rs`)**
   - 新增 Tauri 后端命令 `set_tray_language_cmd`，当在前端切换中英文时，Windows 右下角系统托盘右键菜单实时同步切换：
     - 中文：`显示主窗口` / `立即重新应用` / `退出程序`
     - 英文：`Show` / `Reapply now` / `Quit`

## 如何生成 Windows `.exe` 安装包

### 方式一：Windows 本地一键打包（推荐）

1. 确保电脑已安装：
   - [Node.js 20+](https://nodejs.org/)
   - [Rust Stable 工具链](https://rustup.rs/)（含 Visual Studio C++ Build Tools）
2. 解压本项目后，直接双击运行根目录下的 **`build-exe-installer.bat`**（或在终端执行）：
   ```powershell
   npm install
   npm run tauri build
   npm run bundle:portable
   ```
3. 构建完成后会自动打开输出目录，产物如下：
   - **NSIS EXE 安装向导**：`src-tauri/target/release/bundle/nsis/ChromaDeck_0.8.2_x64-setup.exe`
   - **MSI 安装包**：`src-tauri/target/release/bundle/msi/ChromaDeck_0.8.2_x64_en-US.msi`
   - **单文件可执行程序**：`src-tauri/target/release/chromadeck.exe`
   - **便携版压缩包**：`src-tauri/target/release/bundle/ChromaDeck_0.8.2_x64-portable.zip`

### 方式二：GitHub Actions 免环境云端打包

本项目已内置 `.github/workflows/build-windows-exe.yml` 工作流：
1. 将解压后的项目推送至你的 GitHub 仓库。
2. 进入仓库的 **Actions** 页面，点击 **Build Windows EXE Installer (ChromaDeck i18n)** -> **Run workflow**。
3. 云端构建完成后即可直接下载编译好的 `ChromaDeck_0.8.2_x64-setup.exe` 安装包与便携版 ZIP。
