// Generates the tray icon (a gauge ring) as PNG without any image libraries.
// "Template" in the filename tells macOS to tint it for light/dark menu bars.
const zlib = require("node:zlib");
const fs = require("node:fs");

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2, R = size * 0.42, T = size * 0.11;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      let a = Math.max(0, Math.min(1, T / 2 + 0.5 - Math.abs(d - R)));
      const ang = Math.atan2(dx, -dy) * 180 / Math.PI; // 0 = top, clockwise
      if (ang > 40 && ang < 140) a = 0; // gap on the right, gauge-style
      const needle = Math.hypot(dx - dy * 0 , dy) < size * 0.1 ? 1 : 0; // center dot
      a = Math.max(a, needle);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = raw[i + 1] = raw[i + 2] = 0; raw[i + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync("assets/iconTemplate.png", png(16));
fs.writeFileSync("assets/iconTemplate@2x.png", png(32));
