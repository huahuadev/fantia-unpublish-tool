// NOTE: this file is loaded as a <script> tag, not as a module.
// Avoid `export` / `import` so TS doesn't emit CommonJS wrappers.

interface LogEntry {
  level: "info" | "warn" | "error" | "success" | "debug";
  msg: string;
  ts: number;
}
interface ProgressEntry {
  current: number;
  total: number;
  label: string;
}
interface StateEntry {
  running: boolean;
  historyCount: number;
}
interface FantiaApi {
  startUnpublish: (r: number) => Promise<{ ok: boolean }>;
  startRepublish: (r: number) => Promise<{ ok: boolean }>;
  startRepublishAll: (r: number) => Promise<{ ok: boolean }>;
  abort: () => Promise<{ ok: boolean }>;
  getState: () => Promise<StateEntry>;
  clearHistory: () => Promise<{ ok: boolean }>;
  exportHistoryCsv: () => Promise<{ ok: boolean; reason?: string }>;
  navLogin: () => Promise<{ ok: boolean }>;
  focusFantia: () => Promise<{ ok: boolean }>;
  onLog: (cb: (e: LogEntry) => void) => void;
  onProgress: (cb: (e: ProgressEntry) => void) => void;
  onState: (cb: (e: StateEntry) => void) => void;
  onCompleted: (cb: (e: { message: string }) => void) => void;
}
const fapi: FantiaApi = (window as unknown as { api: FantiaApi }).api;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const btnNavLogin = $<HTMLButtonElement>("btnNavLogin");
const btnFocusFantia = $<HTMLButtonElement>("btnFocusFantia");
const rateInput = $<HTMLInputElement>("rateInput");
const btnUnpublish = $<HTMLButtonElement>("btnUnpublish");
const btnRepublish = $<HTMLButtonElement>("btnRepublish");
const btnRepublishAll = $<HTMLButtonElement>("btnRepublishAll");
const btnAbort = $<HTMLButtonElement>("btnAbort");
const btnClearHistory = $<HTMLButtonElement>("btnClearHistory");
const btnExportHistory = $<HTMLButtonElement>("btnExportHistory");
const historyBadge = $<HTMLSpanElement>("historyBadge");
const progressFill = $<HTMLDivElement>("progressFill");
const progressText = $<HTMLDivElement>("progressText");
const logBox = $<HTMLDivElement>("log");

let running = false;
let historyCount = 0;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendLog(e: LogEntry): void {
  const div = document.createElement("div");
  div.className = `entry l-${e.level}`;
  div.innerHTML = `<span class="ts">${fmtTime(e.ts)}</span>${escapeHtml(e.msg)}`;
  logBox.appendChild(div);
  while (logBox.children.length > 800) {
    logBox.removeChild(logBox.firstChild as Node);
  }
  logBox.scrollTop = logBox.scrollHeight;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyUiState(): void {
  btnUnpublish.disabled = running;
  btnRepublish.disabled = running || historyCount === 0;
  btnRepublishAll.disabled = running;
  btnAbort.disabled = !running;
  btnClearHistory.disabled = running || historyCount === 0;
  btnExportHistory.disabled = running || historyCount === 0;
  btnNavLogin.disabled = running;
  historyBadge.textContent = String(historyCount);
}

async function refreshState(): Promise<void> {
  const s = await fapi.getState();
  running = s.running;
  historyCount = s.historyCount;
  applyUiState();
}

btnNavLogin.addEventListener("click", () => {
  void fapi.navLogin();
});
btnFocusFantia.addEventListener("click", () => {
  void fapi.focusFantia();
});
btnUnpublish.addEventListener("click", async () => {
  const ok = window.confirm(
    "本当に、このファンクラブの全投稿を一括で非公開にしますか？"
  );
  if (!ok) return;
  const rate = Math.max(0, Math.min(60, Number(rateInput.value) || 0));
  await fapi.startUnpublish(rate);
});
btnRepublish.addEventListener("click", async () => {
  const ok = window.confirm(
    `このツールで非公開にした ${historyCount} 件を公開状態に戻します。よろしいですか？`
  );
  if (!ok) return;
  const rate = Math.max(0, Math.min(60, Number(rateInput.value) || 0));
  await fapi.startRepublish(rate);
});
btnRepublishAll.addEventListener("click", async () => {
  const ok = window.confirm(
    "現在「非公開」状態のすべての投稿を公開に戻します。\n元々非公開だったものも含めて公開されます。よろしいですか？"
  );
  if (!ok) return;
  const rate = Math.max(0, Math.min(60, Number(rateInput.value) || 0));
  await fapi.startRepublishAll(rate);
});
btnAbort.addEventListener("click", () => {
  void fapi.abort();
});
btnClearHistory.addEventListener("click", async () => {
  const ok = window.confirm(
    "非公開化履歴をクリアします。クリア後は本ツールから再公開できなくなります。よろしいですか？"
  );
  if (!ok) return;
  await fapi.clearHistory();
});
btnExportHistory.addEventListener("click", async () => {
  await fapi.exportHistoryCsv();
});

fapi.onLog(appendLog);
fapi.onCompleted((e) => {
  window.alert(e.message);
});
fapi.onState((s) => {
  running = s.running;
  historyCount = s.historyCount;
  applyUiState();
});
fapi.onProgress((p) => {
  if (p.total <= 0) {
    progressFill.style.width = "0";
    progressText.textContent = "待機中";
    return;
  }
  const pct = Math.round((p.current / p.total) * 100);
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `${p.current} / ${p.total} (${pct}%) — ${p.label}`;
});

void refreshState();
