// Every provider (Claude, later others) returns the same shape,
// so the UI never needs to know where the data came from.
// Computed by quotapus (not the provider) from recent readings. See src/forecast.ts.
export interface Forecast {
  ratePerHour: number;           // recent burn rate, percentage points per hour (>= 0)
  minutesToLimit: number | null; // estimated minutes until 100%; null = not burning / not enough data
  hitsBeforeReset: boolean;      // true = at this pace the limit is reached before the window resets
}
// "Where did it go": share of recent token use per project (top few + "Other").
export interface BreakdownItem { name: string; path?: string; share: number } // path = full folder, for a tooltip // share = 0-100
export interface QuotaMeter {
  label: string;       // e.g. "5-hour session"
  usedPercent: number; // 0-100
  resetsAt?: string;   // ISO date
  windowMinutes?: number; // length of the quota window (300 = 5 hours)
  breakdown?: BreakdownItem[];
  breakdownLabel?: string; // what the breakdown splits by, e.g. "by model, share of spend"
  // [time ms, used %, 1 = estimated] for the chart. Built by main.ts from our readings + `curve`.
  spark?: [number, number, number?][];
  forecast?: Forecast; // absent until we have enough history
  // Usage over this window reconstructed from the provider's own event history (see src/backfill.ts),
  // already pinned to usedPercent at the end. exact = from the provider's server (Cursor), not an estimate.
  curve?: { t: number; p: number }[];
  curveExact?: boolean;
  daily?: { t: number; v: number }[]; // usage per local day, oldest first (today last)
  dailyUnit?: "usd" | "tokens";
}
// "not_connected" = user hasn't set this provider up yet (show setup hint, not an error)
export type Status = "ok" | "not_connected" | "error";
export interface ProviderResult {
  id: string;
  name: string;
  status: Status;
  plan?: string;       // e.g. "Pro"
  message?: string;    // hint or error text for the user
  hidden?: boolean;       // not set up and not worth showing (e.g. Cursor not installed)
  recheckSec?: number;    // the problem is local and free to re-check soon (e.g. expired login), so skip backoff
  action?: "refresh-login" | "open-settings"; // a button the UI can offer to fix the problem
  retryAfterSec?: number; // set when the provider asked us to slow down (HTTP 429)
  stale?: boolean;     // true = fetch failed, meters are the last known good values
  meters: QuotaMeter[];
}
export interface Provider {
  id: string;
  name: string;
  fetch(): Promise<ProviderResult>;
  refreshLogin?(): Promise<{ ok: boolean; message?: string }>;
}
