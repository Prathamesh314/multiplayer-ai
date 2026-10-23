const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  pairComputer: (code) => ipcRenderer.invoke("desktop:pair", code),
  secretNames: () => ipcRenderer.invoke("desktop:secret-names"),
  setSecret: (name, value) => ipcRenderer.invoke("desktop:secret-set", name, value),
  removeSecret: (name) => ipcRenderer.invoke("desktop:secret-remove", name),
  // A newer release from the website: its state, Restart to install, and what changed.
  updateState: () => ipcRenderer.invoke("desktop:update-state"),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("desktop:update", listener);
    return () => ipcRenderer.removeListener("desktop:update", listener);
  },
  installUpdate: () => ipcRenderer.invoke("desktop:update-install"),
  showUpdateChanges: () => ipcRenderer.invoke("desktop:update-changes"),
});
