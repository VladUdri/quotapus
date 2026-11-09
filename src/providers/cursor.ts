import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseRetryAfter } from "../backoff";
import type { Provider, ProviderResult, QuotaMeter } from "./types";

// Cursor provider. Cursor is a VS Code fork: its login lives in a SQLite file ("state.vscdb") under
// ~/Library/Application Support/Cursor. We read the access token (read-only, never refreshed or written),
// and call cursor.com's usage endpoint the same way Cursor's own settings page does.
// NOTE: undocumented API, written from public reverse-engineering notes; see AGENTS.md ("unverified").

const run = promisify(execFile);
const base = { id: "cursor", name: "Cursor" };
const DB = path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");

// ---------- pure helpers (unit tested) ----------

export interface Jwt { sub: string; exp: number }
export function parseJwt(token: string): Jwt | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof p.sub === "string" && typeof p.exp === "number" ? { sub: p.sub, exp: p.exp } : null;
  } catch { return null; }
}

// Cursor's web session cookie is "<user id>::<access token>", URL-encoded. The user id is the part
// of the JWT subject after the "|" (e.g. "auth0|user_01ABC" -> "user_01ABC").
export function sessionCookie(token: string, jwt: Jwt): string {
  const userId = jwt.sub.includes("|") ? jwt.sub.split("|")[1] : jwt.sub;
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
}

// Newer Cursor versions store the token encrypted ("cursor-safe-storage:v1:<base64>") using Electron's
// safeStorage, which on macOS is Chromium's scheme: AES-128-CBC, key = PBKDF2-SHA1(keychain password,
// "saltysalt", 1003 iterations, 16 bytes), IV = 16 spaces, payload prefixed with "v10".
export function decryptSafeStorage(value: string, keychainPassword: string): string | null {
  const PREFIX = "cursor-safe-storage:v1:";
  if (!value.startsWith(PREFIX)) return value; // plain token
  try {
    let buf = Buffer.from(value.slice(PREFIX.length), "base64");
    if (buf.subarray(0, 3).toString() === "v10" || buf.subarray(0, 3).toString() === "v11") buf = buf.subarray(3);
    const key = crypto.pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");
    const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([d.update(buf), d.final()]).toString("utf8");
  } catch { return null; }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const pct = (v: number) => Math.max(0, Math.min(100, v));

export interface Parsed { plan?: string; meters: QuotaMeter[] }

// Reads /api/usage-summary. We accept a few field spellings because the response has changed over time.
export function parseUsageSummary(json: unknown): Parsed {
  const d = obj(json) ?? {};
  const meters: QuotaMeter[] = [];
  const start = typeof d.billingCycleStart === "string" ? Date.parse(d.billingCycleStart) : NaN;
  const end = typeof d.billingCycleEnd === "string" ? Date.parse(d.billingCycleEnd) : NaN;
  const cycle = !Number.isNaN(end) ? { resetsAt: new Date(end).toISOString(), windowMinutes: !Number.isNaN(start) ? Math.round((end - start) / 60_000) : undefined } : {};

  const plan = obj(obj(d.individualUsage)?.plan);
  if (plan) {
    // Preferred: the percentage Cursor itself shows. Fallback: used / limit (both in cents).
    const total = num(plan.totalPercentUsed) ?? (num(plan.used) !== undefined && num(plan.limit) ? (num(plan.used)! / num(plan.limit)!) * 100 : undefined);
    if (total !== undefined) meters.push({ label: "Monthly plan", usedPercent: pct(total), ...cycle });
    const auto = num(plan.autoPercentUsed), api = num(plan.apiPercentUsed);
    if (auto !== undefined) meters.push({ label: "Auto + Composer", usedPercent: pct(auto), ...cycle });
    if (api !== undefined) meters.push({ label: "Named models (API)", usedPercent: pct(api), ...cycle });
  }
  // Enterprise/team accounts report a single "overall" allowance instead of a plan breakdown.
  const overall = obj(obj(d.individualUsage)?.overall);
  if (!meters.length && overall && overall.enabled !== false && d.isUnlimited !== true && num(overall.limit) && num(overall.used) !== undefined) {
    meters.push({ label: "Monthly usage", usedPercent: pct((num(overall.used)! / num(overall.limit)!) * 100), ...cycle });
  }
  const od = obj(obj(d.individualUsage)?.onDemand);
  if (od && od.enabled !== false && num(od.limit) && num(od.used) !== undefined) {
    meters.push({ label: "On-demand spend", usedPercent: pct((num(od.used)! / num(od.limit)!) * 100), ...cycle });
  }
  // A team's shared on-demand budget only matters once some of it has been spent.
  const team = obj(obj(d.teamUsage)?.onDemand);
  if (team && team.enabled !== false && num(team.limit) && (num(team.used) ?? 0) > 0) {
    meters.push({ label: "Team on-demand", usedPercent: pct((num(team.used)! / num(team.limit)!) * 100), ...cycle });
  }
  const m = typeof d.membershipType === "string" ? d.membershipType : undefined;
  return { plan: m ? m[0].toUpperCase() + m.slice(1) : undefined, meters };
}

// Older accounts: /api/usage?user=ID returns request counts, e.g. { "gpt-4": { numRequests, maxRequestUsage }, startOfMonth }.
export function parseLegacyUsage(json: unknown): QuotaMeter[] {
  const d = obj(json) ?? {};
  const gpt4 = obj(d["gpt-4"]);
  const used = num(gpt4?.numRequests), max = num(gpt4?.maxRequestUsage);
  if (used === undefined || !max) return [];
  const start = typeof d.startOfMonth === "string" ? Date.parse(d.startOfMonth) : NaN;
  const resetsAt = Number.isNaN(start) ? undefined : new Date(new Date(start).setUTCMonth(new Date(start).getUTCMonth() + 1)).toISOString();
  return [{ label: "Fast requests", usedPercent: pct((used / max) * 100), resetsAt }];
}

// For bug reports: the response's shape with every string replaced, so no personal data is saved.
export type Redacted = string | number | boolean | null | Redacted[] | { [key: string]: Redacted };
export function redact(v: unknown): Redacted {
  if (typeof v === "string") return "<string>";
  if (Array.isArray(v)) return v.slice(0, 3).map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return typeof v === "number" || typeof v === "boolean" ? v : null;
}

// ---------- I/O ----------

async function sqliteValue(key: string): Promise<string | null> {
  // Normal read-only open sees recent writes still sitting in the WAL file; "immutable" is the fallback
  // for a database that no process has open (it can't create the -shm file).
  for (const mode of ["mode=ro", "immutable=1"]) {
    try {
      const { stdout } = await run("/usr/bin/sqlite3", ["-readonly", `file:${DB}?${mode}`, `select cast(value as text) from ItemTable where key='${key}'`], { timeout: 5000 });
      const v = stdout.trim();
      return v || null;
    } catch { /* try next mode */ }
  }
  return null;
}

async function readToken(): Promise<{ token: string } | { error: "not-installed" | "no-login" | "undecryptable" }> {
  if (!fs.existsSync(DB)) return { error: "not-installed" };
  const raw = await sqliteValue("cursorAuth/accessToken");
  if (!raw) return { error: "no-login" };
  if (!raw.startsWith("cursor-safe-storage:")) return { token: raw };
  for (const account of ["Cursor Key", "Cursor"]) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Cursor Safe Storage", "-a", account, "-w"], { timeout: 15_000 });
      const t = decryptSafeStorage(raw, stdout.trim());
      if (t && parseJwt(t)) return { token: t };
    } catch { /* try the other account name */ }
  }
  return { error: "undecryptable" };
}

const result = (r: Partial<ProviderResult>): ProviderResult => ({ ...base, status: "ok", meters: [], ...r });

export function createCursor(dataDir: string): Provider {
  const saveDebug = (label: string, json: unknown) => {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, "cursor-debug.json"), JSON.stringify({ label, shape: redact(json) }, null, 2)); } catch { /* ignore */ }
  };
  return {
    ...base,
    async fetch() {
      const t = await readToken();
      // Not installed / never signed in: hide the card entirely instead of nagging people who don't use Cursor.
      if ("error" in t && (t.error === "not-installed" || t.error === "no-login")) return result({ status: "not_connected", hidden: true });
      if ("error" in t) return result({ status: "error", message: "Couldn't decrypt Cursor's login. When macOS asks to let quotapus use \"Cursor Safe Storage\", choose Always Allow.", recheckSec: 300 });
      const jwt = parseJwt(t.token);
      if (!jwt) return result({ status: "error", message: "Couldn't read Cursor's login token.", recheckSec: 300 });
      if (jwt.exp * 1000 < Date.now() + 60_000) {
        return result({ status: "error", message: "Cursor's login has expired. Open Cursor once and it will renew it.", recheckSec: 60 });
      }
      const headers = { Cookie: sessionCookie(t.token, jwt), Accept: "application/json", "User-Agent": "quotapus" };
      try {
        const res = await fetch("https://cursor.com/api/usage-summary", { headers });
        if (res.status === 401 || res.status === 403) return result({ status: "error", message: "Cursor rejected the login. Open Cursor once to renew it.", recheckSec: 60 });
        if (res.status === 429) return result({ status: "error", message: "Rate limited by Cursor.", retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        let parsed = parseUsageSummary(json);
        if (!parsed.meters.length) { // maybe an older account: try the request-count endpoint
          const userId = jwt.sub.includes("|") ? jwt.sub.split("|")[1] : jwt.sub;
          const legacy = await fetch(`https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`, { headers });
          if (legacy.ok) { const lj = await legacy.json(); const lm = parseLegacyUsage(lj); if (lm.length) parsed = { ...parsed, meters: lm }; else saveDebug("legacy", lj); }
        }
        if (!parsed.meters.length) {
          saveDebug("usage-summary", json);
          return result({ status: "error", message: `Cursor responded, but in a format I don't recognise. A redacted copy of its shape was saved to ${path.join(dataDir, "cursor-debug.json")} (contains no personal data).`, plan: parsed.plan });
        }
        return result({ plan: parsed.plan, meters: parsed.meters });
      } catch (e) {
        return result({ status: "error", message: `Couldn't reach Cursor (${(e as Error).message}).` });
      }
    },
  };
}
