import { useState, useEffect, type FormEvent } from "react";

import type { Preset, PresetInput } from "../lib/types";
import { createPreset, updatePreset, importIcc } from "../lib/tauri";
import { validatePresetForm, type ValidationErrors } from "../lib/validation";
import { DEFAULT_PRESET_INPUT, presetToFormValues } from "../lib/presetForm";
import { joinCategory, splitCategory } from "../lib/presetCard";
import { applyPreviewPixel, type RgbColor } from "../lib/preview";
import {
  SWATCH_LABELS,
  TAG_COLOR_LABELS,
  TAG_SHAPE_LABELS,
  useI18n,
} from "../lib/i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { PresetTag } from "@/components/ui/preset-tag";
import { Check, ChevronDown, Upload, X } from "lucide-react";
import { cn } from "cn";

interface Props {
  presets: Preset[];
  editPreset: Preset | null;
  onClose: () => void;
  /** Fired after the close animation finishes; the parent unmounts here. */
  onClosed?: () => void;
  onSaved: () => void;
}

/** Live colour-bar preview source swatches (sRGB, 0..1). */
const REFERENCE_SWATCHES: { name: string; rgb: [number, number, number] }[] = [
  { name: "Black", rgb: [0, 0, 0] },
  { name: "Shadow", rgb: [0.18, 0.18, 0.18] },
  { name: "Mid", rgb: [0.5, 0.5, 0.5] },
  { name: "Highlight", rgb: [0.85, 0.85, 0.85] },
  { name: "Red", rgb: [1, 0, 0] },
  { name: "Green", rgb: [0, 1, 0] },
  { name: "Blue", rgb: [0, 0, 1] },
  { name: "Cyan", rgb: [0, 1, 1] },
  { name: "Magenta", rgb: [1, 0, 1] },
  { name: "Yellow", rgb: [1, 1, 0] },
];

const IDENTITY_PREVIEW = {
  brightness: 50,
  contrast: 50,
  gamma: 1,
  rgb_gains: [1, 1, 1] as [number, number, number],
  vibrance: 50,
  saturation: 50,
  hue_deg: 0,
};

/** Curated tag palette + None. Hexes are tuned for the dark surface. */
const TAG_OPTIONS = [
  { label: "None", value: "" },
  { label: "Mint", value: "#5eead4" },
  { label: "Teal", value: "#2dd4bf" },
  { label: "Cyan", value: "#22d3ee" },
  { label: "Sky", value: "#38bdf8" },
  { label: "Blue", value: "#60a5fa" },
  { label: "Indigo", value: "#818cf8" },
  { label: "Violet", value: "#a78bfa" },
  { label: "Magenta", value: "#e879f9" },
  { label: "Pink", value: "#f472b6" },
  { label: "Rose", value: "#fb7185" },
  { label: "Red", value: "#f87171" },
  { label: "Orange", value: "#fb923c" },
  { label: "Amber", value: "#fbbf24" },
  { label: "Lime", value: "#a3e635" },
  { label: "Green", value: "#4ade80" },
  { label: "Slate", value: "#94a3b8" },
] as const;

/** Marker shapes offered in the editor (stored as tag_shape). */
const TAG_SHAPE_OPTIONS = [
  { label: "Pill", value: "pill" },
  { label: "Round", value: "round" },
  { label: "Square", value: "square" },
  { label: "Bar", value: "bar" },
  { label: "Diamond", value: "diamond" },
  { label: "Hexagon", value: "hexagon" },
  { label: "Triangle", value: "triangle" },
  { label: "Ring", value: "ring" },
] as const;

function toHex(c: RgbColor): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(c.r)}${channel(c.g)}${channel(c.b)}`;
}

function LiveColorCard({
  label,
  params,
  highlight,
}: {
  label: string;
  params: typeof IDENTITY_PREVIEW;
  highlight?: boolean;
}) {
  const { locale, t } = useI18n();
  const swatchDict = SWATCH_LABELS[locale] ?? SWATCH_LABELS.en;
  return (
    <div
      className={cn(
        "rounded-[16px] border bg-surface p-4",
        highlight ? "border-primary" : "border-border",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span className="mono text-[9px] text-muted-foreground">
          {t.swatchesCount(REFERENCE_SWATCHES.length)}
        </span>
      </div>
      <div className="grid grid-cols-10 gap-1">
        {REFERENCE_SWATCHES.map((swatch) => {
          const [r, g, b] = swatch.rgb;
          const c = applyPreviewPixel({ r, g, b }, params);
          return (
            <div
              key={swatch.name}
              title={swatchDict[swatch.name] ?? swatch.name}
              className="h-[40px] rounded-[8px] border border-border"
              style={{ backgroundColor: toHex(c) }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function PresetEditor({ presets, editPreset, onClose, onClosed, onSaved }: Props) {
  const { locale, t } = useI18n();
  const isEditing = editPreset !== null;
  // The dialog owns its open state so Base UI can run the data-closed exit
  // animation before the parent unmounts it (see onOpenChangeComplete below).
  const [dialogOpen, setDialogOpen] = useState(true);
  const [form, setForm] = useState<PresetInput>(DEFAULT_PRESET_INPUT);
  const [category, setCategory] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [iccStatus, setIccStatus] = useState<{ hash: string; filename: string } | null>(null);
  const [iccImporting, setIccImporting] = useState(false);

  // Escape and backdrop dismissal must respect the same in-flight guard as the
  // disabled Save button; the save-success path passes `force` to close itself.
  const requestClose = (force = false) => {
    if (saving && !force) return;
    setDialogOpen(false);
    onClose();
  };

  // Populate form when editing
  useEffect(() => {
    if (editPreset) {
      const values = presetToFormValues(editPreset);
      const split = splitCategory(values.name);
      setForm({ ...values, name: split.title });
      setCategory(split.category ?? "");
      if (editPreset.icc_hash) {
        setIccStatus({ hash: editPreset.icc_hash, filename: editPreset.icc_filename });
      }
    } else {
      setForm(DEFAULT_PRESET_INPUT);
      setCategory("");
      setIccStatus(null);
    }
    setErrors({});
    setCategoryError(null);
    setIccImporting(false);
  }, [editPreset]);

  const handleBrowseIcc = async () => {
    setIccImporting(true);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "ICC profiles", extensions: ["icc", "icm"] }],
      });
      if (!selected) {
        setIccImporting(false);
        return;
      }
      const hash = await importIcc(selected);
      const parts = selected.replace(/\\/g, "/").split("/");
      setIccStatus({ hash, filename: parts[parts.length - 1] });
      setErrors((prev) => {
        const { icc_path: _, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setErrors((prev) => ({ ...prev, icc_path: t.iccImportFailed(String(err)) }));
    } finally {
      setIccImporting(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const categoryInvalid = category.includes(" - ");
    setCategoryError(categoryInvalid ? t.categoryDelimiterError : null);
    const errs: ValidationErrors = {};
    if (!validatePresetForm(form, errs, locale) || categoryInvalid) {
      setErrors(errs);
      return;
    }
    const payload: PresetInput = {
      ...form,
      name: joinCategory(category, form.name),
    };
    setSaving(true);
    try {
      if (isEditing && editPreset) {
        await updatePreset(editPreset.id, payload);
      } else {
        await createPreset(payload);
      }
      onSaved();
      requestClose(true);
    } catch (err) {
      setErrors({ name: t.saveFailed(String(err)) });
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof PresetInput>(key: K, value: PresetInput[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof ValidationErrors]) {
      setErrors((prev) => {
        const { [key as keyof ValidationErrors]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const categories = Array.from(
    new Set(
      presets
        .map((p) => splitCategory(p.name).category)
        .filter((c): c is string => Boolean(c)),
    ),
  ).sort();
  const colorLabels = TAG_COLOR_LABELS[locale] ?? TAG_COLOR_LABELS.en;
  const shapeLabels = TAG_SHAPE_LABELS[locale] ?? TAG_SHAPE_LABELS.en;
  const currentTag = form.color_tag ?? "";
  const rawTagKey = TAG_OPTIONS.find((o) => o.value === currentTag)?.label ?? "Custom";
  const tagLabel = colorLabels[rawTagKey] ?? rawTagKey;
  const currentShape = form.tag_shape ?? "pill";
  const previewParams = {
    brightness: form.brightness,
    contrast: form.contrast,
    gamma: form.gamma,
    rgb_gains: form.rgb_gains,
    vibrance: form.vibrance,
    saturation: form.saturation,
    hue_deg: form.hue_deg,
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed?.();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-x-clip overflow-y-auto sm:max-w-[708px]">
        <DialogHeader>
          <span className="mono text-[10px] uppercase tracking-[0.12em] text-primary">
            {t.editorBreadcrumb(isEditing ? (editPreset?.name ?? "") : t.editorNew)}
          </span>
          <DialogTitle className="font-display text-[32px] leading-none tracking-[-0.96px] text-foreground">
            {t.editorTitle}
          </DialogTitle>
          <DialogDescription className="font-mono text-[12px] leading-snug text-muted-foreground">
            {t.editorDescription}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* — Identity —————————————————————————————————— */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
            <div className="flex min-w-0 flex-col gap-2">
              <Label
                htmlFor="preset-name"
                className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                {t.presetNameLabel}
              </Label>
              <Input
                id="preset-name"
                type="text"
                value={form.name}
                onChange={(e) => updateField("name", (e.target as HTMLInputElement).value)}
                placeholder={t.presetNamePlaceholder}
                aria-invalid={errors.name ? ("true" as const) : undefined}
                className="h-11 rounded-[8px] px-3 py-2.5"
              />
              {errors.name && <p className="mono text-[10px] text-destructive validation-slide">{errors.name}</p>}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <Label
                htmlFor="preset-category"
                className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                {t.categoryLabel}
              </Label>
              <Combobox
                items={categories}
                value={category === "" ? null : category}
                onValueChange={(value) => {
                  setCategory(value ?? "");
                  setCategoryError(null);
                }}
                inputValue={category}
                onInputValueChange={(value) => {
                  setCategory(value);
                  if (categoryError) setCategoryError(null);
                }}
              >
                <div className="relative">
                  <ComboboxInput
                    id="preset-category"
                    placeholder={t.noCategory}
                    aria-invalid={categoryError ? ("true" as const) : undefined}
                  />
                  {category ? (
                    <button
                      type="button"
                      aria-label={t.clearCategory}
                      title={t.clearCategory}
                      onClick={() => {
                        setCategory("");
                        setCategoryError(null);
                      }}
                      className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : (
                    <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  )}
                </div>
                <ComboboxContent>
                  {(item: string) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxContent>
              </Combobox>
              {categoryError && (
                <p className="mono text-[10px] text-destructive validation-slide">{categoryError}</p>
              )}
            </div>
          </div>

          {/* — Color tag —————————————————————————————— */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {t.tagColourLabel}
              </span>
              <span className="mono text-[10px] text-muted-foreground">{tagLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.tagColourLabel}>
              {TAG_OPTIONS.map((option) => {
                const selected = currentTag === option.value;
                const localizedColorName = colorLabels[option.label] ?? option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    title={localizedColorName}
                    aria-label={t.tagColourAria(localizedColorName)}
                    aria-pressed={selected}
                    onClick={() => updateField("color_tag", option.value)}
                    className={cn(
                      "size-7 rounded-full border transition-[border-color]",
                      selected
                        ? "scale-110 border-primary ring-2 ring-primary ring-offset-2 ring-offset-surface transition-[scale,border-color] duration-[var(--motion-fast)]"
                        : "border-border hover:border-border-hover",
                      !option.value && "border-dashed bg-surface-hover",
                    )}
                    style={option.value ? { backgroundColor: option.value } : undefined}
                  />
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {t.tagShapeLabel}
              </span>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.tagShapeLabel}>
                {TAG_SHAPE_OPTIONS.map((option) => {
                  const selected = currentShape === option.value;
                  const localizedShapeName = shapeLabels[option.value] ?? option.label;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      title={localizedShapeName}
                      aria-label={t.tagShapeAria(localizedShapeName)}
                      aria-pressed={selected}
                      onClick={() => updateField("tag_shape", option.value)}
                      className={cn(
                        "inline-flex size-9 items-center justify-center rounded-[8px] border transition-[scale,border-color] duration-[var(--motion-fast)]",
                        selected
                          ? "scale-110 border-primary bg-primary-subtle"
                          : "border-border hover:border-border-hover",
                      )}
                    >
                      {/* Colour change remounts the selected preview so its
                          existing pop-in replays; unselected tags stay still. */}
                      <PresetTag
                        key={`${currentTag}-${option.value}`}
                        color={currentTag || undefined}
                        shape={option.value}
                        className={selected ? "pop-in" : undefined}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* — Live colour bar preview —————————————————— */}
          <div className="flex flex-col gap-3">
            <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t.livePreviewLabel}
            </span>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <LiveColorCard label={t.originalPreview} params={IDENTITY_PREVIEW} />
              <LiveColorCard label={t.adjustedPreview} params={previewParams} highlight />
            </div>
          </div>

          <div className="h-px w-full bg-border" aria-hidden="true" />

          {/* — Parameters: 2 columns —————————————————— */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
            <SliderField
              label={t.gammaLabel}
              min={0.3} max={2.8} step={0.05}
              value={form.gamma}
              display={form.gamma.toFixed(2)}
              onChange={(v) => updateField("gamma", v)}
              error={errors.gamma}
            />
            <SliderField
              label={t.brightnessLabel}
              min={0} max={100} step={1}
              value={form.brightness}
              display={form.brightness.toFixed(0)}
              onChange={(v) => updateField("brightness", v)}
              error={errors.brightness}
            />
            <SliderField
              label={t.contrastLabel}
              min={0} max={100} step={1}
              value={form.contrast}
              display={form.contrast.toFixed(0)}
              onChange={(v) => updateField("contrast", v)}
              error={errors.contrast}
            />
            <SliderField
              label={t.vibranceLabel}
              min={0} max={100} step={1}
              value={form.vibrance}
              display={form.vibrance.toFixed(0)}
              onChange={(v) => updateField("vibrance", v)}
              error={errors.vibrance}
            />
            <SliderField
              label={t.saturationLabel}
              min={0} max={100} step={1}
              value={form.saturation}
              display={form.saturation.toFixed(0)}
              onChange={(v) => updateField("saturation", v)}
              error={errors.saturation}
            />
            <SliderField
              label={t.hueLabel}
              min={0} max={359} step={1}
              value={form.hue_deg}
              display={`${form.hue_deg.toFixed(0)}°`}
              onChange={(v) => updateField("hue_deg", v)}
              error={errors.hue_deg}
            />
          </div>

          {/* — ICC profile upload —————————————————— */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-4 rounded-[12px] border border-dashed border-border p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-border text-muted-foreground">
                <Upload className="size-4" strokeWidth={1.5} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="mono text-[11px] text-foreground">{t.iccProfileLabel}</span>
                <span className="mono truncate text-[10px] text-muted-foreground" title={iccStatus?.filename}>
                  {t.iccOptionalHint(iccStatus ? iccStatus.filename : null)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleBrowseIcc()}
                disabled={iccImporting}
                className="shrink-0 rounded-full border border-border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
              >
                {iccImporting ? t.importingIcc : t.chooseFile}
              </button>
            </div>
            {errors.icc_path && <p className="mono text-[10px] text-destructive validation-slide">{errors.icc_path}</p>}
          </div>

          {/* — Actions —————————————————————————————— */}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => requestClose()}>
              {t.cancel}
            </Button>
            <Button variant="default" type="submit" disabled={saving} trailingIcon={<Check className="size-4 text-primary-foreground" />}>
              {saving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Flat slider row: mono 10px label + mono 12px value, full-width track. */
function SliderField({
  label, min, max, step, value, display, onChange, error,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
  error?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </Label>
        <span className="mono text-[12px] tabular-nums text-foreground">{display}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className="w-full"
      />
      {error && <p className="mono text-[10px] text-destructive validation-slide">{error}</p>}
    </div>
  );
}
