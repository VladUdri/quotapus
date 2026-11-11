import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./fsutil";

export interface Config {
  onboarded: boolean;           // has the welcome card been shown?
  showPercentInMenuBar: boolean;
  notifications: boolean;
  notifyAt: number[];           // % thresholds that trigger a notification
  refreshSeconds: number;
  notified: string[];           // "already warned" keys so we don't nag
  menuBarMeter: string;         // "<provider id>|<meter label>", "max" = highest, "" = first meter
  disabledProviders: string[];  // provider ids switched off in settings (a list of "off", so new providers start on)
  workDays: Record<string, number[]>; // provider id -> weekdays you work with it (0 = Sunday); absent = learned from history
}

const defaults: Config = {
  onboarded: false, showPercentInMenuBar: true, notifications: true,
  notifyAt: [80, 95], refreshSeconds: 300, notified: [], menuBarMeter: "", disabledProviders: [], workDays: {},
};

// Lives in ~/Library/Application Support/quotapus, so it survives reinstalls/updates
// (the install folder gets wiped on every update).
const file = () => path.join(app.getPath("userData"), "config.json");

export function loadConfig(): Config {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; }
  catch { return { ...defaults }; }
}
export const saveConfig = (c: Config) => writeJsonAtomic(file(), c);
