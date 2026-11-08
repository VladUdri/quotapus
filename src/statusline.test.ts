import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { disable, enable, isEnabled, readRateLimits } from "./statusline";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-sl-"));
const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

test("enable adds our shim, keeps other settings, backs up once; disable removes it", () => {
  const d = tmp(), settings = path.join(d, "settings.json"), data = path.join(d, "data dir");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { a: 1 }, theme: "dark" }));
  enable(settings, data);
  assert.equal(isEnabled(settings, data), true);
  assert.deepEqual(read(settings).hooks, { a: 1 });
  assert.ok(fs.existsSync(settings + ".quotapus-backup"));
  enable(settings, data); // idempotent
  assert.equal(fs.readFileSync(path.join(data, "statusline-chain.txt"), "utf8"), "");
  disable(settings, data);
  assert.equal(read(settings).statusLine, undefined);
  assert.equal(read(settings).theme, "dark");
  assert.equal(isEnabled(settings, data), false);
});

test("an existing status line is chained and restored exactly", () => {
  const d = tmp(), settings = path.join(d, "settings.json"), data = path.join(d, "q");
  const orig = { type: "command", command: "echo hello", padding: 2 };
  fs.writeFileSync(settings, JSON.stringify({ statusLine: orig }));
  enable(settings, data);
  assert.equal(fs.readFileSync(path.join(data, "statusline-chain.txt"), "utf8"), "echo hello");
  assert.equal(read(settings).statusLine.padding, 2);
  disable(settings, data);
  assert.deepEqual(read(settings).statusLine, orig);
});

test("refuses to touch invalid JSON, and does not undo a status line the user changed", () => {
  const d = tmp(), settings = path.join(d, "settings.json"), data = path.join(d, "q");
  fs.writeFileSync(settings, "{ not json");
  assert.throws(() => enable(settings, data), /untouched/);
  assert.equal(fs.readFileSync(settings, "utf8"), "{ not json");
  fs.writeFileSync(settings, "{}");
  enable(settings, data);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
  disable(settings, data);
  assert.equal(read(settings).statusLine.command, "mine");
});

test("the shim saves the payload and chains to the original command", () => {
  const d = tmp(), settings = path.join(d, "settings.json"), data = path.join(d, "q");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "cat | tr a-z A-Z" } }));
  enable(settings, data);
  const { execFileSync } = require("node:child_process");
  const out = execFileSync("/bin/bash", [path.join(data, "statusline.sh")], { input: '{"x":"abc"}' }).toString();
  assert.equal(out, '{"X":"ABC"}');
  assert.equal(fs.readFileSync(path.join(data, "claude-statusline.json"), "utf8"), '{"x":"abc"}');
});

test("readRateLimits maps meters and skips windows that already ended", () => {
  const d = tmp(), now = Date.parse("2025-01-01T12:00:00Z");
  fs.writeFileSync(path.join(d, "claude-statusline.json"), JSON.stringify({ rate_limits: {
    five_hour: { used_percentage: 9, resets_at: now / 1000 + 3600 },
    seven_day: { used_percentage: 3, resets_at: now / 1000 - 10 }, // already reset
  } }));
  const r = readRateLimits(d, now + 5000)!;
  assert.deepEqual(r.meters.map((m) => [m.label, m.usedPercent]), [["5-hour session", 9]]);
  assert.equal(readRateLimits(path.join(d, "nope"), now), null);
});
