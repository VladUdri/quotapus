import { nativeImage, NativeImage } from "electron";

// Draws the menu bar icon at runtime: a ring that fills clockwise from the top.
// We hand macOS raw pixels (BGRA) and mark it as a "template" image, so the system
// tints it white/black to match the menu bar. (Template images only use the alpha channel.)
export function gaugeIcon(percent: number | null): NativeImage {
  const size = 32, scale = 2; // 32px bitmap = 16pt on a retina screen
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, R = 11.5, T = 3.4;
  const frac = percent === null ? 0 : Math.max(0, Math.min(1, percent / 100));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - c, dy = y - c;
    const ring = Math.max(0, Math.min(1, T / 2 + 0.5 - Math.abs(Math.hypot(dx, dy) - R)));
    const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1; // 0..1 clockwise from top
    const filled = percent !== null && turn <= frac;
    const dot = Math.max(0, Math.min(1, 3.2 - Math.hypot(dx, dy) + 0.5)); // center dot
    const a = Math.max(ring * (filled ? 1 : 0.35), dot * 0.0 + (percent === null ? dot : 0));
    const i = (y * size + x) * 4;
    buf[i + 3] = Math.round(a * 255); // B,G,R stay 0 (black); alpha is what matters
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: scale });
  img.setTemplateImage(true);
  return img;
}
