import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BreakdownItem } from "./providers/types";

// Claude Code writes every conversation to ~/.claude/projects/**/*.jsonl, one JSON object per line.
// Assistant lines carry token counts. We read ONLY counts, model and project folder name; prompt
// and response text is parsed by JSON.parse but immediately discarded and never stored or sent anywhere.

// w = tokens (for "where it went"); c = rough cost weight (for the usage curve's shape). Output tokens cost
// ~5x input and cache writes ~1.25x across Claude's price list, so c tracks quota burn better than raw tokens.
export interface Entry { t: number; project: string; model: string; w: number; c: number }

// Weight = tokens that actually cost quota. Cache *reads* are excluded: they're ~10x cheaper and
// would otherwise dominate the numbers and hide what you actively worked on.
export function parseLine(line: string): { key: string; entry: Entry } | null {
  if (!line.includes('"usage"')) return null; // cheap prefilter before the expensive JSON.parse
  let o: any;
  try { o = JSON.parse(line); } catch { return null; } // a half-written last line is normal; skip it
  const u = o?.message?.usage;
  if (o?.type !== "assistant" || !u || o.message.model === "<synthetic>") return null;
  const t = Date.parse(o.timestamp);
  if (Number.isNaN(t)) return null;
  const project: string = o.cwd ?? ""; // full folder path; names are derived later, so same-named folders don't merge
  const w = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  // The same API message is logged several times as it streams (and again when a session is resumed),
  // so we de-duplicate on message id + request id and keep the latest (largest) numbers.
  const key = `${o.message.id ?? o.uuid}|${o.requestId ?? ""}`;
  const c = (u.input_tokens ?? 0) + 5 * (u.output_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  return { key, entry: { t, project, model: String(o.message.model ?? ""), w, c } };
}

const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

// Turn a folder path into a label a person recognises. Same-named folders get their parent too
// ("work/app" vs "side/app"), temp folders say so, and the full path stays available as a tooltip.
export function displayName(p: string, home: string, all: string[] = [p]): string {
  if (!p) return "Unknown folder";
  if (p === home) return "Home folder";
  const base = path.basename(p);
  if (TEMP_DIRS.some((t) => p.startsWith(t))) return `${base} (temp folder)`;
  const clash = all.some((q) => q !== p && path.basename(q) === base);
  return clash ? `${path.basename(path.dirname(p))}/${base}` : base;
}

export function summarize(entries: Iterable<Entry>, since: number, modelMatch?: string, top = 3, home = os.homedir()): BreakdownItem[] {
  const byProject = new Map<string, number>();
  let total = 0;
  for (const e of entries) {
    if (e.t < since || (modelMatch && !e.model.includes(modelMatch))) continue;
    byProject.set(e.project, (byProject.get(e.project) ?? 0) + e.w);
    total += e.w;
  }
  if (total === 0) return [];
  const sorted = [...byProject].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, top).map(([p]) => p);
  const items = sorted.slice(0, top).map(([p, w]) => ({ name: displayName(p, home, shown), path: p || undefined, share: Math.round((w / total) * 100) }));
  const rest = sorted.slice(top).reduce((n, [, w]) => n + w, 0);
  if (rest > 0) items.push({ name: "Other", path: undefined, share: Math.round((rest / total) * 100) });
  return items;
}

// Logs can reach hundreds of MB, so we never re-read them. For each file we remember how many bytes
// we've already processed and only read what was appended since (like `tail -f`).
export class LogScanner {
  private offsets = new Map<string, number>();
  readonly entries = new Map<string, Entry>();
  constructor(private root: string) {}

  async scan(now: number, maxAgeMs: number): Promise<void> {
    for (const file of await this.list(this.root, now - maxAgeMs)) await this.readNew(file);
    for (const [k, e] of this.entries) if (e.t < now - maxAgeMs) this.entries.delete(k); // prune
  }

  private async list(dir: string, minMtime: number): Promise<string[]> {
    let items: fs.Dirent[];
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) out.push(...(await this.list(p, minMtime)));
      else if (it.name.endsWith(".jsonl") && (await fs.promises.stat(p)).mtimeMs >= minMtime) out.push(p);
    }
    return out;
  }

  private async readNew(file: string) {
    const size = (await fs.promises.stat(file)).size;
    let start = this.offsets.get(file) ?? 0;
    if (size < start) start = 0; // file was replaced/truncated: start over
    if (size === start) return;
    const fh = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const end = buf.lastIndexOf(10); // only consume complete lines; a partial one is read next time
      if (end < 0) return;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        const r = parseLine(line);
        if (r) this.entries.set(r.key, r.entry);
      }
      this.offsets.set(file, start + end + 1);
    } finally { await fh.close(); }
  }
}
