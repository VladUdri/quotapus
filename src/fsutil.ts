import fs from "node:fs";
import path from "node:path";

// Write to a temp file then rename: rename is atomic, so a crash mid-write can't leave a half-written file.
export function writeJsonAtomic(target: string, data: unknown) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}
