import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TagShape } from "./types";

export type Locale = "zh" | "en";

const STORAGE_KEY = "chromadeck.locale";

export function detectInitialLocale(): Locale {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch {
      // ignore storage errors
    }
    if (typeof navigator !== "undefined" && navigator.language) {
      return navigator.language.toLowerCase().startsWith("en") ? "en" : "zh";
    }
  }
  return "zh";
}

let currentLocaleRef: Locale = detectInitialLocale();

export function getCurrentLocale(): Locale {
  return currentLocaleRef;
}

export function setCurrentLocaleValue(next: Locale): void {
  currentLocaleRef = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
}

export const TAG_COLOR_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    None: "None",
    Mint: "Mint",
    Teal: "Teal",
    Cyan: "Cyan",
    Sky: "Sky",
    Blue: "Blue",
    Indigo: "Indigo",
    Violet: "Violet",
    Magenta: "Magenta",
    Pink: "Pink",
    Rose: "Rose",
    Red: "Red",
    Orange: "Orange",
    Amber: "Amber",
    Lime: "Lime",
    Green: "Green",
    Slate: "Slate",
    Custom: "Custom",
  },
  zh: {
    None: "无",
    Mint: "薄荷绿",
    Teal: "青绿",
    Cyan: "青色",
    Sky: "天蓝",
    Blue: "蓝色",
    Indigo: "靛蓝",
    Violet: "紫罗兰",
    Magenta: "品红",
    Pink: "粉色",
    Rose: "玫红",
    Red: "红色",
    Orange: "橙色",
    Amber: "琥珀色",
    Lime: "青柠",
    Green: "绿色",
    Slate: "石板灰",
    Custom: "自定义",
  },
};

export const TAG_SHAPE_LABELS: Record<Locale, Record<TagShape, string>> = {
  en: {
    pill: "Pill",
    round: "Round",
    square: "Square",
    bar: "Bar",
    diamond: "Diamond",
    hexagon: "Hexagon",
    triangle: "Triangle",
    ring: "Ring",
  },
  zh: {
    pill: "胶囊",
    round: "圆形",
    square: "方形",
    bar: "横条",
    diamond: "菱形",
    hexagon: "六边形",
    triangle: "三角形",
    ring: "圆环",
  },
};

export const SWATCH_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    Black: "Black",
    Shadow: "Shadow",
    Mid: "Mid",
    Highlight: "Highlight",
    Red: "Red",
    Green: "Green",
    Blue: "Blue",
    Cyan: "Cyan",
    Magenta: "Magenta",
    Yellow: "Yellow",
  },
  zh: {
    Black: "纯黑",
    Shadow: "暗部",
    Mid: "中间调",
    Highlight: "高光",
    Red: "红",
    Green: "绿",
    Blue: "蓝",
    Cyan: "青",
    Magenta: "品红",
    Yellow: "黄",
  },
};

export const ADJUSTMENT_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    icc: "ICC",
    gamma: "Gamma",
    brightness: "Brightness",
    contrast: "Contrast",
    rgb_gains: "RGB gains",
    saturation: "Saturation",
    vibrance: "Vibrance",
    hue: "Hue",
  },
  zh: {
    icc: "ICC 配置文件",
    gamma: "伽马 (Gamma)",
    brightness: "亮度",
    contrast: "对比度",
    rgb_gains: "RGB 增益",
    saturation: "饱和度",
    vibrance: "数字振动",
    hue: "色相",
  },
};

export interface Translations {
  // Header & Language
  langToggleLabel: string;
  langToggleTooltip: string;
  appSubtitle: string;

  // Error Banner
  failedToLoad: (err: string) => string;
  retry: string;

  // Footer
  autostart: string;
  reapply: string;
  reapplyTooltip: string;
  loadingFooter: string;
  footerSummary: (presets: number, monitors: number, pinned: number) => string;
  healthError: (errors: number) => string;
  healthOk: string;
  healthLoading: string;
  healthEmpty: string;
  reapplyWithError: (err: string) => string;
  reappliedCount: (applied: number, total: number) => string;
  reapplyFailed: (err: string) => string;

  // MonitorSidebar
  monitorsHeading: (count: number) => string;
  identify: string;
  identifying: string;
  identifyTooltip: string;
  allMonitors: string;
  connectedCount: (count: number) => string;
  noMonitorsDetected: string;
  monitorNameAria: string;
  save: string;
  cancel: string;
  renameMonitor: string;
  renameMonitorAria: (name: string) => string;
  reset: string;
  resetTooltip: string;
  resetToDefault: string;
  resetFailed: (err: string) => string;
  probe: string;
  probeTooltip: string;
  probeFailed: (err: string) => string;
  unpinMonitorTooltip: string;
  unpinMonitorAria: (name: string) => string;
  chipAssigned: string;
  chipDefault: string;
  chipOffline: string;
  slotOfflineSuffix: string;
  slotDefaultTooltip: string;
  slotDisconnectedTooltip: string;
  slotDragCopyTooltip: (name: string) => string;
  slotApplying: (name: string) => string;
  slotApplyFailed: string;
  slotApplied: string;
  slotReleaseToApply: string;
  slotDropPresetHere: string;
  slotNotConnected: string;

  // MonitorList (Preset Library)
  presetsHeading: (count: number) => string;
  presetsFilteredHeading: (filtered: number, total: number) => string;
  noPresetsYet: string;
  emptyStateDesc: string;
  createPreset: string;
  everyPresetApplied: string;
  everyPresetAppliedHint: string;
  noPresetsMatchFilter: string;
  clearFilters: string;
  filterByCategoryAria: string;
  allCategories: string;
  noCategory: string;
  searchPresetsPlaceholder: string;
  searchPresetsAria: string;
  searchPresetsTitle: string;
  scrollLeftAria: string;
  scrollRightAria: string;

  // PresetCard
  copySuffix: string;
  duplicateFailed: (err: string) => string;
  deleteFailed: (err: string) => string;
  unpinFailed: (err: string) => string;
  inUseBadge: string;
  inUseTooltip: string;
  pinnedToTooltip: (names: string) => string;
  applyButton: string;
  applyPresetTitle: (name: string) => string;
  applyPresetAria: (name: string) => string;
  unpinAllTitle: string;
  unpinAllAria: (name: string) => string;
  editTitle: string;
  editPresetAria: (name: string) => string;
  duplicateTitle: string;
  duplicatePresetAria: (name: string) => string;
  deleteTitle: string;
  deletePresetAria: (name: string) => string;

  // PresetEditor
  editorBreadcrumb: (name: string) => string;
  editorNew: string;
  editorTitle: string;
  editorDescription: string;
  presetNameLabel: string;
  presetNamePlaceholder: string;
  categoryLabel: string;
  clearCategory: string;
  keepTypingCategory: string;
  categoryDelimiterError: string;
  tagColourLabel: string;
  tagShapeLabel: string;
  tagColourAria: (label: string) => string;
  tagShapeAria: (label: string) => string;
  defaultColorTagTitle: string;
  shapedColorTagTitle: (shape: string) => string;
  livePreviewLabel: string;
  originalPreview: string;
  adjustedPreview: string;
  swatchesCount: (count: number) => string;
  gammaLabel: string;
  brightnessLabel: string;
  contrastLabel: string;
  vibranceLabel: string;
  saturationLabel: string;
  hueLabel: string;
  iccProfileLabel: string;
  iccOptionalHint: (filename: string | null) => string;
  chooseFile: string;
  importingIcc: string;
  iccImportFailed: (err: string) => string;
  saveFailed: (err: string) => string;
  saving: string;

  // ApplyDialog & Outcomes
  applyPresetHeader: string;
  applyPresetDesc: string;
  noMonitorsDetectedPeriod: string;
  colourBackendTitle: (label: string) => string;
  statusPinned: string;
  statusReady: string;
  statusOffline: string;
  notSupportedOnDisplay: (list: string) => string;
  applyToAll: string;
  applying: string;
  applyFailedWithErr: (err: string) => string;
  outcomeStatus: (status: "applied" | "skipped" | "failed") => string;
  verificationNote: string;
  headlineApplyFailed: string;
  headlineAppliedWithFailed: (count: number) => string;
  headlineAppliedWithSkipped: (count: number) => string;
  headlineAppliedList: (labels: string) => string;
  headlineApplied: string;

  // DeletePresetDialog
  deleteDialogTitle: (name: string) => string;
  deleteDialogDesc: string;
  presetBadgeFallback: string;
  pinnedToStatus: (name: string) => string;
  notPinnedStatus: string;
  currentlyInUseSuffix: string;
  deleteKeepSettingsNote: string;
  deleting: string;

  // UndoToast & DragAndDrop
  undoAppliedTo: (presetName: string, targetLabel: string) => string;
  undoMonitorsCount: (count: number) => string;
  undoButton: string;
  dismissUndoAria: string;

  // IdentifyOverlay
  identifyCaption: (num: number, total: number | null) => string;
  monitorNumberAria: (num: number) => string;
}

export const TRANSLATIONS: Record<Locale, Translations> = {
  en: {
    langToggleLabel: "中文",
    langToggleTooltip: "Switch to Chinese / 切换为中文 (Alt+L)",
    appSubtitle: "Display Colour Manager",

    failedToLoad: (err) => `FAILED TO LOAD: ${err}`,
    retry: "Retry",

    autostart: "Autostart",
    reapply: "Reapply",
    reapplyTooltip: "Re-run enforcement now",
    loadingFooter: "LOADING...",
    footerSummary: (p, m, pin) =>
      `${p} PRESET${p !== 1 ? "S" : ""} · ${m} MONITOR${m !== 1 ? "S" : ""} CONNECTED · ${pin} PINNED`,
    healthError: (errors) =>
      `Last reapply reported ${errors} error${errors === 1 ? "" : "s"}`,
    healthOk: "Enforcement OK",
    healthLoading: "Loading monitor status",
    healthEmpty: "No monitors connected",
    reapplyWithError: (err) => `Reapply: ${err}`,
    reappliedCount: (applied, total) => `Reapplied ${applied}/${total}`,
    reapplyFailed: (err) => `Reapply failed: ${err}`,

    monitorsHeading: (count) => `Monitors (${count})`,
    identify: "Identify",
    identifying: "Identifying...",
    identifyTooltip: "Show monitor numbers on each display",
    allMonitors: "All monitors",
    connectedCount: (count) => `${count} connected`,
    noMonitorsDetected: "No monitors detected",
    monitorNameAria: "Monitor name",
    save: "Save",
    cancel: "Cancel",
    renameMonitor: "Rename monitor",
    renameMonitorAria: (name) => `Rename monitor ${name}`,
    reset: "Reset",
    resetTooltip: "Reset this monitor to default colours (identity gamma)",
    resetToDefault: "Reset to default",
    resetFailed: (err) => `Reset failed: ${err}`,
    probe: "Probe",
    probeTooltip: "Read live hardware state for this monitor (changes nothing)",
    probeFailed: (err) => `Probe failed: ${err}`,
    unpinMonitorTooltip: "Unpin from this monitor",
    unpinMonitorAria: (name) => `Unpin from ${name}`,
    chipAssigned: "ASSIGNED",
    chipDefault: "DEFAULT",
    chipOffline: "OFFLINE",
    slotOfflineSuffix: " · monitor offline",
    slotDefaultTooltip: "No preset applied — display defaults in use",
    slotDisconnectedTooltip: "Monitor not connected",
    slotDragCopyTooltip: (name) => `Drag ${name} onto another monitor to copy it`,
    slotApplying: (name) => `Applying ${name}...`,
    slotApplyFailed: "Apply failed",
    slotApplied: "Applied",
    slotReleaseToApply: "Release to apply",
    slotDropPresetHere: "Drop preset here",
    slotNotConnected: "Not connected",

    presetsHeading: (count) => `Presets (${count})`,
    presetsFilteredHeading: (filtered, total) => `Presets (${filtered} of ${total})`,
    noPresetsYet: "No presets yet",
    emptyStateDesc:
      "Create your first colour preset to apply an ICC profile and gamma adjustment to a monitor.",
    createPreset: "Create preset",
    everyPresetApplied: "Every preset is applied to a monitor",
    everyPresetAppliedHint: "Duplicate a preset from a monitor to reuse it on another display.",
    noPresetsMatchFilter: "No presets match the current filters",
    clearFilters: "Clear filters",
    filterByCategoryAria: "Filter presets by category",
    allCategories: "All categories",
    noCategory: "No category",
    searchPresetsPlaceholder: "Search presets...",
    searchPresetsAria: "Search presets",
    searchPresetsTitle: "Search presets (/)",
    scrollLeftAria: "Scroll presets left",
    scrollRightAria: "Scroll presets right",

    copySuffix: "(copy)",
    duplicateFailed: (err) => `Duplicate failed: ${err}`,
    deleteFailed: (err) => `Delete failed: ${err}`,
    unpinFailed: (err) => `Unpin failed: ${err}`,
    inUseBadge: "IN USE",
    inUseTooltip: "Currently applied to a connected monitor",
    pinnedToTooltip: (names) => `Pinned to ${names}`,
    applyButton: "Apply",
    applyPresetTitle: (name) => `Apply ${name}`,
    applyPresetAria: (name) => `Apply preset ${name}`,
    unpinAllTitle: "Unpin from all monitors",
    unpinAllAria: (name) => `Unpin preset ${name} from all monitors`,
    editTitle: "Edit",
    editPresetAria: (name) => `Edit preset ${name}`,
    duplicateTitle: "Duplicate preset",
    duplicatePresetAria: (name) => `Duplicate preset ${name}`,
    deleteTitle: "Delete preset",
    deletePresetAria: (name) => `Delete preset ${name}`,

    editorBreadcrumb: (name) => `Preset editor / ${name}`,
    editorNew: "New",
    editorTitle: "Fine-tune your perspective.",
    editorDescription: "Adjust colour without touching your display's defaults.",
    presetNameLabel: "Preset name",
    presetNamePlaceholder: "Warm",
    categoryLabel: "Category",
    clearCategory: "Clear category",
    keepTypingCategory: "Keep typing to create a new category",
    categoryDelimiterError: 'Category cannot contain " - "',
    tagColourLabel: "Tag colour",
    tagShapeLabel: "Tag shape",
    tagColourAria: (label) => `Tag colour ${label}`,
    tagShapeAria: (label) => `Tag shape ${label}`,
    defaultColorTagTitle: "Default colour tag",
    shapedColorTagTitle: (shape) => `${shape} colour tag`,
    livePreviewLabel: "Live colour bar preview",
    originalPreview: "Original",
    adjustedPreview: "Adjusted",
    swatchesCount: (count) => `${count} SWATCHES`,
    gammaLabel: "Gamma",
    brightnessLabel: "Brightness",
    contrastLabel: "Contrast",
    vibranceLabel: "Vibrance",
    saturationLabel: "Saturation",
    hueLabel: "Hue",
    iccProfileLabel: "ICC profile",
    iccOptionalHint: (filename) =>
      `Optional · .icc or .icm · ${filename ? filename : "No file selected"}`,
    chooseFile: "Choose file",
    importingIcc: "Importing...",
    iccImportFailed: (err) => `ICC import failed: ${err}`,
    saveFailed: (err) => `Save failed: ${err}`,
    saving: "Saving...",

    applyPresetHeader: "Apply preset",
    applyPresetDesc: "Choose a monitor to apply this preset.",
    noMonitorsDetectedPeriod: "No monitors detected.",
    colourBackendTitle: (label) => `Colour backend: ${label}`,
    statusPinned: "PINNED",
    statusReady: "READY",
    statusOffline: "OFFLINE",
    notSupportedOnDisplay: (list) => `Not supported on this display: ${list}`,
    applyToAll: "Apply to all",
    applying: "Applying...",
    applyFailedWithErr: (err) => `Apply failed: ${err}`,
    outcomeStatus: (status) => status.toUpperCase(),
    verificationNote:
      "Writes accepted by the backend; not read-back verified - use Probe to check the panel.",
    headlineApplyFailed: "Apply failed",
    headlineAppliedWithFailed: (count) => `Applied with ${count} failed`,
    headlineAppliedWithSkipped: (count) => `Applied with ${count} skipped`,
    headlineAppliedList: (labels) => `Applied - ${labels}`,
    headlineApplied: "Applied",

    deleteDialogTitle: (name) => `Delete ${name}?`,
    deleteDialogDesc: "This preset will be permanently removed.",
    presetBadgeFallback: "Preset",
    pinnedToStatus: (name) => `Pinned to ${name}`,
    notPinnedStatus: "Not pinned",
    currentlyInUseSuffix: " · Currently in use",
    deleteKeepSettingsNote:
      "Your display keeps its current settings until you apply another preset.",
    deleting: "Deleting...",

    undoAppliedTo: (presetName, targetLabel) =>
      `Applied ${presetName} to ${targetLabel}`,
    undoMonitorsCount: (count) => `${count} monitors`,
    undoButton: "Undo",
    dismissUndoAria: "Dismiss undo",

    identifyCaption: (num, total) =>
      total !== null && total !== undefined && total > 1
        ? `CHROMADECK · Monitor ${num} of ${total}`
        : `CHROMADECK · Monitor ${num}`,
    monitorNumberAria: (num) => `Monitor ${num}`,
  },

  zh: {
    langToggleLabel: "EN",
    langToggleTooltip: "切换为英文 / Switch to English (Alt+L)",
    appSubtitle: "多显示器色彩预设管理器",

    failedToLoad: (err) => `加载失败：${err}`,
    retry: "重试",

    autostart: "开机自启",
    reapply: "重新应用",
    reapplyTooltip: "立即重新执行色彩锁定",
    loadingFooter: "加载中...",
    footerSummary: (p, m, pin) =>
      `${p} 个预设 · ${m} 台显示器已连接 · ${pin} 个已锁定`,
    healthError: (errors) => `上次重新应用报告了 ${errors} 个错误`,
    healthOk: "色彩守护运行正常",
    healthLoading: "正在加载显示器状态",
    healthEmpty: "未连接显示器",
    reapplyWithError: (err) => `重新应用：${err}`,
    reappliedCount: (applied, total) => `已重新应用 ${applied}/${total}`,
    reapplyFailed: (err) => `重新应用失败：${err}`,

    monitorsHeading: (count) => `显示器 (${count})`,
    identify: "识别屏幕",
    identifying: "正在识别...",
    identifyTooltip: "在每个显示器上显示屏幕编号",
    allMonitors: "所有显示器",
    connectedCount: (count) => `${count} 台已连接`,
    noMonitorsDetected: "未检测到显示器",
    monitorNameAria: "显示器名称",
    save: "保存",
    cancel: "取消",
    renameMonitor: "重命名显示器",
    renameMonitorAria: (name) => `重命名显示器 ${name}`,
    reset: "重置",
    resetTooltip: "将此显示器重置为默认色彩（标准 Gamma）",
    resetToDefault: "已重置为默认",
    resetFailed: (err) => `重置失败：${err}`,
    probe: "探测",
    probeTooltip: "读取此显示器的实时硬件状态（不修改任何设置）",
    probeFailed: (err) => `探测失败：${err}`,
    unpinMonitorTooltip: "解除此显示器的预设锁定",
    unpinMonitorAria: (name) => `从 ${name} 解除锁定`,
    chipAssigned: "已分配",
    chipDefault: "默认",
    chipOffline: "离线",
    slotOfflineSuffix: " · 显示器离线",
    slotDefaultTooltip: "未应用预设 — 当前使用显示器默认设置",
    slotDisconnectedTooltip: "显示器未连接",
    slotDragCopyTooltip: (name) => `将 ${name} 拖拽到其他显示器以复制应用`,
    slotApplying: (name) => `正在应用 ${name}...`,
    slotApplyFailed: "应用失败",
    slotApplied: "已应用",
    slotReleaseToApply: "松开以应用预设",
    slotDropPresetHere: "将预设拖拽至此",
    slotNotConnected: "未连接",

    presetsHeading: (count) => `预设库 (${count})`,
    presetsFilteredHeading: (filtered, total) => `预设库 (${filtered} / ${total})`,
    noPresetsYet: "暂无预设",
    emptyStateDesc: "创建你的第一个色彩预设，为显示器应用 ICC 配置文件与 Gamma 调节。",
    createPreset: "创建预设",
    everyPresetApplied: "所有预设均已应用到显示器",
    everyPresetAppliedHint: "可复制预设或从显示器卡片拖拽至其他屏幕进行复用。",
    noPresetsMatchFilter: "没有符合当前筛选条件的预设",
    clearFilters: "清除筛选",
    filterByCategoryAria: "按分类筛选预设",
    allCategories: "全部分类",
    noCategory: "未分类",
    searchPresetsPlaceholder: "搜索预设...",
    searchPresetsAria: "搜索预设",
    searchPresetsTitle: "搜索预设 (/)",
    scrollLeftAria: "向左滚动预设",
    scrollRightAria: "向右滚动预设",

    copySuffix: "(副本)",
    duplicateFailed: (err) => `复制失败：${err}`,
    deleteFailed: (err) => `删除失败：${err}`,
    unpinFailed: (err) => `解除锁定失败：${err}`,
    inUseBadge: "使用中",
    inUseTooltip: "当前已应用到已连接的显示器",
    pinnedToTooltip: (names) => `已锁定至 ${names}`,
    applyButton: "应用",
    applyPresetTitle: (name) => `应用 ${name}`,
    applyPresetAria: (name) => `应用预设 ${name}`,
    unpinAllTitle: "从所有显示器解除锁定",
    unpinAllAria: (name) => `从所有显示器解除预设 ${name} 的锁定`,
    editTitle: "编辑",
    editPresetAria: (name) => `编辑预设 ${name}`,
    duplicateTitle: "复制预设",
    duplicatePresetAria: (name) => `复制预设 ${name}`,
    deleteTitle: "删除预设",
    deletePresetAria: (name) => `删除预设 ${name}`,

    editorBreadcrumb: (name) => `预设编辑器 / ${name}`,
    editorNew: "新建",
    editorTitle: "精调你的显示色彩。",
    editorDescription: "在不改动显示器出厂默认设置的前提下调节色彩参数。",
    presetNameLabel: "预设名称",
    presetNamePlaceholder: "暖色护眼",
    categoryLabel: "分类",
    clearCategory: "清除分类",
    keepTypingCategory: "继续输入以创建新分类",
    categoryDelimiterError: '分类名称不能包含 " - "',
    tagColourLabel: "标签颜色",
    tagShapeLabel: "标签形状",
    tagColourAria: (label) => `标签颜色 ${label}`,
    tagShapeAria: (label) => `标签形状 ${label}`,
    defaultColorTagTitle: "默认颜色标签",
    shapedColorTagTitle: (shape) => `${shape}颜色标签`,
    livePreviewLabel: "实时色条对比预览",
    originalPreview: "原始色彩",
    adjustedPreview: "调节后",
    swatchesCount: (count) => `${count} 个色块`,
    gammaLabel: "伽马 (Gamma)",
    brightnessLabel: "亮度 (Brightness)",
    contrastLabel: "对比度 (Contrast)",
    vibranceLabel: "数字振动 (Vibrance)",
    saturationLabel: "饱和度 (Saturation)",
    hueLabel: "色相 (Hue)",
    iccProfileLabel: "ICC 色彩配置文件",
    iccOptionalHint: (filename) =>
      `可选 · .icc 或 .icm · ${filename ? filename : "未选择文件"}`,
    chooseFile: "选择文件",
    importingIcc: "正在导入...",
    iccImportFailed: (err) => `ICC 导入失败：${err}`,
    saveFailed: (err) => `保存失败：${err}`,
    saving: "正在保存...",

    applyPresetHeader: "应用预设",
    applyPresetDesc: "选择要应用此预设的目标显示器。",
    noMonitorsDetectedPeriod: "未检测到显示器。",
    colourBackendTitle: (label) => `色彩后端：${label}`,
    statusPinned: "已锁定",
    statusReady: "就绪",
    statusOffline: "离线",
    notSupportedOnDisplay: (list) => `此显示器不支持以下调节项：${list}`,
    applyToAll: "应用到所有显示器",
    applying: "正在应用...",
    applyFailedWithErr: (err) => `应用失败：${err}`,
    outcomeStatus: (status) =>
      status === "applied" ? "已应用" : status === "skipped" ? "已跳过" : "失败",
    verificationNote:
      "后端已写入参数；未经回读校验 — 可使用“探测”按钮检查面板实时状态。",
    headlineApplyFailed: "应用失败",
    headlineAppliedWithFailed: (count) => `已应用（${count} 项失败）`,
    headlineAppliedWithSkipped: (count) => `已应用（${count} 项跳过）`,
    headlineAppliedList: (labels) => `已应用 - ${labels}`,
    headlineApplied: "已应用",

    deleteDialogTitle: (name) => `确认删除 ${name}？`,
    deleteDialogDesc: "此预设将被永久移除，无法恢复。",
    presetBadgeFallback: "预设",
    pinnedToStatus: (name) => `已锁定至 ${name}`,
    notPinnedStatus: "未锁定",
    currentlyInUseSuffix: " · 当前正在使用",
    deleteKeepSettingsNote: "在应用其他预设之前，显示器将保持当前色彩设置。",
    deleting: "正在删除...",

    undoAppliedTo: (presetName, targetLabel) =>
      `已将 ${presetName} 应用至 ${targetLabel}`,
    undoMonitorsCount: (count) => `${count} 台显示器`,
    undoButton: "撤销",
    dismissUndoAria: "关闭撤销提示",

    identifyCaption: (num, total) =>
      total !== null && total !== undefined && total > 1
        ? `CHROMADECK · 显示器 ${num} / 共 ${total} 台`
        : `CHROMADECK · 显示器 ${num}`,
    monitorNumberAria: (num) => `显示器 ${num}`,
  },
};

interface I18nContextValue {
  locale: Locale;
  t: Translations;
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: currentLocaleRef,
  t: TRANSLATIONS[currentLocaleRef],
  setLocale: () => {},
  toggleLocale: () => {},
});

export function I18nProvider({
  children,
  onLocaleChange,
}: {
  children: ReactNode;
  onLocaleChange?: (locale: Locale) => void;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale());

  const setLocale = useCallback(
    (next: Locale) => {
      setCurrentLocaleValue(next);
      setLocaleState(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  useEffect(() => {
    setCurrentLocaleValue(locale);
    onLocaleChange?.(locale);
  }, [locale, onLocaleChange]);

  // Global Alt+L keyboard shortcut to toggle Chinese/English anywhere in the app
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleLocale();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleLocale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: TRANSLATIONS[locale],
      setLocale,
      toggleLocale,
    }),
    [locale, setLocale, toggleLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
