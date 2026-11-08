// For `npm start`: stop the dev Electron from showing up in the Dock as "Electron".
// It edits the Electron.app inside node_modules (macOS only; idempotent), the same way install.sh does for releases.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
if (process.platform !== "darwin") process.exit(0);
const app = path.join(__dirname, "../node_modules/electron/dist/Electron.app");
const plist = path.join(app, "Contents/Info.plist");
try {
  const read = (key) => { try { return execFileSync("plutil", ["-extract", key, "raw", plist], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
  if (read("LSUIElement") === "true") process.exit(0);
  execFileSync("plutil", ["-replace", "LSUIElement", "-bool", "true", plist]);
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", "Quotapus (dev)", plist]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" }); // the edit invalidated the signature
} catch (e) { console.warn("dev-plist: skipped (" + e.message + ")"); }
