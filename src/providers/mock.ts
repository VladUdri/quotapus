import type { Provider } from "./types";

// Fake data for UI work and screenshots: QUOTAPUS_MOCK=1 npm start
// Fake readings that rise through the window, for the chart. n points ending now.
const spark = (end: number, startedHoursAgo: number): [number, number][] =>
  Array.from({ length: 24 }, (_, i) => [Date.now() - startedHoursAgo * 3600_000 * (1 - i / 23), (end * (i / 23)) ** 1 * (0.85 + 0.15 * Math.sin(i))]);
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
export const mock: Provider = {
  id: "claude", name: "Claude",
  async fetch() {
    return { id: "claude", name: "Claude", status: "ok", plan: "Max", meters: [
      { label: "5-hour session", windowMinutes: 300, spark: spark(37, 1.8), usedPercent: 37, resetsAt: inHours(3.2), forecast: { ratePerHour: 38, minutesToLimit: 99, hitsBeforeReset: true }, breakdown: [{ name: "quotapus", share: 62 }, { name: "blog", share: 25 }, { name: "Other", share: 13 }] },
      { label: "Weekly", windowMinutes: 10080, spark: spark(72, 71), usedPercent: 72, resetsAt: inHours(97), forecast: { ratePerHour: 0.4, minutesToLimit: 4200, hitsBeforeReset: false } },
      { label: "Weekly (Opus)", windowMinutes: 10080, usedPercent: 93, resetsAt: inHours(97), forecast: { ratePerHour: 9, minutesToLimit: 47, hitsBeforeReset: true } },
      { label: "Weekly (Sonnet)", windowMinutes: 10080, usedPercent: 8, resetsAt: inHours(97) },
    ] };
  },
};
