import { contextBridge, ipcRenderer } from "electron";

export interface LogEntry {
  level: "info" | "warn" | "error" | "success" | "debug";
  msg: string;
  ts: number;
}

export interface ProgressEntry {
  current: number;
  total: number;
  label: string;
}

export interface StateEntry {
  running: boolean;
  historyCount: number;
}

contextBridge.exposeInMainWorld("api", {
  startUnpublish: (rateSeconds: number) =>
    ipcRenderer.invoke("start-unpublish", rateSeconds),
  startRepublish: (rateSeconds: number) =>
    ipcRenderer.invoke("start-republish", rateSeconds),
  startRepublishAll: (rateSeconds: number) =>
    ipcRenderer.invoke("start-republish-all", rateSeconds),
  abort: () => ipcRenderer.invoke("abort"),
  getState: () => ipcRenderer.invoke("get-state"),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  exportHistoryCsv: () => ipcRenderer.invoke("export-history-csv"),
  navLogin: () => ipcRenderer.invoke("nav-login"),

  onLog: (cb: (e: LogEntry) => void) => {
    ipcRenderer.on("log", (_evt, payload) => cb(payload));
  },
  onProgress: (cb: (e: ProgressEntry) => void) => {
    ipcRenderer.on("progress", (_evt, payload) => cb(payload));
  },
  onState: (cb: (e: StateEntry) => void) => {
    ipcRenderer.on("state", (_evt, payload) => cb(payload));
  },
  onCompleted: (cb: (e: { message: string }) => void) => {
    ipcRenderer.on("completed", (_evt, payload) => cb(payload));
  },
});
