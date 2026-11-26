import test from "node:test";
import assert from "node:assert/strict";
import { mockCursor } from "./mock";

test("mock Cursor shows dollar budgets on the hero and on a row", async () => {
  const r = await mockCursor.fetch();
  const [hero, ...rows] = r.meters;
  assert.ok(hero.usedUsd !== undefined && hero.limitUsd! > 0);
  assert.ok(rows.some((m) => m.usedUsd !== undefined && m.limitUsd! > 0));
});
