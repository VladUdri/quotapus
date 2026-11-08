import test from "node:test";
import assert from "node:assert/strict";
import { downsample, forecast, shouldRecord } from "./forecast";

const now = Date.parse("2025-01-01T12:00:00Z");
const min = 60_000;
const at = (m: number) => new Date(now + m * min).toISOString();

test("no forecast with fewer than two samples", () => {
  assert.equal(forecast([{ t: now, p: 10 }], now), undefined);
});

test("no forecast when the data spans under 15 minutes", () => {
  assert.equal(forecast([{ t: now - 5 * min, p: 10 }, { t: now, p: 12 }], now), undefined);
});

test("steady burn extrapolates to the limit and flags it if before reset", () => {
  // 20 -> 40 over 60 minutes = 20 pp/hour; 60 left => 180 minutes
  const f = forecast([{ t: now - 60 * min, p: 20 }, { t: now, p: 40 }], now, at(120));
  assert.equal(f?.ratePerHour, 20);
  assert.equal(f?.minutesToLimit, 180);
  assert.equal(f?.hitsBeforeReset, false); // reset in 120 min comes first
  const g = forecast([{ t: now - 60 * min, p: 20 }, { t: now, p: 40 }], now, at(240));
  assert.equal(g?.hitsBeforeReset, true);
});

test("idle usage means no ETA", () => {
  const f = forecast([{ t: now - 60 * min, p: 30 }, { t: now, p: 30 }], now, at(120));
  assert.equal(f?.minutesToLimit, null);
  assert.equal(f?.hitsBeforeReset, false);
});

test("only recent samples count: old burst is ignored", () => {
  const f = forecast([{ t: now - 200 * min, p: 0 }, { t: now - 100 * min, p: 50 }, { t: now - 30 * min, p: 50 }, { t: now, p: 50 }], now, at(120));
  assert.equal(f?.minutesToLimit, null);
});

test("shouldRecord thins out polls", () => {
  assert.equal(shouldRecord([{ t: now - 2 * min, p: 10 }], now, 10), false);
  assert.equal(shouldRecord([{ t: now - 2 * min, p: 10 }], now, 11), true);
  assert.equal(shouldRecord([{ t: now - 6 * min, p: 10 }], now, 10), true);
});

test("downsample keeps first and last and caps the length", () => {
  const xs = Array.from({ length: 1000 }, (_, i) => ({ t: i, p: i / 10 }));
  const d = downsample(xs, 60);
  assert.equal(d.length, 60);
  assert.equal(d[0], xs[0]);
  assert.equal(d[59], xs[999]);
  assert.equal(downsample(xs.slice(0, 5), 60).length, 5);
});
