import fs from "node:fs";
import path from "node:path";
import type { Sample } from "./forecast";
import { shouldRecord } from "./forecast";
import { writeJsonAtomic } from "./fsutil";

// Per-meter usage readings, stored in the data dir. Feeds forecasting and the usage chart.
// When a quota window ends we also archive a one-line summary of it (peak usage etc.), so that
// "this week vs last week" style insights become possible once enough windows have piled up.
type Store = Record<string, { resetKey: number; resetsAt?: string; samples: Sample[] }>;
export interface FinishedWindow { key: string; resetsAt?: string; startedAt: number; endedAt: number; peak: number; readings: number }
const MAX_SAMPLES = 800;
const MAX_WINDOWS = 500;

export class History {
  private store: Store | null = null;
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, "history.json"); }
  private get windowsFile() { return path.join(this.dir, "windows.json"); }

  private load(): Store {
    if (!this.store) { try { this.store = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.store = {}; } }
    return this.store!;
  }

  finishedWindows(): FinishedWindow[] {
    try { return JSON.parse(fs.readFileSync(this.windowsFile, "utf8")); } catch { return []; }
  }

  private archive(key: string, h: Store[string]) {
    if (h.samples.length < 2) return; // too little to be worth keeping
    const done: FinishedWindow = {
      key, resetsAt: h.resetsAt, startedAt: h.samples[0].t, endedAt: h.samples[h.samples.length - 1].t,
      peak: Math.max(...h.samples.map((s) => s.p)), readings: h.samples.length,
    };
    writeJsonAtomic(this.windowsFile, [...this.finishedWindows(), done].slice(-MAX_WINDOWS));
  }

  // Records a reading and returns the history for that meter. A new quota window (different reset
  // time, or usage went down) archives the old one and starts fresh, since its readings no longer apply.
  record(key: string, now: number, p: number, resetsAt?: string): Sample[] {
    const s = this.load();
    const resetKey = resetsAt ? Math.round(Date.parse(resetsAt) / (10 * 60_000)) : 0; // 10-min buckets absorb API jitter
    let h = s[key];
    const last = h?.samples[h.samples.length - 1];
    if (!h || Math.abs(h.resetKey - resetKey) > 1 || (last && p < last.p)) {
      if (h) this.archive(key, h);
      h = s[key] = { resetKey, resetsAt, samples: [] };
    }
    if (shouldRecord(h.samples, now, p)) {
      h.samples.push({ t: now, p });
      if (h.samples.length > MAX_SAMPLES) h.samples = h.samples.filter((_, i) => i % 2 === 0 || i === h.samples.length - 1);
      writeJsonAtomic(this.file, s);
    }
    return h.samples;
  }
}
