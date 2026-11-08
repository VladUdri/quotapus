import test from "node:test";
import assert from "node:assert/strict";
import { nextDelayMs, parseRetryAfter } from "./backoff";

test("no failures: use the normal interval", () => assert.equal(nextDelayMs(120, 0), 120_000));
test("failures double the wait, capped at 15 minutes", () => {
  assert.equal(nextDelayMs(120, 1), 240_000);
  assert.equal(nextDelayMs(120, 2), 480_000);
  assert.equal(nextDelayMs(120, 10), 900_000);
});
test("server's Retry-After wins when longer, but never above 1 hour", () => {
  assert.equal(nextDelayMs(120, 0, 600), 600_000);
  assert.equal(nextDelayMs(120, 0, 30), 120_000);
  assert.equal(nextDelayMs(120, 0, 99999), 3_600_000);
});
test("parseRetryAfter handles seconds, dates and junk", () => {
  assert.equal(parseRetryAfter("90"), 90);
  const now = Date.parse("2025-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Wed, 01 Jan 2025 00:02:00 GMT", now), 120);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});
