import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeTheme, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autostartEnabled, setAutostart } from "./autostart";
import { nextDelayMs } from "./backoff";
import { loadConfig, saveConfig } from "./config";
import { downsample, forecast } from "./forecast";
import { History } from "./history";
import { disable as disableStatusLine, enable as enableStatusLine, isEnabled as statusLineEnabled } from "./statusline";
import { gaugeIcon } from "./trayIcon";
import { createClaude } from "./providers/claude";
import { createCursor } from "./providers/cursor";
import { mock, mockCursor } from "./providers/mock";
import type { ProviderResult } from "./providers/types";

// Mock mode gets its own data dir: fake readings must never land in the real history.json, and a separate
// dir also means a separate single-instance lock, so a dev copy can run next to the installed app.
if (process.env.QUOTAPUS_MOCK) app.setPath("userData", path.join(os.tmpdir(), "quotapus-mock"));
const dataDir = app.getPath("userData");
const claudeSettings = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "settings.json");
const history = new History(dataDir);
const providers = process.env.QUOTAPUS_MOCK ? [mock, mockCursor] : [createClaude(dataDir), createCursor(dataDir)]; // add new providers here

if (!app.requestSingleInstanceLock()) app.quit(); // never two trays

const config = loadConfig();
const firstRun = !config.onboarded;
let tray: Tray;
let win: BrowserWindow;
let timer: NodeJS.Timeout | undefined;
interface Snapshot {
  results: ProviderResult[];
  updatedAt: number;     // last attempt
  lastOkAt: number;      // last time fresh data actually arrived (0 = never)
  nextRefreshAt: number; // when we'll try again
  welcome: boolean;
}
let latest: Snapshot = { results: [], updatedAt: 0, lastOkAt: 0, nextRefreshAt: 0, welcome: firstRun };
let failures = 0;              // consecutive failed refreshes, drives backoff
let inFlight: Promise<Snapshot> | null = null;
let blockedUntil = 0;          // don't call the API before this (server asked us to wait)
// The usage endpoint rate-limits aggressively and sends "Retry-After: 0" (useless), so we never poll faster than this.
const MIN_REFRESH_SEC = 300;
const WIN_W = 440; // popover width: wide enough for the usage chart
const STALE_AFTER_MS = 10 * 60_000;

// ---- data ----
// Safe to call from anywhere (timer, button, menu): overlapping calls share one request,
// and we never hit the API faster than the server allows.
function refresh(): Promise<Snapshot> {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now < blockedUntil || (latest.updatedAt && now - latest.updatedAt < 5000)) return Promise.resolve(latest);
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh(): Promise<Snapshot> {
  const fresh = await Promise.all(providers.map((p) => p.fetch()));
  // If a fetch fails but we have good data from before, keep showing it (flagged stale)
  // rather than blanking the UI. A wrong-but-labelled number beats an empty panel.
  const results = fresh.filter((r) => !r.hidden).map((r) => {
    const prev = latest.results.find((x) => x.id === r.id);
    return r.status === "error" && prev?.status === "ok" && prev.meters.length
      ? { ...prev, stale: true, message: r.message, action: r.action } : r;
  });
  attachForecasts(results);
  const now = Date.now();
  // A result that fell back to old data (stale) still means the live fetch failed, so it counts as a failure.
  failures = fresh.some((r) => (r.status === "error" && !r.recheckSec) || (r.stale && !r.recheckSec)) ? failures + 1 : 0;
  const retryAfter = Math.max(0, ...fresh.map((r) => r.retryAfterSec ?? 0));
  if (retryAfter) blockedUntil = now + retryAfter * 1000;
  latest = { ...latest, results, updatedAt: now, welcome: firstRun, lastOkAt: fresh.some((r) => r.status === "ok" && !r.stale) ? now : latest.lastOkAt };
  reschedule(retryAfter, Math.min(...fresh.map((r) => r.recheckSec ?? Infinity)));
  updateTray();
  notify(results);
  win.webContents.send("quota:updated", latest);
  return latest;
}

// (Re)start the timer for the next fetch. Also called when the user changes the interval.
// `recheckSec`: a local, free problem (like an expired login) is re-checked soon instead of backing off.
function reschedule(retryAfter = 0, recheckSec = Infinity) {
  const normal = nextDelayMs(Math.max(config.refreshSeconds, MIN_REFRESH_SEC), failures, retryAfter);
  const delay = Math.min(normal, recheckSec * 1000);
  clearTimeout(timer);
  timer = setTimeout(refresh, delay);
  latest.nextRefreshAt = Date.now() + delay;
}

// Which meter the menu bar shows: the one picked in settings, "max" = whichever is highest right now,
// otherwise (or if the picked one is gone, e.g. Cursor signed out) the first meter.
function trayMeter() {
  const all = latest.results.filter((r) => r.status === "ok").flatMap((r) => r.meters.map((m) => ({ r, m })));
  if (!all.length) return undefined;
  if (config.menuBarMeter === "max") return all.reduce((a, b) => (b.m.usedPercent > a.m.usedPercent ? b : a));
  return all.find((x) => `${x.r.id}|${x.m.label}` === config.menuBarMeter) ?? all[0];
}

function updateTray() {
  const pick = trayMeter();
  tray.setImage(gaugeIcon(pick ? pick.m.usedPercent : null)); // icon itself fills like a mini gauge
  // "~" = old data. A number in the menu bar that looks live but isn't is worse than no number.
  const old = latest.lastOkAt > 0 && Date.now() - latest.lastOkAt > STALE_AFTER_MS;
  tray.setTitle(config.showPercentInMenuBar && pick ? ` ${old ? "~" : ""}${Math.round(pick.m.usedPercent)}%` : "");
  tray.setToolTip(pick ? `${pick.r.name} · ${pick.m.label}: ${Math.round(pick.m.usedPercent)}% used${old ? " (old data)" : ""}` : "quotapus");
}

// Record each fresh reading, then predict from the recent history.
function attachForecasts(results: ProviderResult[]) {
  const now = Date.now();
  for (const r of results) {
    if (r.status !== "ok" || r.stale) continue; // never learn from stale data
    for (const m of r.meters) {
      const samples = history.record(`${r.id}|${m.label}`, now, m.usedPercent, m.resetsAt);
      m.forecast ??= forecast(samples, now, m.resetsAt);
      m.spark ??= downsample(samples, 60).map((x) => [x.t, x.p]);
    }
  }
}

// Warn once per threshold per quota window. The key includes the reset time (rounded to the
// minute, since the API's timestamp has jittery microseconds), so a new window = fresh warnings.
function notify(results: ProviderResult[]) {
  if (!config.notifications) return;
  for (const r of results) for (const m of r.meters) {
    const reset = m.resetsAt ? Math.round(Date.parse(m.resetsAt) / 60000) : "";
    // Early warning: at the current pace the limit arrives soon and before the reset.
    const f = m.forecast, fkey = `${r.id}|${m.label}|${reset}|forecast`;
    if (f?.hitsBeforeReset && f.minutesToLimit !== null && f.minutesToLimit <= 30 && !config.notified.includes(fkey)) {
      config.notified.push(fkey); saveConfig(config);
      new Notification({ title: `${r.name}: ${m.label} may run out in ~${f.minutesToLimit} min`, body: "At your current pace, before it resets." }).show();
    }
    const fresh = config.notifyAt.filter((t) => m.usedPercent >= t && !config.notified.includes(`${r.id}|${m.label}|${reset}|${t}`));
    if (!fresh.length) continue;
    fresh.forEach((t) => config.notified.push(`${r.id}|${m.label}|${reset}|${t}`));
    config.notified = config.notified.slice(-200);
    saveConfig(config);
    new Notification({ title: `${r.name}: ${Math.round(m.usedPercent)}% of ${m.label} used`, body: m.resetsAt ? `Resets ${new Date(m.resetsAt).toLocaleString()}` : "" }).show();
  }
}


// ---- menu (right-click the tray icon, or the ⋯ button in the popup) ----
function buildMenu() {
  const toggle = (label: string, key: "showPercentInMenuBar" | "notifications") => ({
    label, type: "checkbox" as const, checked: config[key],
    click: () => { config[key] = !config[key]; saveConfig(config); updateTray(); },
  });
  return Menu.buildFromTemplate([
    { label: `quotapus v${app.getVersion()}`, enabled: false }, // handy for "which build is actually running?"
    { type: "separator" },
    { label: "Refresh now", click: () => refresh() },
    { label: "Settings…", click: () => { showWindow(); win.webContents.send("ui:settings"); } },
    { type: "separator" },
    toggle("Show % in menu bar", "showPercentInMenuBar"),
    toggle("Usage notifications", "notifications"),
    { label: "Launch at login", type: "checkbox", checked: autostartEnabled(), click: (i) => setAutostart(i.checked) },
    { type: "separator" },
    { label: "Quit quotapus", click: () => app.quit() },
  ]);
}

// ---- settings (the popup's settings view talks to these two handlers) ----
function readSettings() {
  const { showPercentInMenuBar, notifications, notifyAt, refreshSeconds } = config;
  // Choices for "Menu bar shows": every meter we currently know about.
  const meters = latest.results.filter((r) => r.status === "ok").flatMap((r) => r.meters.map((m) => ({ key: `${r.id}|${m.label}`, name: `${r.name} · ${m.label}` })));
  const picked = trayMeter();
  return {
    showPercentInMenuBar, notifications, notifyAt, refreshSeconds: Math.max(refreshSeconds, MIN_REFRESH_SEC),
    launchAtLogin: autostartEnabled(), claudeStatusLine: statusLineEnabled(claudeSettings, dataDir),
    menuBarMeter: config.menuBarMeter === "max" ? "max" : picked ? `${picked.r.id}|${picked.m.label}` : "", meters,
    hasClaude: latest.results.some((r) => r.id === "claude"), version: app.getVersion(),
  };
}

// The renderer is untrusted input: whitelist the keys we know and validate every value.
function applySettings(p: Record<string, unknown>) {
  if (typeof p.showPercentInMenuBar === "boolean") config.showPercentInMenuBar = p.showPercentInMenuBar;
  if (typeof p.notifications === "boolean") config.notifications = p.notifications;
  if (typeof p.launchAtLogin === "boolean") setAutostart(p.launchAtLogin);
  if (typeof p.menuBarMeter === "string" && p.menuBarMeter.length <= 200) config.menuBarMeter = p.menuBarMeter;
  if (typeof p.refreshSeconds === "number" && [300, 600, 900].includes(p.refreshSeconds)) config.refreshSeconds = p.refreshSeconds;
  if (Array.isArray(p.notifyAt) && p.notifyAt.length <= 6 && p.notifyAt.every((n) => Number.isInteger(n) && n >= 1 && n <= 100)) {
    config.notifyAt = [...new Set(p.notifyAt as number[])].sort((a, b) => a - b);
  }
  let error: string | undefined;
  if (typeof p.claudeStatusLine === "boolean") {
    try { (p.claudeStatusLine ? enableStatusLine : disableStatusLine)(claudeSettings, dataDir); }
    catch (e) { error = (e as Error).message; }
  }
  saveConfig(config);
  reschedule();
  updateTray();
  if (p.claudeStatusLine === true && !error) { blockedUntil = 0; refresh(); } // pick up data right away
  return { ...readSettings(), error };
}

// ---- window ----
function createWindow() {
  win = new BrowserWindow({
    width: WIN_W, height: 300, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, vibrancy: "popover", visualEffectState: "active",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer/index.html"), { hash: process.env.QUOTAPUS_VIEW }); // dev: settings | expand
  win.on("blur", () => win.hide()); // click away = close, like a native popover
}

// Tallest the popup may get: 720, or less if the screen below the menu bar is shorter. Past that, content scrolls.
function maxHeight() {
  const t = tray.getBounds(), area = screen.getDisplayNearestPoint({ x: t.x, y: t.y }).workArea;
  return Math.max(300, Math.min(720, area.y + area.height - (t.y + t.height + 4) - 12));
}

function showWindow() {
  const t = tray.getBounds();
  const w = win.getBounds();
  win.setPosition(Math.round(t.x + t.width / 2 - w.width / 2), t.y + t.height + 4);
  win.show();
}

app.whenReady().then(async () => {
  app.dock?.hide(); // menu-bar only, no dock icon
  tray = new Tray(gaugeIcon(null));
  tray.on("click", () => (win.isVisible() ? win.hide() : showWindow()));
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));
  createWindow();

  ipcMain.handle("quota:get", () => latest);
  ipcMain.handle("quota:refresh", refresh);
  ipcMain.handle("provider:action", async (_e, id: unknown, action: unknown) => {
    const p = providers.find((x) => x.id === id);
    if (action !== "refresh-login" || !p?.refreshLogin) return { ok: false, message: "Unknown action." };
    const r = await p.refreshLogin();
    blockedUntil = 0; latest.updatedAt = 0; // let the next refresh through right away
    await refresh();
    return r;
  });
  ipcMain.handle("settings:get", readSettings);
  ipcMain.handle("settings:set", (_e, p) => applySettings(p ?? {}));
  ipcMain.on("ui:hide", () => win.hide());
  ipcMain.on("ui:quit", () => app.quit());
  ipcMain.on("ui:resize", (_e, h: number) => win.setContentSize(WIN_W, Math.max(120, Math.min(maxHeight(), Math.ceil(h)))));

  await refresh();

  // First launch: open the popup by itself so the user sees where the app lives.
  if (firstRun) { showWindow(); config.onboarded = true; saveConfig(config); }

  // Dev helper: QUOTAPUS_SNAPSHOT=/tmp/x.png npm start  -> saves a screenshot of the popup and quits.
  // Optional: QUOTAPUS_THEME=light|dark and QUOTAPUS_BG=#hex give a solid backdrop (the real window is translucent,
  // which captures as transparent), so screenshots are usable for the README / website.
  const snap = process.env.QUOTAPUS_SNAPSHOT;
  if (snap) {
    if (process.env.QUOTAPUS_THEME === "light" || process.env.QUOTAPUS_THEME === "dark") nativeTheme.themeSource = process.env.QUOTAPUS_THEME;
    if (process.env.QUOTAPUS_BG) await win.webContents.insertCSS(`body { background: ${process.env.QUOTAPUS_BG.replace(/[^#0-9a-zA-Z]/g, "")} !important }`);
    showWindow();
    setTimeout(async () => { fs.writeFileSync(snap, (await win.webContents.capturePage()).toPNG()); app.quit(); }, 1200);
  }
});
