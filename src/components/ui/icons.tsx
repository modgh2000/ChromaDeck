/**
 * Figma-drawn glyphs (ChromaDeck file EHlovtcAS9y24GrizBL0WM).
 * Each path is the exact geometry exported from Figma, stroked with
 * `currentColor` so callers control the tone (mint / muted / ink).
 */

type GlyphProps = { className?: string };

/** Monitor body – Figma Icon 24 × 16.94, 1.5px hairline. */
export function MonitorGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 16.941"
      width="24"
      height="16.941"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
      aria-hidden="true"
    >
      <rect x="0.75" y="0.75" width="22.5" height="15.441" rx="0.5" />
    </svg>
  );
}

/** Reset / rotate-ccw – Figma Icon 14.5 × 14.5. */
export function ResetGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 14.5 14.5"
      width="14.5"
      height="14.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M13.75 4.57353C12.9832 3.40725 11.7996 2.49574 10.3827 1.98038C8.96585 1.46502 7.39492 1.37461 5.91357 1.72316C4.43222 2.07171 3.12324 2.83975 2.18964 3.90816C1.25604 4.97658 0.75 6.28565 0.75 7.63235C0.75 8.97906 1.25604 10.2881 2.18964 11.3565C3.12324 12.425 4.43222 13.193 5.91357 13.5415C7.39492 13.8901 8.96585 13.7997 10.3827 13.2843C11.7996 12.769 12.9832 11.8575 13.75 10.6912" />
      <path d="M13.75 0.75V4.75H9.75" />
    </svg>
  );
}

/** Probe / scan-with-axis — Figma Icon 14.5 × 14.5. */
export function ProbeGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 14.5 14.5"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4.36111 0.75H0.75V4.36111M10.1389 0.75H13.75V4.36111M0.75 10.1389V13.75H4.36111M13.75 10.1389V13.75H10.1389M7.25 0.75V13.75M0.75 7.25H13.75" />
    </svg>
  );
}

/** Identify (corners + axis) — Figma Icon 15.5 × 15.5. */
export function IdentifyGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 15.5 15.5"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4.63889 0.75H0.75V4.63889M10.8611 0.75H14.75V4.63889M0.75 10.8611V14.75H4.63889M14.75 10.8611V14.75H10.8611M7.75 0.75V14.75M0.75 7.75H14.75" />
    </svg>
  );
}

/** Chevron down – Figma Icon 12 × 7. */
export function ChevronDownGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 12 7"
      width="12"
      height="7"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M1 1L6 6L11 1" />
    </svg>
  );
}

/** Carousel right arrow – Figma Icon 12 × 12. */
export function ArrowRightGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 13.6875 13.5"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M0.75 6.75004H12.75M8.25 12.75L12.75 6.75004L8.25 0.750044" />
    </svg>
  );
}

/** Carousel left arrow – mirror of ArrowRightGlyph. */
export function ArrowLeftGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 13.6875 13.5"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12.75 6.75004H0.75M4.75 12.75L0.75 6.75004L4.75 0.750044" />
    </svg>
  );
}

/** Trailing "+" – Figma Trailing icon circle glyph (32px circle provides the disc). */
export function PlusGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M16 8V16M16 16V24M16 16H8M16 16H24" />
    </svg>
  );
}

/** Trailing long arrow – Figma primary Button trailing circle glyph. */
export function TrailingArrowGlyph({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 16H24M18 24L24 16L18 8" />
    </svg>
  );
}
