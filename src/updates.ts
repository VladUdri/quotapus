// "Is there a newer quotapus?" One anonymous request to github.com, nothing about this Mac is sent.
// We ask where github.com/<repo>/releases/latest redirects to (…/releases/tag/v1.2.3) instead of calling
// api.github.com: the redirect has no rate limit, which matters on shared office networks.
import { spawn } from "node:child_process";
import fs from "node:fs";

export const REPO = "VladUdri/quotapus";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const INSTALL_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;

// true only when both are plain x.y.z versions and `latest` is higher. Anything odd = "no update".
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// ".../releases/tag/v0.7.0" -> "0.7.0"; null if it isn't a release link with a plain version.
export function versionFromLocation(location: string | null): string | null {
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(location ?? "")?.[1];
  return tag && parse(tag) ? tag.replace(/^v/, "") : null;
}

// The latest released version, or null when it can't be told (offline, GitHub down, no releases).
export async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_URL, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return versionFromLocation(res.headers.get("location"));
  } catch { return null; }
}

// Runs the same installer as `quotapus update`. It stops this app, swaps the files and starts the new version,
// so the child is detached (it must outlive us). Resolves only if the installer FAILED; on success we're gone.
export function runInstaller(logFile: string): Promise<string> {
  return new Promise((resolve) => {
    let out: number | "ignore" = "ignore";
    try { out = fs.openSync(logFile, "w", 0o600); } catch { /* no log, still update */ }
    const child = spawn("/bin/bash", ["-c", `set -o pipefail; curl -fsSL "${INSTALL_URL}" | bash`], { detached: true, stdio: ["ignore", out, out] });
    child.on("error", (e) => resolve(e.message));
    child.on("exit", (code) => resolve(`The installer stopped (code ${code}).`));
    child.unref();
  });
}
