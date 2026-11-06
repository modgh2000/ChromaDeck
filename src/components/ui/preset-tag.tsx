import { cva } from "class-variance-authority"
import { cn } from "cn"

import type { TagShape } from "@/lib/types"
import { TAG_SHAPE_LABELS, useI18n } from "@/lib/i18n"

/** Fallback marker colour for untagged presets. */
const DEFAULT_TAG_COLOR = "var(--color-primary)"

type Size = "sm" | "md"

/**
 * Marker geometry per shape. `sm` is used on cards and the drag ghost, `md`
 * in the monitor slot. Sizes are deliberately chunky: the marker is the first
 * thing scanned when picking a preset.
 */
const marker = cva("block shrink-0", {
  variants: {
    shape: {
      pill: "",
      round: "",
      square: "",
      bar: "",
      diamond: "",
      hexagon: "",
      triangle: "",
      ring: "border-2 bg-transparent",
    },
    size: {
      sm: "",
      md: "",
    },
  },
  compoundVariants: [
    // Pill: tall narrow marker.
    { shape: "pill", size: "sm", class: "h-3.5 w-2 rounded-full" },
    { shape: "pill", size: "md", class: "h-4 w-2.5 rounded-full" },
    // Round: solid dot.
    { shape: "round", size: "sm", class: "size-3.5 rounded-full" },
    { shape: "round", size: "md", class: "size-4 rounded-full" },
    // Square: softly rounded tile.
    { shape: "square", size: "sm", class: "size-3.5 rounded-[3px]" },
    { shape: "square", size: "md", class: "size-4 rounded-[4px]" },
    // Bar: horizontal rule.
    { shape: "bar", size: "sm", class: "h-1.5 w-6 rounded-full" },
    { shape: "bar", size: "md", class: "h-2 w-7 rounded-full" },
    // Diamond: rotated tile (rotation enlarges the visual footprint).
    { shape: "diamond", size: "sm", class: "size-2.5 rotate-45 rounded-[2px]" },
    { shape: "diamond", size: "md", class: "size-3 rotate-45 rounded-[2px]" },
    // Hexagon: flat-top gem.
    {
      shape: "hexagon",
      size: "sm",
      class: "[clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)] h-3.5 w-3",
    },
    {
      shape: "hexagon",
      size: "md",
      class: "[clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)] h-4 w-3.5",
    },
    // Triangle: upward marker.
    {
      shape: "triangle",
      size: "sm",
      class: "[clip-path:polygon(50%_0,100%_100%,0_100%)] h-3 w-3.5",
    },
    {
      shape: "triangle",
      size: "md",
      class: "[clip-path:polygon(50%_0,100%_100%,0_100%)] h-3.5 w-4",
    },
    // Ring: hollow circle showing the colour as an outline.
    { shape: "ring", size: "sm", class: "size-3.5 rounded-full" },
    { shape: "ring", size: "md", class: "size-4 rounded-full" },
  ],
  defaultVariants: {
    shape: "pill",
    size: "sm",
  },
})

export interface PresetTagProps {
  color?: string | null
  shape?: TagShape | null
  size?: Size
  className?: string
  /** Render a purely decorative marker (default). */
  decorative?: boolean
}

/**
 * Single-colour preset marker. Shared by preset cards, the monitor slot and
 * the drag ghost so a preset reads identically everywhere. Untagged presets
 * fall back to the theme primary colour.
 *
 * The backend serialises a missing shape as `null`, so both `null` and any
 * unknown value resolve to the pill default — passing an unmatched shape to
 * `cva` would drop the sizing classes and render nothing.
 */
export function PresetTag({
  color,
  shape,
  size = "sm",
  className,
  decorative = true,
}: PresetTagProps) {
  const { locale, t } = useI18n()
  const shapeDict = TAG_SHAPE_LABELS[locale] ?? TAG_SHAPE_LABELS.en
  const resolvedShape: TagShape =
    shape && shape in shapeDict ? shape : "pill"
  const resolved = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? color! : DEFAULT_TAG_COLOR
  const label = color
    ? t.shapedColorTagTitle(shapeDict[resolvedShape])
    : t.defaultColorTagTitle

  return (
    <span
      data-slot="preset-tag"
      data-shape={resolvedShape}
      className={cn(marker({ shape: resolvedShape, size }), className)}
      style={
        resolvedShape === "ring"
          ? { borderColor: resolved }
          : { backgroundColor: resolved }
      }
      title={decorative ? label : undefined}
      aria-hidden={decorative ? "true" : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
    />
  )
}
