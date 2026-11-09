import type { Forecast } from "./providers/types";

export interface Sample { t: number; p: number } // t = epoch ms, p = used percent

const MIN = 60_000;

// Pure function (no I/O, no clock): everything it needs is passed in, which makes it trivial to test.
//
// Idea: look at how fast usage grew over the recent past and extrapolate in a straight line.
// We use a *recent* window rather than the whole quota window, because people work in bursts:
// the last hour predicts the next hour far better than the last four days.
export function forecast(samples: Sample[], now: number, resetsAt?: string): Forecast | undefined {
  if (samples.length < 2) return undefined;
  const last = samples[samples.length - 1];

  // Short windows (5h session) -> look back 1h. Weekly -> 6h. Monthly (Cursor's billing cycle) -> 24h,
  // because a few busy hours extrapolated over weeks would cry wolf.
  const untilReset = resetsAt ? Date.parse(resetsAt) - now : Infinity;
  const lookback = untilReset <= 5.5 * 60 * MIN ? 60 * MIN : untilReset <= 8 * 1440 * MIN || untilReset === Infinity ? 6 * 60 * MIN : 24 * 60 * MIN;

  const recent = samples.filter((s) => s.t >= now - lookback);
  const first = recent[0];
  if (!first || last.t - first.t < 15 * MIN) return undefined; // too little data to trust

  const rate = Math.max(0, ((last.p - first.p) / (last.t - first.t)) * 60 * MIN); // pp per hour
  if (rate < 0.05) return { ratePerHour: 0, minutesToLimit: null, hitsBeforeReset: false };

  const minutesToLimit = Math.round(((100 - last.p) / rate) * 60);
  if (minutesToLimit > 7 * 24 * 60) return { ratePerHour: rate, minutesToLimit: null, hitsBeforeReset: false };
  const hitsBeforeReset = untilReset !== Infinity && minutesToLimit * MIN < untilReset;
  return { ratePerHour: Math.round(rate * 10) / 10, minutesToLimit, hitsBeforeReset };
}

// Decide whether to append a new reading. Utilization moves slowly, so we don't need every poll.
export function shouldRecord(samples: Sample[], now: number, p: number): boolean {
  const last = samples[samples.length - 1];
  if (!last) return true;
  if (p < last.p) return true; // a drop = new window; the caller resets history
  return now - last.t >= 5 * MIN || (p !== last.p && now - last.t >= MIN);
}

// Thin out a long series to at most n points (keeping first and last) so the chart stays light.
export function downsample(samples: Sample[], n: number): Sample[] {
  if (samples.length <= n) return samples;
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) out.push(samples[Math.round((i * (samples.length - 1)) / (n - 1))]);
  return out;
}
