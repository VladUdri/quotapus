import test from "node:test";
import assert from "node:assert/strict";
import { activeDays, learnWeights, weightBetween, weightsFromDays, workdayForecast, workingDaysBetween } from "./workdays";

const DAY = 86_400_000;
// Local midnight of Monday 3 March 2025, so weekday math is independent of the machine's time zone.
const mon = new Date(2025, 2, 3).getTime();
const at = (days: number, hour = 0) => new Date(2025, 2, 3 + days, hour).getTime();
const monFri = weightsFromDays([1, 2, 3, 4, 5]);

test("learnWeights: weekday-only usage -> weekends weigh nothing", () => {
  // 21 days from Monday, $5 on weekdays, nothing on weekends; last entry = today (ignored)
  const daily = Array.from({ length: 22 }, (_, i) => ({ t: at(i), v: [0, 6].includes(new Date(at(i)).getDay()) ? 0 : 5 }));
  const w = learnWeights(daily)!;
  assert.deepEqual(activeDays(w), [1, 2, 3, 4, 5]);
  assert.ok(Math.abs(w[1] - 1.4) < 1e-9); // 5 working days carry the whole week: 7/5
  assert.equal(learnWeights(daily.slice(0, 10)), null); // under two weeks: don't guess
  assert.equal(learnWeights(daily.map((d) => ({ ...d, v: 0 }))), null);
});

test("weightBetween / workingDaysBetween skip days off", () => {
  assert.equal(workingDaysBetween(monFri, mon, at(7)), 5);    // a full week = 5 working days
  assert.equal(workingDaysBetween(monFri, at(5), at(7)), 0);  // the weekend
  assert.ok(Math.abs(weightBetween(monFri, at(0, 12), at(1)) - 0.7) < 1e-9); // half a Monday
});

test("workdayForecast: weekday user, weekends don't count toward running out", () => {
  // used 7% per working day for the past week (35% over Mon..Fri), it's Monday 00:00, reset in 14 days
  const now = at(7);
  const series = Array.from({ length: 8 }, (_, i) => ({ t: at(i), p: 30 + 7 * Math.min(i, 5) }));
  const f = workdayForecast(series, now, new Date(at(21)).toISOString(), monFri, true)!;
  assert.ok(f.work);
  assert.ok(Math.abs(f.work.perDay - 7) < 1e-9);             // 7% per working day
  assert.equal(f.work.daysLeft, 10);                         // two work weeks until the reset
  assert.ok(Math.abs(f.work.lastsDays! - 5) < 1e-9);         // 35% left at 7%/day
  assert.ok(Math.abs(f.work.budgetPerDay! - 3.5) < 1e-9);    // to last: 35% over 10 working days
  // hits after 5 working days = Friday end of day, NOT after 5 calendar days counted from... Monday + weekends
  assert.equal(f.hitsBeforeReset, true);
  assert.equal(f.minutesToLimit, 5 * 1440);                  // Mon..Fri, limit reached at Saturday 00:00
  // the projection stays flat on the weekend after the hit is irrelevant; before it, flat stretches exist only on days off
  const proj = f.work.proj;
  assert.equal(proj[proj.length - 1][1], 100);
});

test("workdayForecast: a plain-calendar forecast would be wrong by the weekends", () => {
  // 2%/working day, 50% used, reset in 4 weeks: 20 working days * 2% = 40% -> ends at 90%, doesn't run out
  const now = at(7);
  const series = Array.from({ length: 8 }, (_, i) => ({ t: at(i), p: 40 + 2 * Math.min(i, 5) }));
  const f = workdayForecast(series, now, new Date(at(35)).toISOString(), monFri, false)!;
  assert.equal(f.hitsBeforeReset, false);
  assert.equal(f.work!.learned, false);
  assert.ok(Math.abs(f.work!.proj[f.work!.proj.length - 1][1] - 90) < 1e-6);
  assert.equal(workdayForecast(series.slice(-1), now, new Date(at(35)).toISOString(), monFri, false), null); // no history
});
