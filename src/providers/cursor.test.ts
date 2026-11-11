import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptSafeStorage, parseJwt, parseLegacyUsage, parseUsageSummary, redact, sessionCookie } from "./cursor";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

test("parseJwt reads subject and expiry, rejects junk", () => {
  assert.deepEqual(parseJwt(jwt({ sub: "auth0|user_01ABC", exp: 123 })), { sub: "auth0|user_01ABC", exp: 123 });
  assert.equal(parseJwt("nonsense"), null);
  assert.equal(parseJwt(jwt({ nothing: 1 })), null);
});

test("session cookie is the URL-encoded 'userId::token'", () => {
  const c = sessionCookie("TOKEN", { sub: "auth0|user_01ABC", exp: 1 });
  assert.equal(c, "WorkosCursorSessionToken=user_01ABC%3A%3ATOKEN");
});

test("decryptSafeStorage round-trips Chromium-style AES-128-CBC and passes plain tokens through", () => {
  const password = "keychain-secret", token = "eyJ.plain.jwt";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const c = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const enc = Buffer.concat([Buffer.from("v10"), c.update(token, "utf8"), c.final()]).toString("base64");
  assert.equal(decryptSafeStorage("cursor-safe-storage:v1:" + enc, password), token);
  assert.equal(decryptSafeStorage("cursor-safe-storage:v1:" + enc, "wrong"), null);
  assert.equal(decryptSafeStorage("plain-token", password), "plain-token");
});

test("parseUsageSummary maps plan, auto/api split and on-demand spend with the billing cycle", () => {
  const p = parseUsageSummary({
    membershipType: "pro", billingCycleStart: "2025-01-01T00:00:00Z", billingCycleEnd: "2025-01-31T00:00:00Z",
    individualUsage: { plan: { totalPercentUsed: 42.5, autoPercentUsed: 10, apiPercentUsed: 80 }, onDemand: { enabled: true, used: 500, limit: 2000 } },
  });
  assert.equal(p.plan, "Pro");
  assert.deepEqual(p.meters.map((m) => [m.label, m.usedPercent]), [["Monthly plan", 42.5], ["Auto + Composer", 10], ["Named models (API)", 80], ["On-demand spend", 25]]);
  assert.equal(p.meters[0].windowMinutes, 30 * 1440);
  assert.equal(p.meters[0].resetsAt, "2025-01-31T00:00:00.000Z");
});

test("parseUsageSummary falls back to used/limit and tolerates junk", () => {
  assert.equal(parseUsageSummary({ individualUsage: { plan: { used: 500, limit: 2000 } } }).meters[0].usedPercent, 25);
  assert.deepEqual(parseUsageSummary("garbage").meters, []);
  assert.deepEqual(parseUsageSummary(null).meters, []);
});

test("parseLegacyUsage reads request counts", () => {
  const m = parseLegacyUsage({ "gpt-4": { numRequests: 100, maxRequestUsage: 500 }, startOfMonth: "2025-01-05T00:00:00Z" });
  assert.equal(m[0].usedPercent, 20);
  assert.equal(m[0].resetsAt, "2025-02-05T00:00:00.000Z");
  assert.deepEqual(parseLegacyUsage({ "gpt-4": { numRequests: 1, maxRequestUsage: null } }), []);
});

test("redact keeps the shape but removes every string", () => {
  assert.deepEqual(redact({ email: "me@x.com", n: 3, nested: { a: ["x", "y"] } }), { email: "<string>", n: 3, nested: { a: ["<string>", "<string>"] } });
});

test("enterprise accounts: a single 'overall' allowance, and idle team budget is not shown", () => {
  const p = parseUsageSummary({
    membershipType: "enterprise", isUnlimited: false, billingCycleStart: "2025-01-01T00:00:00Z", billingCycleEnd: "2025-01-31T00:00:00Z",
    individualUsage: { overall: { enabled: true, used: 40531, limit: 85000, remaining: 44469 } },
    teamUsage: { onDemand: { enabled: true, used: 0, limit: 2500000, remaining: 2500000 } },
  });
  assert.equal(p.plan, "Enterprise");
  assert.deepEqual(p.meters.map((m) => m.label), ["Monthly usage"]);
  assert.equal(Math.round(p.meters[0].usedPercent), 48);
  const spent = parseUsageSummary({ individualUsage: { overall: { used: 1, limit: 10 } }, teamUsage: { onDemand: { used: 500, limit: 1000 } } });
  assert.deepEqual(spent.meters.map((m) => m.label), ["Monthly usage", "Team on-demand"]);
  assert.deepEqual(parseUsageSummary({ isUnlimited: true, individualUsage: { overall: { used: 5, limit: 10 } } }).meters, []);
});

import { attachHistory } from "./cursor";
import { parseEventsPage, weightOf } from "./cursorEvents";

test("parseEventsPage: lenient numbers, empty answers, rejects error envelopes", () => {
  const p = parseEventsPage({ totalUsageEventsCount: "2", usageEventsDisplay: [
    { timestamp: "1741600000000", model: "claude-4.5-sonnet", chargedCents: 12.5, tokenUsage: { inputTokens: "100", outputTokens: 50, totalCents: "20" } },
    { timestamp: 0, model: "junk" }, // no valid time: skipped
  ] })!;
  assert.equal(p.total, 2);
  assert.deepEqual(p.events, [{ t: 1741600000000, charged: 12.5, list: 20, tokens: 150, model: "claude-4.5-sonnet" }]);
  assert.deepEqual(parseEventsPage({}), { total: 0, events: [] });
  assert.equal(parseEventsPage({ error: "nope" }), null);
  assert.equal(parseEventsPage([1]), null);
});

test("weightOf prefers what the plan was charged, then list price, then tokens", () => {
  const e = (charged: number, list: number, tokens: number) => ({ t: 1, charged, list, tokens, model: "m" });
  assert.equal(weightOf([e(50, 80, 9)]).w(e(50, 80, 9)), 0.5);
  assert.equal(weightOf([e(0, 80, 9)]).unit, "usd");
  assert.equal(weightOf([e(0, 0, 9)]).unit, "tokens");
});

test("attachHistory: whole-cycle curve pinned to the reported %, daily spend, spend by model", () => {
  const D = 86_400_000, now = Date.parse("2025-03-20T12:00:00Z");
  const m = { label: "Monthly usage", usedPercent: 40, resetsAt: new Date(now + 10 * D).toISOString(), windowMinutes: 30 * 1440 };
  const ev = (daysAgo: number, cents: number, model: string) => ({ t: now - daysAgo * D, charged: cents, list: 0, tokens: 1, model });
  attachHistory([m as any], [ev(15, 300, "gpt-5"), ev(5, 100, "claude-4.5-sonnet"), ev(1, 100, "claude-4.5-sonnet"), ev(25, 999, "old")], now);
  const curve = (m as any).curve as { t: number; p: number }[];
  assert.equal((m as any).curveExact, true);
  assert.equal(curve[0].p, 0);
  assert.equal(curve[curve.length - 1].p, 40);    // pinned to Cursor's own number
  assert.deepEqual((m as any).breakdown.map((b: any) => b.name), ["gpt-5", "claude-4.5-sonnet"]); // last cycle's event excluded
  assert.equal((m as any).dailyUnit, "usd");
  assert.equal((m as any).daily.length, 28);
  assert.equal(Math.round((m as any).daily.reduce((s: number, d: any) => s + d.v, 0) * 100), 1499); // all 4 events are within 28 days
  assert.equal((m as any).usdPerPercent, 5 / 40); // $5 spent this cycle for 40%
});
