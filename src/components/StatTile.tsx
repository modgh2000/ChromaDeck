import { type ReactNode } from "react";

/**
 * Figma StatTile: a bare label/value stack (no well, no border).
 * Label — mono 9px muted; value — mono 17px, mint when non-neutral.
 * Double-Bezel wells were removed in the premium redesign.
 */
interface StatTileProps {
  label: string;
  value: string;
  neutral: boolean;
  size?: "16" | "20" | "24" | "32";
}

const valueSizes = {
  "16": "text-[15px]",
  "20": "text-[17px]",
  "24": "text-[17px]",
  "32": "text-[22px]",
} as const;

export default function StatTile({ label, value, neutral, size = "24" }: StatTileProps): ReactNode {
  const valueSize = valueSizes[size] ?? "text-[17px]";
  return (
    <div className="flex min-w-0 flex-col items-start gap-[2px] overflow-hidden">
      <span className="w-full truncate font-mono text-[9px] leading-[1.4] text-muted-foreground">
        {label}
      </span>
      <span
        className={`font-mono ${valueSize} leading-[1.1] tabular-nums whitespace-nowrap ${neutral ? "text-foreground" : "text-primary"} value-swap`}
      >
        {value}
      </span>
    </div>
  );
}
