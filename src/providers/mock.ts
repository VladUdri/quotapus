import type { Provider, QuotaMeter } from "./types";
import { eventCurve, fillGaps } from "../backfill";
import { attachHistory } from "./cursor";

// Fake data for UI work and screenshots: QUOTAPUS_MOCK=1 npm start
// Fake readings that rise through the window, for the chart. n points ending now.
const spark = (end: number, startedHoursAgo: number): [number, number][] =>
  Array.from({ length: 24 }, (_, i) => [Date.now() - startedHoursAgo * 3600_000 * (1 - i / 23), (end * (i / 23)) ** 1 * (0.85 + 0.15 * Math.sin(i))]);
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const H = 3600_000;
// Fake activity: requests during working hours on weekdays (deterministic, so screenshots are stable).
function workEvents(fromMs: number, now: number, perHour: number) {
  const out: { t: number; w: number; model: string }[] = [];
  for (let t = fromMs, i = 0; t < now; t += 20 * 60_000, i++) {
    const d = new Date(t), h = d.getHours(), wd = d.getDay();
    if (wd === 0 || wd === 6 || h < 9 || h > 18) continue;
    out.push({ t, w: perHour * (0.4 + ((i * 7919) % 13) / 10), model: ["claude-4.5-sonnet", "gpt-5", "auto", "claude-4.1-opus"][i % 7 % 4] });
  }
  return out;
}
// What main.ts would build from a curve, done here too so scripts/make-demo.js (which skips main.ts) gets charts.
const sparkFrom = (m: QuotaMeter, exact: boolean) => {
  if (!m.curve) return;
  const ws = Date.parse(m.resetsAt!) - m.windowMinutes! * 60_000;
  const pts = exact ? m.curve : fillGaps([{ t: Date.now(), p: m.usedPercent }], m.curve, ws);
  m.spark = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1).map((x) => ("est" in x && x.est ? [x.t, x.p, 1] : [x.t, x.p]));
};
// QUOTAPUS_MOCK=errors shows the problem states instead (expired login, unreachable service).
const errors = process.env.QUOTAPUS_MOCK === "errors";
export const mock: Provider = {
  id: "claude", name: "Claude",
  async refreshLogin() { return { ok: false, message: "Mock: couldn't refresh." }; },
  async fetch() {
    if (errors) return { id: "claude", name: "Claude", status: "error", plan: "Max", action: "refresh-login", meters: [],
      message: "Claude Code's login has expired (it lasts about 8 hours and renews whenever Claude Code is used)." };
    const now = Date.now();
    const weekly: QuotaMeter = { label: "Weekly", windowMinutes: 10080, usedPercent: 72, resetsAt: inHours(97), forecast: { ratePerHour: 0.4, minutesToLimit: 4200, hitsBeforeReset: false } };
    const ev = workEvents(now - 28 * 24 * H, now, 1e5);
    weekly.curve = eventCurve(ev, now - 71 * H, now, 72) ?? undefined; sparkFrom(weekly, false);
    weekly.daily = Array.from({ length: 28 }, (_, i) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 27 + i);
      return { t: d.getTime(), v: ev.filter((e) => e.t >= d.getTime() && e.t < d.getTime() + 24 * H).reduce((s, e) => s + e.w, 0) }; });
    weekly.dailyUnit = "tokens";
    return { id: "claude", name: "Claude", status: "ok", plan: "Max", meters: [
      { label: "5-hour session", windowMinutes: 300, spark: spark(37, 1.8), usedPercent: 37, resetsAt: inHours(3.2), forecast: { ratePerHour: 38, minutesToLimit: 99, hitsBeforeReset: true }, breakdown: [{ name: "quotapus", share: 62 }, { name: "blog", share: 25 }, { name: "Other", share: 13 }] },
      weekly,
      { label: "Weekly (Opus)", windowMinutes: 10080, usedPercent: 93, resetsAt: inHours(97), forecast: { ratePerHour: 9, minutesToLimit: 47, hitsBeforeReset: true } },
      { label: "Weekly (Sonnet)", windowMinutes: 10080, usedPercent: 8, resetsAt: inHours(97) },
    ] };
  },
};

// A Cursor Pro account mid-way through its monthly billing cycle.
export const mockCursor: Provider = {
  id: "cursor", name: "Cursor",
  async fetch() {
    if (errors) return { id: "cursor", name: "Cursor", status: "error", meters: [], message: "Couldn't reach Cursor (fetch failed)." };
    const cycle = { windowMinutes: 30 * 1440, resetsAt: inHours(14 * 24 + 5) }, now = Date.now();
    const total: QuotaMeter = { label: "Monthly plan", ...cycle, usedPercent: 46 };
    attachHistory([total], workEvents(now - 28 * 24 * H, now, 12).map((e) => ({ t: e.t, charged: e.w, list: 0, tokens: 0, model: e.model })), now);
    sparkFrom(total, true);
    return { id: "cursor", name: "Cursor", status: "ok", plan: "Pro", meters: [
      total,
      { label: "Auto + Composer", ...cycle, spark: spark(31, 15 * 24), usedPercent: 31, forecast: { ratePerHour: 0.08, minutesToLimit: null, hitsBeforeReset: false } },
      { label: "Named models (API)", ...cycle, spark: spark(68, 15 * 24), usedPercent: 68, forecast: { ratePerHour: 0.3, minutesToLimit: 6400, hitsBeforeReset: true } },
    ] };
  },
};
