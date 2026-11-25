const { contextBridge, ipcRenderer } = require("electron");
const api = {};
for (const name of [
  "files",
  "store",
  "install",
  "cancelInstall",
  "removeInstall",
  "choose",
  "host",
  "join",
  "leave",
  "wire",
  "drop",
  "copy",
  "play",
  "members",
  "packet",
  "stop",
])
  api[name] = (...args) => ipcRenderer.invoke("q:" + name, ...args);
api.events = (fn) => ipcRenderer.on("q:event", (_e, ev) => fn(ev));
contextBridge.exposeInMainWorld("qonsole", api);
