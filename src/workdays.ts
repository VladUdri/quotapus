import type { Sample } from "./forecast";
import { valueAt } from "./backfill";
import type { Forecast } from "./providers/types";

// Forecasts that know you don't work every day.
//
// A plain forecast spreads recent usage evenly over the calendar, so someone who only uses Cursor on weekdays
// gets told "runs out in 20 days" when it's really 14 working days. Instead we learn a weekly profile from
// history: how much of an average day each weekday is (Mon 1.3, Sat 0, ...). Then:
//   rate  = usage over the last 7 days / profile weight of those 7 days     (% per "average day")
//   p(t)  = p(now) + rate * profile weight between now and t                (flat on days off)
// Pure functions, local time (that's what "Monday" means to the user).

export type Weights = number[]; // 7 entries, index = Date.getDay() (0 = Sunday); mean 1
const DAY = 86_400_000;
const ACTIVE = 0.25; // a weekday counts as a working day if it's at least a quarter of an average day

// Learn the profile from per-day totals (oldest first, today last). Needs two weeks since first use;
// today is skipped (it isn't over). null = not enough history.
export function learnWeights(daily: { t: number; v: number }[]): Weights | null {
  const first = daily.findIndex((d) => d.v > 0);
  if (first < 0) return null;
  const done = daily.slice(first, -1); // complete days since you started using it
  if (done.length < 14) return null;
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (const d of done) { const k = new Date(d.t).getDay(); sum[k] += d.v; cnt[k]++; }
  const avg = sum.map((s, k) => (cnt[k] ? s / cnt[k] : 0));
  const mean = avg.reduce((a, b) => a + b, 0) / 7;
  return mean > 0 ? avg.map((a) => a / mean) : null;
}

// The user's own choice of days (Settings), as a profile: those days count equally, the rest not at all.
export function weightsFromDays(days: number[]): Weights {
  const set = new Set(days.filter((d) => d >= 0 && d <= 6));
  return Array.from({ length: 7 }, (_, k) => (set.has(k) ? 7 / set.size : 0));
}

export const activeDays = (w: Weights) => w.map((x, k) => (x >= ACTIVE ? k : -1)).filter((k) => k >= 0);

// Total profile weight between a and b (each day contributes its weight times the part of it inside [a, b]).
export function weightBetween(w: Weights, a: number, b: number): number {
  let total = 0;
  for (let t = a; t < b;) {
    const next = new Date(t); next.setHours(24, 0, 0, 0);
    const end = Math.min(b, next.getTime());
    total += w[new Date(t).getDay()] * ((end - t) / DAY);
    t = end;
  }
  return total;
}

// Working days between a and b (partial days count partly), e.g. "12 working days until the reset".
export const workingDaysBetween = (w: Weights, a: number, b: number) => weightBetween(w.map((x) => (x >= ACTIVE ? 1 : 0)), a, b);

// The time when the profile weight from `a` reaches `target` (walks day by day). null = not before `limit`.
function timeAtWeight(w: Weights, a: number, target: number, limit: number): number | null {
  let acc = 0;
  for (let t = a; t < limit;) {
    const next = new Date(t); next.setHours(24, 0, 0, 0);
    const end = Math.min(limit, next.getTime());
    const add = w[new Date(t).getDay()] * ((end - t) / DAY);
    if (acc + add >= target && add > 0) return t + ((target - acc) / add) * (end - t);
    acc += add; t = end;
  }
  return null;
}

// Forecast for long windows (weekly, monthly) along the profile. `series` = usage % over the window
// (ideally the full history from the provider). null = not enough data; the caller falls back to the plain one.
export function workdayForecast(series: Sample[], now: number, resetsAt: string, w: Weights, learned: boolean): Forecast | null {
  const reset = Date.parse(resetsAt);
  if (!series.length || Number.isNaN(reset) || reset <= now) return null;
  const pNow = series[series.length - 1].p;
  const from = Math.max(series[0].t, now - 7 * DAY);
  const wPast = weightBetween(w, from, now);
  if (now - from < DAY || wPast < 0.5) return null; // under a day of history, or (almost) only days off in it
  const rate = Math.max(0, (pNow - valueAt(series, from)) / wPast); // % per average day
  const days = activeDays(w);
  const perWorkday = days.length ? (rate * 7) / days.length : rate; // profile weights of working days average 7/n
  const left = workingDaysBetween(w, now, reset);
  const hit = rate > 0 ? timeAtWeight(w, now, (100 - pNow) / rate, reset) : null;
  // the projected path, sampled every 3 hours so the chart can draw the flat stretches on days off
  const end = hit ?? reset, proj: [number, number][] = [];
  for (let t = now; ; t = Math.min(end, t + 3 * 3600_000)) {
    proj.push([t, Math.min(100, pNow + rate * weightBetween(w, now, t))]);
    if (t >= end) break;
  }
  return {
    ratePerHour: Math.round(((rate * weightBetween(w, now, reset)) / ((reset - now) / 3600_000)) * 100) / 100, // calendar average
    minutesToLimit: hit ? Math.round((hit - now) / 60_000) : null,
    hitsBeforeReset: hit !== null,
    work: {
      days, learned,
      daysLeft: Math.round(left * 10) / 10,
      perDay: perWorkday,
      budgetPerDay: left > 0.05 ? (100 - pNow) / left : null,
      lastsDays: perWorkday > 0 ? (100 - pNow) / perWorkday : null,
      proj,
    },
  };
}
