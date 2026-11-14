import assert from "node:assert/strict";
import test from "node:test";
import { isNewer, versionFromLocation } from "./updates";

test("isNewer compares versions as numbers, not text", () => {
  assert.equal(isNewer("0.7.0", "0.6.2"), true);
  assert.equal(isNewer("v0.10.0", "0.9.9"), true); // "10" > "9" even though "1" < "9" as text
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.6.2", "0.6.2"), false);
  assert.equal(isNewer("0.6.1", "0.6.2"), false); // running a newer dev build than the release
});

test("isNewer says no when a version is not plain x.y.z", () => {
  assert.equal(isNewer("1.0.0-beta.1", "0.6.2"), false);
  assert.equal(isNewer("latest", "0.6.2"), false);
  assert.equal(isNewer("", "0.6.2"), false);
});

test("versionFromLocation reads the tag from GitHub's redirect", () => {
  assert.equal(versionFromLocation("https://github.com/VladUdri/quotapus/releases/tag/v0.7.0"), "0.7.0");
  assert.equal(versionFromLocation("https://github.com/VladUdri/quotapus/releases"), null); // no releases yet
  assert.equal(versionFromLocation("https://github.com/VladUdri/quotapus/releases/tag/nightly"), null);
  assert.equal(versionFromLocation(null), null);
});
