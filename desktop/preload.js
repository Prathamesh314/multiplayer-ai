const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  pairComputer: (code) => ipcRenderer.invoke("desktop:pair", code),
  secretNames: () => ipcRenderer.invoke("desktop:secret-names"),
  setSecret: (name, value) => ipcRenderer.invoke("desktop:secret-set", name, value),
  removeSecret: (name) => ipcRenderer.invoke("desktop:secret-remove", name),
});
