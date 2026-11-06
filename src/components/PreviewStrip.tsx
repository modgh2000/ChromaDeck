/// DPR-aware canvas that renders a calibration test pattern (grayscale ramp +
/// RGBCMY bars) on the LEFT half with neutral identity params and on the
/// RIGHT half with the given preset applied, providing a before/after preview.
///
/// SSR-safe: does not crash when `canvas.getContext` is unavailable.

import { useEffect, useRef } from "react";
import { applyPreviewPixel, type PreviewParams } from "../lib/preview";

export interface PreviewStripProps {
  preset: PreviewParams;
  height?: number;
  showTag?: boolean;
}

// — Test pattern data —————————————————————————————————————————————————

/** Grey values 0..1 for `steps` evenly-spaced grayscale patches. */
function graySteps(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => i / Math.max(1, steps - 1));
}

/** 6 RGBCMY colours. */
const colourBars: [number, number, number][] = [
  [1, 0, 0], // R
  [0, 1, 0], // G
  [0, 0, 1], // B
  [0, 1, 1], // C
  [1, 0, 1], // M
  [1, 1, 0], // Y
];

const GRAY_STEPS = 16;
const TOTAL_BARS = GRAY_STEPS + colourBars.length; // 22

// — Component ————————————————————————————————————————————————————————

export default function PreviewStrip({ preset, height = 72, showTag = false }: PreviewStripProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // SSR guard

    const container = containerRef.current;
    const logicalW = container ? container.getBoundingClientRect().width : 320;
    const logicalH = height;
    const scale = window.devicePixelRatio ?? 1;

    const w = Math.ceil(logicalW * scale);
    const h = Math.ceil(logicalH * scale);

    // Resize buffer only when needed
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const halfW = logicalW / 2;
    const barW = halfW / TOTAL_BARS;

    // — Left half: identity ————————————————————————————————————————
    const identity: PreviewParams = {
      brightness: 50,
      contrast: 50,
      gamma: 1.0,
      rgb_gains: [1, 1, 1],
      vibrance: 50,
      saturation: 50,
      hue_deg: 0,
    };

    drawPattern(ctx, identity, 0, barW, logicalH);

    // — Right half: applied preset —————————————————————————————————
    const rightOrigin = halfW;
    drawPattern(ctx, preset, rightOrigin, barW, logicalH);

    // — Center divider ————————————————————————————————————————————
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, logicalH);
    ctx.stroke();

    // — SIM tag ——————————————————————————————————————————————————
    if (showTag) {
      ctx.fillStyle = "rgba(139,143,163,0.6)"; // muted-foreground at 60 %
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("SIM", logicalW - 4, 2);
    }
  }, [preset, height, showTag]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: `${height}px` } as Record<string, string>}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Simulated preview of preset`}
        style={{ width: "100%", height: `${height}px`, display: "block" } as Record<string, string>}
      />
    </div>
  );
}

// — Drawing helpers ———————————————————————————————————————————————

function drawPattern(
  ctx: CanvasRenderingContext2D,
  params: PreviewParams,
  originX: number,
  barW: number,
  canvasH: number,
) {
  const grays = graySteps(GRAY_STEPS);
  let x = originX;

  // Grayscale bars (thin black -> white)
  for (const v of grays) {
    const c = applyPreviewPixel({ r: v, g: v, b: v }, params);
    ctx.fillStyle = rgba(c.r, c.g, c.b, 1);
    ctx.fillRect(x, 0, barW, canvasH);
    x += barW;
  }

  // RGBCMY colour bars (thicker)
  for (const [r, g, b] of colourBars) {
    const c = applyPreviewPixel({ r, g, b }, params);
    ctx.fillStyle = rgba(c.r, c.g, c.b, 1);
    ctx.fillRect(x, 0, barW, canvasH);
    x += barW;
  }
}

function rgba(r: number, g: number, b: number, a: number): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to255(r)},${to255(g)},${to255(b)},${a})`;
}
