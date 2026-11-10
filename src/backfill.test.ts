import test from "node:test";
import assert from "node:assert/strict";
import { dailyTotals, eventCurve, fillGaps, shares, valueAt } from "./backfill";

const H = 3600_000;
const t0 = Date.parse("2025-03-10T00:00:00Z");

test("eventCurve: shape from events, level pinned to the current %", () => {
  // all usage happens at hour 1 and hour 3, equal amounts; now = hour 4, 40% used
  const c = eventCurve([{ t: t0 + H, w: 5 }, { t: t0 + 3 * H, w: 5 }], t0, t0 + 4 * H, 40, 8)!;
  assert.equal(c[0].p, 0);
  assert.equal(valueAt(c, t0 + 2 * H), 20);   // halfway through the usage
  assert.equal(c[c.length - 1].p, 40);         // ends exactly at the real value
  assert.equal(eventCurve([], t0, t0 + H, 10), null);
  assert.equal(eventCurve([{ t: t0 - H, w: 3 }], t0, t0 + H, 10), null); // events before the window don't count
});

test("fillGaps: real readings kept, gaps filled with the stretched shape, marked estimated", () => {
  const curve = eventCurve([{ t: t0 + 0.5 * H, w: 1 }, { t: t0 + 2.5 * H, w: 3 }], t0, t0 + 4 * H, 60, 16)!;
  // quotapus only started at hour 3 (reading 45%) and read 60% at hour 4
  const out = fillGaps([{ t: t0 + 3 * H, p: 45 }, { t: t0 + 4 * H, p: 60 }], curve, t0);
  assert.equal(out[0].t, t0); assert.equal(out[0].p, 0);
  const real = out.filter((p) => !p.est);
  assert.deepEqual(real.map((p) => p.p), [45, 60]);
  const est = out.filter((p) => p.est && p.t > t0);
  assert.ok(est.length > 0);
  // filled values rise monotonically from 0 to 45 and follow the shape: flat before the first event
  assert.ok(est.every((p, i) => i === 0 || p.p >= est[i - 1].p));
  assert.equal(valueAt(out, t0 + 0.25 * H), 0);
  assert.ok(est.filter((p) => p.t < t0 + 3 * H).every((p) => p.p <= 45)); // stays below the reading it leads up to
  assert.ok(est.filter((p) => p.t > t0 + 3 * H).every((p) => p.p >= 45 && p.p <= 60)); // the 1h gap is filled too
});

test("fillGaps: no curve = recorded readings as they are; short gaps aren't filled", () => {
  const rec = [{ t: t0 + 1000, p: 1 }, { t: t0 + 2000, p: 2 }];
  assert.deepEqual(fillGaps(rec, null, t0), rec);
  const curve = eventCurve([{ t: t0 + 500, w: 1 }], t0, t0 + 2000, 2)!;
  assert.deepEqual(fillGaps(rec, curve, t0), rec);
});

test("dailyTotals buckets by local day, oldest first, including empty days", () => {
  const now = new Date(2025, 2, 10, 15).getTime();
  const d = dailyTotals([{ t: new Date(2025, 2, 10, 9).getTime(), w: 4 }, { t: new Date(2025, 2, 8, 23).getTime(), w: 2 }, { t: new Date(2025, 1, 1).getTime(), w: 99 }], now, 3);
  assert.deepEqual(d.map((x) => x.v), [2, 0, 4]);
  assert.equal(new Date(d[2].t).getDate(), 10);
});

test("shares: top N plus Other", () => {
  const s = shares([{ key: "a", w: 5 }, { key: "b", w: 3 }, { key: "c", w: 1 }, { key: "d", w: 1 }], 2);
  assert.deepEqual(s, [{ name: "a", share: 50 }, { name: "b", share: 30 }, { name: "Other", share: 20 }]);
});
