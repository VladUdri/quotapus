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
}

const defaults: Config = {
  onboarded: false, showPercentInMenuBar: true, notifications: true,
  notifyAt: [80, 95], refreshSeconds: 300, notified: [],
};

// Lives in ~/Library/Application Support/quotapus, so it survives reinstalls/updates
// (the install folder gets wiped on every update).
const file = () => path.join(app.getPath("userData"), "config.json");

export function loadConfig(): Config {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; }
  catch { return { ...defaults }; }
}
export const saveConfig = (c: Config) => writeJsonAtomic(file(), c);
