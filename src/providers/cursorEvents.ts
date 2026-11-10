import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../fsutil";

// Cursor keeps a server-side list of every request you made (what its dashboard's "Usage" tab shows):
// POST https://cursor.com/api/dashboard/get-filtered-usage-events. With it, the chart and the insights cover
// the whole billing cycle from day one, no matter when quotapus was running.
// Request/response shape from CodexBar's CursorUsageEventsFetcher.swift (steipete/CodexBar). UNVERIFIED by us.
//
// We keep only time, cost and model name per request (no prompts, no file names, no user ids), in
// <data dir>/cursor-events.json, and after the first sync only fetch what's new.

export interface CursorEvent { t: number; charged: number; list: number; tokens: number; model: string }

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

// One page of the response. Numbers arrive as strings sometimes; missing or odd fields count as 0.
// Returns null if this doesn't look like a usage events page at all (e.g. an error envelope).
export function parseEventsPage(json: unknown): { total?: number; events: CursorEvent[] } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const d = json as Record<string, unknown>;
  if (Object.keys(d).length === 0) return { total: 0, events: [] }; // Cursor's answer for "nothing in this range"
  const list = d.usageEventsDisplay;
  if (list === undefined && num(d.totalUsageEventsCount) !== undefined) return { total: num(d.totalUsageEventsCount), events: [] };
  if (!Array.isArray(list)) return null;
  const events: CursorEvent[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const t = num(o.timestamp);
    if (!t || t <= 0) continue;
    const u = (o.tokenUsage && typeof o.tokenUsage === "object" ? o.tokenUsage : {}) as Record<string, unknown>;
    const tokens = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"].reduce((s, k) => s + Math.max(0, num(u[k]) ?? 0), 0);
    events.push({
      t,
      charged: Math.max(0, num(o.chargedCents) ?? 0),        // what the plan actually deducts
      list: Math.max(0, num(u.totalCents) ?? 0),              // API list price of the request
      tokens,
      model: typeof o.model === "string" && o.model ? o.model : "unknown",
    });
  }
  return { total: num(d.totalUsageEventsCount), events };
}

// Which number best measures "how much of the allowance this used". chargedCents is what Cursor bills
// against the plan; some plans report 0 there for included usage, then list price, then raw tokens.
export function weightOf(events: CursorEvent[]): { unit: "usd" | "tokens"; w: (e: CursorEvent) => number } {
  if (events.some((e) => e.charged > 0)) return { unit: "usd", w: (e) => e.charged / 100 };
  if (events.some((e) => e.list > 0)) return { unit: "usd", w: (e) => e.list / 100 };
  return { unit: "tokens", w: (e) => e.tokens };
}

interface Cache { from: number; syncedTo: number; events: CursorEvent[] }
const PAGE = 1000, MAX_PAGES = 50;
const OVERLAP = 30 * 60_000; // re-fetch the last half hour: late-arriving events get picked up

export class CursorEvents {
  private cache: Cache | null = null;
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, "cursor-events.json"); }

  private load(): Cache | null {
    if (!this.cache) { try { this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.cache = null; } }
    return this.cache;
  }

  // Events from `from` (the billing cycle start, or earlier for the daily chart) until now.
  // Throws on network/HTTP problems; the caller treats history as optional.
  async sync(cookie: string, from: number, now: number, onUnknown?: (json: unknown) => void): Promise<CursorEvent[]> {
    const c = this.load();
    const reuse = c && c.from <= from && c.syncedTo > from;
    const since = reuse ? Math.max(from, c!.syncedTo - OVERLAP) : from;
    const fresh: CursorEvent[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
        method: "POST",
        // Cursor checks Origin on these POSTs (CSRF protection)
        headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json", Origin: "https://cursor.com", "User-Agent": "quotapus" },
        body: JSON.stringify({ page, pageSize: PAGE, startDate: String(since), endDate: String(now) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = parseEventsPage(json);
      if (!parsed) { onUnknown?.(json); throw new Error("unrecognised response"); }
      fresh.push(...parsed.events);
      if (parsed.events.length < PAGE) break;
      if (page === MAX_PAGES) throw new Error("too many pages"); // never publish a partial history as complete
    }
    // Replace everything we had from `since` on with the fresh copy (the API has no event ids to merge on).
    const kept = reuse ? c!.events.filter((e) => e.t >= from && e.t < since) : [];
    const events = [...kept, ...fresh.filter((e) => e.t >= since)].sort((a, b) => a.t - b.t);
    this.cache = { from, syncedTo: now, events };
    try { writeJsonAtomic(this.file, this.cache); } catch { /* history is a bonus; never fail the fetch over it */ }
    return events;
  }
}
