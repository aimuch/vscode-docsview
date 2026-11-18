// Pure RGBA pixel-diff computation for visual Image Diff (Slider / Onion Skin / Pixel Heatmap).

export interface PixelDiffResult {
  out: Uint8ClampedArray;
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  /** Fraction in `[0..1]` of pixels whose per-channel difference exceeds `tolerance`. */
  ratio: number;
}

/**
 * Compares two RGBA buffers pixel-by-pixel across `max(wA, wB) × max(hA, hB)`.
 * Matching pixels are rendered in subtle dimmed grayscale; changed pixels highlight in vivid rose-red.
 */
export function computePixelDiff(
  rgbaA: Uint8ClampedArray,
  wA: number,
  hA: number,
  rgbaB: Uint8ClampedArray,
  wB: number,
  hB: number,
  tolerance = 8,
): PixelDiffResult {
  const width = Math.max(1, wA, wB);
  const height = Math.max(1, hA, hB);
  const totalPixels = width * height;
  const out = new Uint8ClampedArray(totalPixels * 4);
  let changedPixels = 0;

  for (let y = 0; y < height; y++) {
    const inAH = y < hA;
    const inBH = y < hB;
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const inA = inAH && x < wA;
      const inB = inBH && x < wB;
      if (!inA || !inB) {
        changedPixels++;
        out[di] = 244;
        out[di + 1] = 63;
        out[di + 2] = 94;
        out[di + 3] = 235;
        continue;
      }
      const ai = (y * wA + x) * 4;
      const bi = (y * wB + x) * 4;
      const dr = Math.abs(rgbaA[ai] - rgbaB[bi]);
      const dg = Math.abs(rgbaA[ai + 1] - rgbaB[bi + 1]);
      const db = Math.abs(rgbaA[ai + 2] - rgbaB[bi + 2]);
      const da = Math.abs(rgbaA[ai + 3] - rgbaB[bi + 3]);
      const maxDelta = Math.max(dr, dg, db, da);
      if (maxDelta > tolerance) {
        changedPixels++;
        const strength = Math.min(1, 0.45 + (maxDelta / 255) * 0.55);
        out[di] = 239;
        out[di + 1] = Math.round(68 * (1 - strength * 0.5));
        out[di + 2] = Math.round(68 * (1 - strength * 0.5));
        out[di + 3] = Math.round(180 + 75 * strength);
      } else {
        const lum = Math.round(0.299 * rgbaA[ai] + 0.587 * rgbaA[ai + 1] + 0.114 * rgbaA[ai + 2]);
        out[di] = lum;
        out[di + 1] = lum;
        out[di + 2] = lum;
        out[di + 3] = Math.round(rgbaA[ai + 3] * 0.35);
      }
    }
  }

  return {
    out,
    width,
    height,
    changedPixels,
    totalPixels,
    ratio: totalPixels > 0 ? changedPixels / totalPixels : 0,
  };
}
