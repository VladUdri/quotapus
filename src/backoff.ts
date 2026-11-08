// How long to wait before the next fetch. Pure functions, so they're easy to test.
//
// Exponential backoff: after each consecutive failure, wait twice as long (120s, 240s, 480s...),
// up to 15 minutes. Hammering a server that is already saying "slow down" only makes things worse.
// If the server tells us exactly how long to wait (Retry-After), we obey that instead (capped at 1h).
const MAX_BACKOFF_SEC = 15 * 60;
const MAX_RETRY_AFTER_SEC = 60 * 60;

export function nextDelayMs(baseSec: number, failures: number, retryAfterSec?: number): number {
  const backoff = Math.min(baseSec * 2 ** Math.min(failures, 6), MAX_BACKOFF_SEC);
  const server = Math.min(retryAfterSec ?? 0, MAX_RETRY_AFTER_SEC);
  return Math.max(baseSec, backoff, server) * 1000;
}

// Retry-After is either a number of seconds ("120") or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT").
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header);
  const t = Date.parse(header);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.ceil((t - now) / 1000));
}
