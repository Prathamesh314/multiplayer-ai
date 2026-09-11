const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopSetup", {
  status: () => ipcRenderer.invoke("desktop:status"),
  connect: (url) => ipcRenderer.invoke("desktop:connect", url),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  toggleRunner: () => ipcRenderer.invoke("desktop:toggle-runner"),
  checkUpdates: () => ipcRenderer.invoke("desktop:updates"),
});
