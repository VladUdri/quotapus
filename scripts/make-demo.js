// Records assets/demo.gif: drives the real popup (with fake data) through a short story and encodes the frames.
// Run: npm run build && node_modules/.bin/electron scripts/make-demo.js --user-data-dir=/tmp/qp-demo
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const { mock } = require("../dist/providers/mock.js");

const W = 400, THEME = process.env.DEMO_THEME === "light" ? "light" : "dark";
const BG = THEME === "dark" ? "#1e1e20" : "#f5f5f7";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  nativeTheme.themeSource = THEME;
  const snapshot = async () => { const r = await mock.fetch(); return { results: [r], updatedAt: Date.now(), lastOkAt: Date.now(), nextRefreshAt: Date.now() + 3e5, welcome: false }; };
  ipcMain.handle("quota:get", snapshot);
  ipcMain.handle("quota:refresh", snapshot);
  ipcMain.handle("settings:get", () => ({}));
  ipcMain.on("ui:resize", () => {});

  const win = new BrowserWindow({ width: 440, height: 700, useContentSize: true, show: false, backgroundColor: BG,
    webPreferences: { preload: path.join(__dirname, "../dist/preload.js"), backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "../dist/renderer/index.html"));
  win.webContents.insertCSS(`html, body { background: ${BG} !important }`);

  const js = (code) => win.webContents.executeJavaScript(code);
  const gif = GIFEncoder();
  const frame = async (delay) => {
    const img = (await win.webContents.capturePage()).resize({ width: W });
    const { width, height } = img.getSize();
    const bgra = img.toBitmap(), rgba = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay });
  };
  const hold = async (ms, step = 100) => { for (let t = 0; t < ms; t += step) { await frame(step); await sleep(step); } };
  const hover = (f) => js(`(() => { const r = [...document.querySelectorAll('rect')].find((x) => x.getAttribute('fill') === 'transparent'); if (!r) return;
    const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('mousemove', { clientX: b.left + b.width * ${f}, clientY: b.top + 20, bubbles: true })); })()`);

  await sleep(900);
  await hold(1400);                                   // collapsed: ring settles
  await js(`document.querySelector('.hero').click()`); // open the Runway panel
  await sleep(700); await hold(1600);
  for (const f of [0.15, 0.4, 0.62, 0.8, 0.93]) { await hover(f); await sleep(80); await hold(500, 125); }  // tooltip follows the pointer
  await js(`[...document.querySelectorAll('rect')].find((x) => x.getAttribute('fill') === 'transparent')?.dispatchEvent(new MouseEvent('mouseleave'))`);
  await js(`document.querySelector('.hero').click()`); // collapse
  await sleep(500); await hold(500);
  await js(`document.querySelector('.row').click()`);  // open Weekly
  await sleep(700); await hold(1300);
  await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === '24h')?.click()`);
  await sleep(700); await hold(2200);

  gif.finish();
  const out = path.join(__dirname, `../assets/demo${THEME === "light" ? "-light" : ""}.gif`);
  fs.writeFileSync(out, Buffer.from(gif.bytes()));
  console.log("wrote", out, (fs.statSync(out).size / 1024).toFixed(0) + " KB");
  app.quit();
});
