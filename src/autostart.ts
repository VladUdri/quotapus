import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

// "Launch at login" on macOS = a LaunchAgent: a small plist in ~/Library/LaunchAgents
// that launchd reads at login. We write it ourselves because Electron's built-in
// login-item API only behaves for signed, packaged apps (which we are not).
const plist = path.join(os.homedir(), "Library/LaunchAgents/dev.quotapus.plist");

export const autostartEnabled = () => fs.existsSync(plist);

export function setAutostart(on: boolean) {
  if (!on) { fs.rmSync(plist, { force: true }); return; }
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.quotapus</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${app.getAppPath()}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
}
