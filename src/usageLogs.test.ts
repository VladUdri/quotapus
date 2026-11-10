import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogScanner, displayName, parseLine, summarize } from "./usageLogs";

const line = (o: object) => JSON.stringify(o);
const asst = (id: string, cwd: string, out: number, over: object = {}) => line({
  type: "assistant", timestamp: "2025-01-01T12:00:00Z", cwd, requestId: "r" + id,
  message: { id, model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 99999 }, ...over },
});

test("parseLine counts input+output+cache creation, ignores cache reads", () => {
  const r = parseLine(asst("m1", "/work/app", 90))!;
  assert.equal(r.entry.w, 100);
  assert.equal(r.entry.project, "/work/app");
  assert.equal(Math.round(r.entry.c), 10 + 5 * 90 + 10000); // cost weight: output x5, cache reads x0.1
});
test("parseLine ignores non-assistant lines, junk and synthetic messages", () => {
  assert.equal(parseLine(line({ type: "user", message: { usage: {} } })), null);
  assert.equal(parseLine("not json but has \"usage\""), null);
  assert.equal(parseLine(asst("m2", "/x", 5, { model: "<synthetic>" })), null);
});
test("displayName: home, temp folders, and same-named folders are told apart", () => {
  assert.equal(displayName("/home/me", "/home/me"), "Home folder");
  assert.equal(displayName("/private/tmp/qp-trial", "/home/me"), "qp-trial (temp folder)");
  assert.equal(displayName("/home/me/work/app", "/home/me"), "app");
  const both = ["/home/me/work/app", "/home/me/side/app"];
  assert.equal(displayName(both[0], "/home/me", both), "work/app");
  assert.equal(displayName(both[1], "/home/me", both), "side/app");
});
test("summarize groups by project, shows top N plus Other, respects window and model", () => {
  const e = (project: string, w: number, t = 1000, model = "sonnet") => ({ t, project, model, w, c: w });
  const items = summarize([e("a", 50), e("b", 30), e("c", 10), e("d", 5), e("e", 5), e("old", 999, 1)], 500, undefined, 3);
  assert.deepEqual(items.map((i) => [i.name, i.share]), [["a", 50], ["b", 30], ["c", 10], ["Other", 10]]);
  assert.deepEqual(summarize([e("a", 5, 1000, "opus"), e("b", 5, 1000, "sonnet")], 0, "opus").map((i) => [i.name, i.share]), [["a", 100]]);
  assert.deepEqual(summarize([], 0), []);
});
test("scanner reads incrementally, de-duplicates streamed messages, skips partial lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-"));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, asst("m1", "/p/one", 10) + "\n" + asst("m1", "/p/one", 50) + "\n" + '{"type":"assistant","half');
  const sc = new LogScanner(dir);
  await sc.scan(Date.parse("2025-01-01T13:00:00Z"), 7 * 864e5);
  assert.equal(sc.entries.size, 1);
  assert.equal([...sc.entries.values()][0].w, 60); // latest streamed values win (10 + 50)
  fs.writeFileSync(f, asst("m1", "/p/one", 10) + "\n" + asst("m1", "/p/one", 50) + "\n" + asst("m2", "/p/two", 5) + "\n");
  await sc.scan(Date.parse("2025-01-01T13:00:00Z"), 7 * 864e5);
  assert.equal(sc.entries.size, 2);
  fs.rmSync(dir, { recursive: true });
});
