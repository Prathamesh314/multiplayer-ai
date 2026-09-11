const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  pairComputer: (code) => ipcRenderer.invoke("desktop:pair", code),
});
