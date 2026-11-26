import test from "node:test";
import assert from "node:assert/strict";
import { mockCursor } from "./mock";

test("mock Cursor shows dollar budget on the hero", async () => {
  const r = await mockCursor.fetch();
  const [hero] = r.meters;
  assert.ok(hero.usedUsd !== undefined && (hero.limitUsd ?? 0) > 0);
});
