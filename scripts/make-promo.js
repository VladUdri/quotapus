// Records the promo video: plays scripts/promo/stage.html (a scripted story around the real popup with mock data)
// in an offscreen 1920x1080 window, saves every painted frame, then encodes an H.264 MP4. No ffmpeg needed.
// Run: npm run build && node_modules/.bin/electron scripts/make-promo.js [out.mp4]
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mock, mockCursor } = require("../dist/providers/mock.js");

const W = 1920, H = 1080, FPS = 30;
// PROMO_WIDTH=1280 PROMO_BITRATE=2e6 makes a lighter cut for the website.
const OUT_W = Number(process.env.PROMO_WIDTH) || W;
const OUT = path.resolve(process.argv.find((a) => a.endsWith(".mp4")) ?? "promo/quotapus-promo.mp4");
const FRAMES = fs.mkdtempSync(path.join(os.tmpdir(), "quotapus-promo-"));
app.setPath("userData", path.join(FRAMES, "profile")); // never touch the real app's data
setTimeout(() => { console.error("timed out"); app.exit(1); }, 180_000);

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  ipcMain.handle("promo:snapshot", async () => {
    const now = Date.now();
    return { results: [await mock.fetch(), await mockCursor.fetch()], updatedAt: now, lastOkAt: now, nextRefreshAt: now + 3e5, welcome: false, activeProviders: 2 };
  });
  ipcMain.handle("promo:popup", () => fs.readFileSync(path.join(__dirname, "../dist/renderer/index.html"), "utf8"));

  const stage = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, "promo/preload.js") } });
  stage.webContents.setFrameRate(FPS);
  stage.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.log("[stage]", msg); });

  // Paints arrive only when something changed; remember when each one came, fill the gaps when encoding.
  const shots = [], marks = {}; let t0 = 0;
  stage.webContents.on("paint", (_e, _dirty, image) => {
    if (!t0) return;
    // Frames come at the screen's scale (4K on Retina). Saved as is: resizing here is too slow for real time,
    // and the encoder's downscale doubles as anti-aliasing.
    const file = path.join(FRAMES, `f${String(shots.length).padStart(5, "0")}.jpg`);
    fs.writeFile(file, image.toJPEG(92), () => {});
    shots.push({ t: performance.now() - t0, file });
  });

  const finished = new Promise((resolve, reject) => {
    ipcMain.on("promo:start", () => { t0 = performance.now(); stage.webContents.invalidate(); console.log("recording…"); });
    ipcMain.on("promo:mark", (_e, name) => { if (t0 && typeof name === "string") marks[name] = (performance.now() - t0) / 1000; });
    ipcMain.on("promo:done", () => resolve(performance.now() - t0));
    ipcMain.on("promo:fail", (_e, m) => reject(new Error(m)));
  });
  await stage.loadFile(path.join(__dirname, "promo/stage.html"));
  const duration = await finished;

  // One entry per output frame: the latest paint at that moment.
  const n = Math.round(duration / 1000 * FPS);
  let frames = [];
  for (let i = 0, j = 0; i < n; i++) {
    while (j + 1 < shots.length && shots[j + 1].t <= i * 1000 / FPS) j++;
    frames.push(shots[j].file);
  }
  // PROMO_CLIP="desk+0.6,trust-0.5" keeps only that stretch (scene marks plus/minus seconds), e.g. a silent website loop.
  if (process.env.PROMO_CLIP) {
    const at = (spec) => { const m = /^(\w+)([+-][\d.]+)?$/.exec(spec.trim()); if (!m || !(m[1] in marks)) throw new Error("bad PROMO_CLIP: " + spec); return marks[m[1]] + Number(m[2] || 0); };
    const [a, b] = process.env.PROMO_CLIP.split(",").map(at);
    frames = frames.slice(Math.round(a * FPS), Math.round(b * FPS));
  }
  const gaps = shots.slice(1).map((x, i) => x.t - shots[i].t);
  console.log(`paint gaps over 50 ms: ${gaps.filter((g) => g > 50).length}, longest ${Math.max(...gaps).toFixed(0)} ms`);
  if (process.env.PROMO_DEBUG) console.log(gaps.map((g, i) => [shots[i].t / 1000, g]).filter(([, g]) => g > 150).map(([t, g]) => `${t.toFixed(1)}s+${g.toFixed(0)}`).join(" "));
  console.log(`recorded ${(duration / 1000).toFixed(1)}s: ${shots.length} paints -> ${n} frames; encoding…`);

  const enc = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await enc.loadFile(path.join(__dirname, "promo/encode.html"));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const size = await enc.webContents.executeJavaScript(`encode(${JSON.stringify({ frames, fps: FPS, width: OUT_W, height: Math.round(OUT_W * H / W / 2) * 2, out: OUT, bitrate: Number(process.env.PROMO_BITRATE) || 8e6, marks: process.env.PROMO_SILENT || process.env.PROMO_CLIP ? null : marks })})`);
  console.log("scene marks (s):", JSON.stringify(marks, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));
  const levels = await enc.webContents.executeJavaScript("window.levels || null");
  if (levels) console.log("music level per second (dBFS RMS):", levels.join(" "));
  // A still for the poster: the end card, or PROMO_POSTER_AT seconds into the output.
  const { nativeImage } = require("electron");
  const pi = process.env.PROMO_POSTER_AT ? Math.min(frames.length - 1, Math.round(Number(process.env.PROMO_POSTER_AT) * FPS)) : frames.length - 1;
  fs.writeFileSync(OUT.replace(/\.mp4$/, "-poster.jpg"), nativeImage.createFromPath(frames[pi]).resize({ width: W, quality: "best" }).toJPEG(92));
  console.log("wrote", OUT, (size / 1e6).toFixed(1) + " MB");
  fs.rmSync(FRAMES, { recursive: true, force: true });
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
