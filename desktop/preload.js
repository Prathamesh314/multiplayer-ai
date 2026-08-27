// Minimal, safe preload. contextIsolation is on and nodeIntegration is off,
// so the web app runs sandboxed just like in a browser. Expose a tiny marker
// the web app can feature-detect if it ever needs to know it's in the shell.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
});
