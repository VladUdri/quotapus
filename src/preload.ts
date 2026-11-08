import { contextBridge, ipcRenderer } from "electron";
// The only door between the web page and Node: a few named functions, nothing else.
contextBridge.exposeInMainWorld("quota", {
  get: () => ipcRenderer.invoke("quota:get"),
  refresh: () => ipcRenderer.invoke("quota:refresh"),
  onUpdate: (cb: (d: unknown) => void) => ipcRenderer.on("quota:updated", (_e, d) => cb(d)),
  action: (id: string, action: string) => ipcRenderer.invoke("provider:action", id, action),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (p: unknown) => ipcRenderer.invoke("settings:set", p),
  onOpenSettings: (cb: () => void) => ipcRenderer.on("ui:settings", () => cb()),
  menu: () => ipcRenderer.send("ui:menu"),
  resize: (h: number) => ipcRenderer.send("ui:resize", h),
});
