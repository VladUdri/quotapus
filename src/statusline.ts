import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./fsutil";

// Claude Code can run a "status line" command and pipe it a JSON payload on every update. Since
// v2.1.80 that payload includes the official `rate_limits` (5-hour and weekly used %, plus reset times).
// So instead of polling Anthropic's rate-limited API, we install a tiny shim as Claude Code's status line:
// the shim saves the payload to a file we read, then hands the payload to the user's ORIGINAL status
// line command (if they had one), so nothing they rely on breaks.
//
// This edits another app's settings file, so it is strictly opt-in and defensive:
// refuses to touch unparsable JSON, keeps a one-time backup, is idempotent, and disable restores the original.

const FILES = { shim: "statusline.sh", data: "claude-statusline.json", chain: "statusline-chain.txt", original: "statusline-original.json" };
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // quote for a POSIX shell

function shimScript(dir: string): string {
  const data = path.join(dir, FILES.data), chain = path.join(dir, FILES.chain);
  return `#!/bin/bash
# quotapus status line shim: saves Claude Code's payload, then runs the original status line (if any).
umask 077
IN="$(cat)"
printf '%s' "$IN" > ${sq(data + ".tmp")} && mv ${sq(data + ".tmp")} ${sq(data)}
if [ -s ${sq(chain)} ]; then printf '%s' "$IN" | /bin/bash -c "$(cat ${sq(chain)})"; fi
`;
}

// Only the part we care about is typed; every other key in the user's settings passes through untouched.
interface StatusLine { type?: unknown; command?: unknown; [k: string]: unknown }
interface ClaudeSettings { statusLine?: StatusLine | null; [k: string]: unknown }

function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (o && typeof o === "object" && !Array.isArray(o)) return o as ClaudeSettings;
  } catch { /* fall through */ }
  throw new Error("Couldn't read Claude Code's settings.json (not valid JSON), so I left it untouched.");
}

export function isEnabled(settingsPath: string, dir: string): boolean {
  try { return String(readSettings(settingsPath).statusLine?.command ?? "").includes(path.join(dir, FILES.shim)); }
  catch { return false; }
}

export function enable(settingsPath: string, dir: string): void {
  const s = readSettings(settingsPath);
  const shim = path.join(dir, FILES.shim);
  const cur = s.statusLine;
  if (String(cur?.command ?? "").includes(shim)) return; // already on
  if (cur !== undefined && (cur === null || typeof cur !== "object" || typeof cur.command !== "string")) {
    throw new Error("Your Claude Code status line has an unexpected format, so I left it untouched.");
  }
  fs.mkdirSync(dir, { recursive: true });
  const backup = settingsPath + ".quotapus-backup";
  if (fs.existsSync(settingsPath) && !fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup); // one-time safety copy
  fs.writeFileSync(shim, shimScript(dir), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, FILES.chain), String(cur?.command ?? ""));
  writeJsonAtomic(path.join(dir, FILES.original), { present: cur !== undefined, value: cur ?? null });
  s.statusLine = { ...(cur ?? {}), type: "command", command: sq(shim) };
  writeJsonAtomic(settingsPath, s);
}

export function disable(settingsPath: string, dir: string): void {
  const s = readSettings(settingsPath);
  if (!String(s.statusLine?.command ?? "").includes(path.join(dir, FILES.shim))) return; // not ours (e.g. user changed it): leave alone
  let original: { present: boolean; value: unknown } = { present: false, value: null };
  try { original = JSON.parse(fs.readFileSync(path.join(dir, FILES.original), "utf8")); } catch { /* none saved */ }
  if (original.present) s.statusLine = original.value as StatusLine | null;
  else delete s.statusLine;
  writeJsonAtomic(settingsPath, s);
}

// ---- reading what the shim saved ----
export interface FileMeter { key: string; label: string; windowMinutes: number; usedPercent: number; resetsAt: string }
const WINDOWS: [string, string, number][] = [
  ["five_hour", "5-hour session", 300], ["seven_day", "Weekly", 10080],
  ["seven_day_opus", "Weekly (Opus)", 10080], ["seven_day_sonnet", "Weekly (Sonnet)", 10080],
];

// Returns meters from the saved payload, skipping any whose window already ended (their % no longer applies).
export function readRateLimits(dir: string, now: number): { meters: FileMeter[]; ageMs: number } | null {
  try {
    const file = path.join(dir, FILES.data);
    const rl: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined> | undefined = JSON.parse(fs.readFileSync(file, "utf8"))?.rate_limits;
    if (!rl) return null;
    const meters: FileMeter[] = [];
    for (const [key, label, windowMinutes] of WINDOWS) {
      const w = rl[key];
      if (typeof w?.used_percentage !== "number" || typeof w?.resets_at !== "number") continue;
      if (w.resets_at * 1000 <= now) continue;
      meters.push({ key, label, windowMinutes, usedPercent: w.used_percentage, resetsAt: new Date(w.resets_at * 1000).toISOString() });
    }
    return meters.length ? { meters, ageMs: now - fs.statSync(file).mtimeMs } : null;
  } catch { return null; }
}
