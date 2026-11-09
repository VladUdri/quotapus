import type { Provider } from "./types";

// Fake data for UI work and screenshots: QUOTAPUS_MOCK=1 npm start
// Fake readings that rise through the window, for the chart. n points ending now.
const spark = (end: number, startedHoursAgo: number): [number, number][] =>
  Array.from({ length: 24 }, (_, i) => [Date.now() - startedHoursAgo * 3600_000 * (1 - i / 23), (end * (i / 23)) ** 1 * (0.85 + 0.15 * Math.sin(i))]);
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
// QUOTAPUS_MOCK=errors shows the problem states instead (expired login, unreachable service).
const errors = process.env.QUOTAPUS_MOCK === "errors";
export const mock: Provider = {
  id: "claude", name: "Claude",
  async refreshLogin() { return { ok: false, message: "Mock: couldn't refresh." }; },
  async fetch() {
    if (errors) return { id: "claude", name: "Claude", status: "error", plan: "Max", action: "refresh-login", meters: [],
      message: "Claude Code's login has expired (it lasts about 8 hours and renews whenever Claude Code is used)." };
    return { id: "claude", name: "Claude", status: "ok", plan: "Max", meters: [
      { label: "5-hour session", windowMinutes: 300, spark: spark(37, 1.8), usedPercent: 37, resetsAt: inHours(3.2), forecast: { ratePerHour: 38, minutesToLimit: 99, hitsBeforeReset: true }, breakdown: [{ name: "quotapus", share: 62 }, { name: "blog", share: 25 }, { name: "Other", share: 13 }] },
      { label: "Weekly", windowMinutes: 10080, spark: spark(72, 71), usedPercent: 72, resetsAt: inHours(97), forecast: { ratePerHour: 0.4, minutesToLimit: 4200, hitsBeforeReset: false } },
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
    const cycle = { windowMinutes: 30 * 1440, resetsAt: inHours(14 * 24 + 5) };
    return { id: "cursor", name: "Cursor", status: "ok", plan: "Pro", meters: [
      { label: "Monthly plan", ...cycle, spark: spark(46, 15 * 24), usedPercent: 46, forecast: { ratePerHour: 0.13, minutesToLimit: null, hitsBeforeReset: false } },
      { label: "Auto + Composer", ...cycle, spark: spark(31, 15 * 24), usedPercent: 31, forecast: { ratePerHour: 0.08, minutesToLimit: null, hitsBeforeReset: false } },
      { label: "Named models (API)", ...cycle, spark: spark(68, 15 * 24), usedPercent: 68, forecast: { ratePerHour: 0.3, minutesToLimit: 6400, hitsBeforeReset: true } },
    ] };
  },
};
