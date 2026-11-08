// Draws the app icon (1024px PNG) from shapes, no image libraries, then builds icon.icns
// with macOS's own `sips` + `iconutil`. Run: node scripts/make-app-icon.js
const zlib = require("node:zlib");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const S = 1024, SS = 3; // size, supersamples per axis (anti-aliasing)
const cx = S / 2, cy = S / 2 + 30;

const rad = (d) => (d * Math.PI) / 180;
const pt = (deg, r) => [cx + r * Math.sin(rad(deg)), cy - r * Math.cos(rad(deg))]; // 0deg = top, clockwise

// Is (x,y) inside a rounded square?
function inTile(x, y) {
  const m = 100, r = 190, h = S / 2 - m;
  const dx = Math.max(Math.abs(x - S / 2) - (h - r), 0), dy = Math.max(Math.abs(y - S / 2) - (h - r), 0);
  return dx * dx + dy * dy <= r * r;
}
// Arc ring from angle a0..a1 with round caps
function inArc(x, y, a0, a1, R, T) {
  const d = Math.hypot(x - cx, y - cy);
  let ang = (Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI;
  if (ang < a0 - 180 + 360 - 360 && ang < a0) ang += 360;
  if (Math.abs(d - R) <= T / 2 && ang >= a0 && ang <= a1) return true;
  return [a0, a1].some((a) => { const [px, py] = pt(a, R); return Math.hypot(x - px, y - py) <= T / 2; });
}
function inNeedle(x, y, ang) {
  const [tx, ty] = pt(ang, 215);
  const vx = tx - cx, vy = ty - cy, wx = x - cx, wy = y - cy;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - vx * t, wy - vy * t) <= 20 * (1 - 0.35 * t) || Math.hypot(wx, wy) <= 55;
}

const START = -135, END = 135, VALUE = 45; // gauge sweep and "used" level
function sample(x, y) { // returns [r,g,b,a] 0..1 or null
  if (!inTile(x, y)) return null;
  const g = (x + y) / (2 * S); // diagonal gradient
  let c = [0.36 + (0.98 - 0.36) * g, 0.2 + (0.42 - 0.2) * g, 0.95 + (0.55 - 0.95) * g]; // indigo -> coral
  const over = (col, a) => { c = c.map((v, i) => v * (1 - a) + col[i] * a); };
  if (inArc(x, y, START, END, 280, 70)) over([1, 1, 1], 0.28);   // track
  if (inArc(x, y, START, VALUE, 280, 70)) over([1, 1, 1], 1);     // used part
  if (inNeedle(x, y, VALUE)) over([1, 1, 1], 1);
  return [...c, 1];
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
      const s = sample(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
      if (s) { r += s[0]; g += s[1]; b += s[2]; a++; }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4, n = SS * SS;
    raw[o] = a ? Math.round((r / a) * 255) : 0; raw[o + 1] = a ? Math.round((g / a) * 255) : 0;
    raw[o + 2] = a ? Math.round((b / a) * 255) : 0; raw[o + 3] = Math.round((a / n) * 255);
  }
}
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync("assets/icon.png", Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));

// PNG -> .icns (macOS wants a folder of specific sizes)
try {
  fs.rmSync("/tmp/quotapus.iconset", { recursive: true, force: true });
  fs.mkdirSync("/tmp/quotapus.iconset");
  for (const s of [16, 32, 128, 256, 512]) {
    execSync(`sips -z ${s} ${s} assets/icon.png --out /tmp/quotapus.iconset/icon_${s}x${s}.png`, { stdio: "ignore" });
    execSync(`sips -z ${s * 2} ${s * 2} assets/icon.png --out /tmp/quotapus.iconset/icon_${s}x${s}@2x.png`, { stdio: "ignore" });
  }
  execSync("iconutil -c icns /tmp/quotapus.iconset -o assets/icon.icns");
  console.log("wrote assets/icon.png and assets/icon.icns");
} catch (e) {
  console.error("icns build failed (needs macOS sips/iconutil):", e.message);
  process.exit(1);
}
