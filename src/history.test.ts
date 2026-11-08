import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { History } from "./history";

const min = 60_000;
const t0 = Date.parse("2025-01-01T12:00:00Z");

test("a new window archives the finished one with its peak", () => {
  const h = new History(fs.mkdtempSync(path.join(os.tmpdir(), "qp-h-")));
  const reset1 = new Date(t0 + 300 * min).toISOString();
  h.record("claude|5h", t0, 5, reset1);
  h.record("claude|5h", t0 + 10 * min, 40, reset1);
  h.record("claude|5h", t0 + 20 * min, 62, reset1);
  assert.equal(h.finishedWindows().length, 0);
  const reset2 = new Date(t0 + 700 * min).toISOString();
  const fresh = h.record("claude|5h", t0 + 400 * min, 1, reset2);
  assert.equal(fresh.length, 1); // history restarted
  const [w] = h.finishedWindows();
  assert.equal(w.peak, 62);
  assert.equal(w.readings, 3);
  assert.equal(w.resetsAt, reset1);
});

test("history survives a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-h-"));
  const reset = new Date(t0 + 300 * min).toISOString();
  new History(dir).record("k", t0, 5, reset);
  assert.equal(new History(dir).record("k", t0 + 6 * min, 7, reset).length, 2);
});
