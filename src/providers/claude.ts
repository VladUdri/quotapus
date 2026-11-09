import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { parseRetryAfter } from "../backoff";
import { readRateLimits } from "../statusline";
import { LogScanner, summarize } from "../usageLogs";
import type { Provider, ProviderResult, QuotaMeter } from "./types";

const run = promisify(execFile);
const logs = new LogScanner(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects"));
const base = { id: "claude", name: "Claude" };

interface Creds { accessToken: string; expiresAt: number; subscriptionType?: string }
interface Window { utilization: number; resets_at: string }

// Claude Code stores its OAuth login in the macOS Keychain. We reuse it (read-only)
// so the user never has to log in a second time.
async function readCreds(): Promise<Creds | null> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    return JSON.parse(stdout).claudeAiOauth ?? null;
  } catch {
    return null; // no keychain item = Claude Code never signed in
  }
}

// "Where did it go" is a bonus: if the logs are missing or unreadable, the quota numbers still show.
async function attachBreakdowns(meters: QuotaMeter[], models: Map<QuotaMeter, string | undefined>) {
  try {
    await logs.scan(Date.now(), 8 * 24 * 3600_000);
    for (const m of meters) {
      if (!m.resetsAt || !m.windowMinutes) continue;
      const since = Date.parse(m.resetsAt) - m.windowMinutes * 60_000; // start of the current window
      m.breakdown = summarize(logs.entries.values(), since, models.get(m));
    }
  } catch { /* ignore */ }
}

const result = (r: Partial<ProviderResult>): ProviderResult => ({ ...base, status: "ok", meters: [], ...r });

// `dataDir` is where quotapus keeps its files; the status line shim saves Claude Code's payload there.
//
// Data sources, best first:
//  1. The file written by the status line shim, if it's fresh (no network, no Keychain, no rate limits).
//  2. Anthropic's usage API (also sees usage from claude.ai, which Claude Code doesn't).
//  3. If the API fails, the shim's file even if old, flagged as stale.
export function createClaude(dataDir: string): Provider {
  let lastPlan: string | undefined;
  const planOf = (c: Creds | null) => (c?.subscriptionType ? c.subscriptionType[0].toUpperCase() + c.subscriptionType.slice(1) : undefined);

  const fromFile = async (f: NonNullable<ReturnType<typeof readRateLimits>>, extra: Partial<ProviderResult> = {}) => {
    const models = new Map<QuotaMeter, string | undefined>();
    const meters = f.meters.map((x) => {
      const m: QuotaMeter = { label: x.label, usedPercent: x.usedPercent, resetsAt: x.resetsAt, windowMinutes: x.windowMinutes };
      models.set(m, x.key.endsWith("opus") ? "opus" : x.key.endsWith("sonnet") ? "sonnet" : undefined);
      return m;
    });
    await attachBreakdowns(meters, models);
    if (!lastPlan) lastPlan = planOf(await readCreds());
    return result({ plan: lastPlan, meters, ...extra });
  };

  return {
  ...base,
  async fetch() {
    const file = readRateLimits(dataDir, Date.now());
    if (file && file.ageMs < 2 * 60_000) return fromFile(file);
    const api = await fetchApi();
    if (api.status === "ok" || !file) return api;
    const mins = Math.max(1, Math.round(file.ageMs / 60_000));
    return fromFile(file, { stale: true, retryAfterSec: api.retryAfterSec, recheckSec: api.recheckSec, message: `${api.message} Using Claude Code's data from ${mins >= 60 ? Math.round(mins / 60) + "h" : mins + "m"} ago.` });
  },
  // Claude Code renews its own login whenever it makes a request. So the safest "refresh" is to let
  // Claude Code do it: a one-word prompt to the cheapest model, without saving a session in the user's history.
  async refreshLogin() {
    const candidates = [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "claude"];
    for (const bin of candidates) {
      try {
        await run(bin, ["-p", "ok", "--model", "haiku", "--no-session-persistence"], { cwd: os.tmpdir(), timeout: 90_000 });
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, message: "Claude Code couldn't refresh the login. Try running `claude` in a terminal." };
      }
    }
    return { ok: false, message: "Couldn't find the `claude` command." };
  },
  };

  async function fetchApi(): Promise<ProviderResult> {
    const creds = await readCreds();
    if (!creds) {
      // Not installed / never signed in: hide the card (the popup explains what to do if no provider shows up at all).
      return result({ status: "not_connected", hidden: true });
    }
    const plan = planOf(creds);
    lastPlan = plan ?? lastPlan;
    // We deliberately do NOT refresh the token ourselves: refresh tokens rotate, so using
    // ours would invalidate Claude Code's copy and log the user out. Claude Code refreshes it on use.
    if (creds.expiresAt < Date.now()) {
      return result({ status: "error", plan, message: "Claude Code's login has expired (it lasts about 8 hours and renews whenever Claude Code is used).", recheckSec: 30, action: "refresh-login" });
    }
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      });
      if (res.status === 401) return result({ status: "error", plan, message: "Claude Code's login has expired (it renews whenever Claude Code is used).", recheckSec: 60, action: "refresh-login" });
      if (res.status === 429) return result({ status: "error", plan, message: "Rate limited by Anthropic. Tip: turn on \"Read limits from Claude Code\" in settings.", retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as Record<string, Window | null>;
      const meters: QuotaMeter[] = [];
      const models = new Map<QuotaMeter, string | undefined>(); // which model a meter covers, for the breakdown
      const add = (key: string, label: string, windowMinutes: number, model?: string) => {
        const w = d[key];
        if (!w) return;
        const m: QuotaMeter = { label, usedPercent: w.utilization, resetsAt: w.resets_at, windowMinutes };
        meters.push(m); models.set(m, model);
      };
      add("five_hour", "5-hour session", 300);
      add("seven_day", "Weekly", 10080);
      add("seven_day_opus", "Weekly (Opus)", 10080, "opus");
      add("seven_day_sonnet", "Weekly (Sonnet)", 10080, "sonnet");
      await attachBreakdowns(meters, models);
      return result({ plan, meters });
    } catch (e) {
      return result({ status: "error", plan, message: `Couldn't reach Anthropic (${(e as Error).message}).` });
    }
  }
}
