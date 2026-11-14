const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("promo", {
  snapshot: () => ipcRenderer.invoke("promo:snapshot"),
  popupHtml: () => ipcRenderer.invoke("promo:popup"),
  start: () => ipcRenderer.send("promo:start"),
  mark: (name) => ipcRenderer.send("promo:mark", name), // scene changes, so the music can hit them
  done: () => ipcRenderer.send("promo:done"),
  fail: (m) => ipcRenderer.send("promo:fail", m),
});
