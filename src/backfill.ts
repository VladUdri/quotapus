import type { Sample } from "./forecast";

// History that doesn't depend on quotapus having been running.
//
// A provider can tell us WHEN usage happened (Cursor: its server-side list of requests; Claude: Claude Code's
// local logs) but usually not the exact quota % at each moment. So we take the *shape* from those events and
// pin its *level* to real % readings: the current value from the API, and the readings we recorded ourselves.
// Pure functions, no I/O, no clock: easy to test.

export interface UsageEvent { t: number; w: number } // when, and how much (cents, tokens, any unit; only ratios matter)
export interface Point { t: number; p: number; est?: boolean } // est = derived, not measured

// Cumulative usage curve over [start, now], scaled so it ends at `pNow` (the real current %).
// The window starts at 0% by definition (a quota window resets to zero). null = no usage events to shape it.
export function eventCurve(events: UsageEvent[], start: number, now: number, pNow: number, n = 200): Sample[] | null {
  const ev = events.filter((e) => e.t >= start && e.t <= now && e.w > 0).sort((a, b) => a.t - b.t);
  const total = ev.reduce((s, e) => s + e.w, 0);
  if (!total || now <= start) return null;
  const out: Sample[] = [];
  let i = 0, cum = 0;
  for (let k = 0; k <= n; k++) {
    const t = start + ((now - start) * k) / n;
    while (i < ev.length && ev[i].t <= t) cum += ev[i++].w;
    out.push({ t, p: (pNow * cum) / total });
  }
  return out;
}

// Value of a curve at time t (linear between points, clamped at the ends).
export function valueAt(curve: Sample[], t: number): number {
  if (!curve.length) return 0;
  if (t <= curve[0].t) return curve[0].p;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].t >= t) {
      const a = curve[i - 1], b = curve[i];
      return b.t === a.t ? b.p : a.p + ((t - a.t) / (b.t - a.t)) * (b.p - a.p);
    }
  }
  return curve[curve.length - 1].p;
}

// Our own readings are the truth; between them (and before the first one) there can be long gaps: the app
// wasn't running, the Mac slept. Fill each gap longer than `minGap` with the event curve's shape, stretched so it
// meets the real readings on both sides. The window start counts as a reading of 0%.
export function fillGaps(recorded: Sample[], curve: Sample[] | null, windowStart: number, minGap = 15 * 60_000): Point[] {
  const real = recorded.filter((s) => s.t >= windowStart).sort((a, b) => a.t - b.t);
  if (!curve) return real;
  const out: Point[] = [];
  let a: Point = { t: windowStart, p: 0, est: true }; // the window start, a reading of 0% by definition
  for (const b of real) {
    if (b.t - a.t >= minGap) {
      if (!out.length) out.push(a);
      const da = valueAt(curve, a.t), db = valueAt(curve, b.t);
      for (const c of curve) {
        if (c.t <= a.t || c.t >= b.t) continue;
        // how far between a and b the shape says we are (0..1); a flat shape = straight line
        const f = db > da ? (c.p - da) / (db - da) : (c.t - a.t) / (b.t - a.t);
        out.push({ t: c.t, p: a.p + f * (b.p - a.p), est: true });
      }
    }
    out.push(b);
    a = b;
  }
  return out;
}

// Totals per local calendar day for the last `days` days (oldest first, today last). Empty days are 0.
export function dailyTotals(events: UsageEvent[], now: number, days = 14): { t: number; v: number }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const out: { t: number; v: number }[] = [];
  for (let d = new Date(start); out.length < days; d.setDate(d.getDate() + 1)) out.push({ t: d.getTime(), v: 0 });
  for (const e of events) {
    if (e.t < out[0].t || e.t > now) continue;
    let k = out.length - 1;
    while (k > 0 && out[k].t > e.t) k--;
    out[k].v += e.w;
  }
  return out;
}

// Shares (0-100) of the top few keys plus "Other", e.g. spend per model.
export function shares(items: { key: string; w: number }[], top = 3): { name: string; share: number }[] {
  const by = new Map<string, number>();
  for (const it of items) if (it.w > 0) by.set(it.key, (by.get(it.key) ?? 0) + it.w);
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  const sorted = [...by].sort((a, b) => b[1] - a[1]);
  const out = sorted.slice(0, top).map(([name, w]) => ({ name, share: Math.round((w / total) * 100) }));
  const rest = sorted.slice(top).reduce((s, [, w]) => s + w, 0);
  if (rest > 0) out.push({ name: "Other", share: Math.round((rest / total) * 100) });
  return out;
}
