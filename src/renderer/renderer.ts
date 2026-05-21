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
  startUnpublish: (r: number, adultOnly: boolean) => Promise<{ ok: boolean }>;
  startRepublish: (r: number) => Promise<{ ok: boolean }>;
  startRepublishAll: (
    r: number,
    adultOnly: boolean
  ) => Promise<{ ok: boolean }>;
  abort: () => Promise<{ ok: boolean }>;
  getState: () => Promise<StateEntry>;
  clearHistory: () => Promise<{ ok: boolean }>;
  exportHistoryCsv: () => Promise<{ ok: boolean; reason?: string }>;
  navLogin: () => Promise<{ ok: boolean }>;
  onLog: (cb: (e: LogEntry) => void) => void;
  onProgress: (cb: (e: ProgressEntry) => void) => void;
  onState: (cb: (e: StateEntry) => void) => void;
  onCompleted: (cb: (e: { message: string }) => void) => void;
}
const fapi: FantiaApi = (window as unknown as { api: FantiaApi }).api;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const btnNavLogin = $<HTMLButtonElement>("btnNavLogin");
const rateInput = $<HTMLInputElement>("rateInput");
const adultOnlyInput = $<HTMLInputElement>("adultOnlyInput");
const btnUnpublish = $<HTMLButtonElement>("btnUnpublish");
const btnRepublish = $<HTMLButtonElement>("btnRepublish");
const btnRepublishAll = $<HTMLButtonElement>("btnRepublishAll");
const btnClearHistory = $<HTMLButtonElement>("btnClearHistory");
const btnExportHistory = $<HTMLButtonElement>("btnExportHistory");
const historyBadge = $<HTMLSpanElement>("historyBadge");
const logBox = $<HTMLDivElement>("log");

type ActionKind = "unpublish" | "republish" | "republish-all";

interface ActionDef {
  btn: HTMLButtonElement;
  defaultLabel: string;
  withBadge: boolean;
  start: () => Promise<{ ok: boolean }>;
  confirmMessage: () => string;
}

let running = false;
let historyCount = 0;
let runningKind: ActionKind | null = null;
let abortInFlight = false;

const actions: Record<ActionKind, ActionDef> = {
  unpublish: {
    btn: btnUnpublish,
    defaultLabel: "すべての投稿を非公開にする",
    withBadge: false,
    start: () => fapi.startUnpublish(getRate(), getAdultOnly()),
    confirmMessage: () =>
      getAdultOnly()
        ? "公開中の R18 投稿を一括で非公開にします。よろしいですか？"
        : "公開中のすべての投稿 (R18 以外も含む) を一括で非公開にします。本当によろしいですか？",
  },
  republish: {
    btn: btnRepublish,
    defaultLabel: "このツールで非公開にしたものを公開する",
    withBadge: true,
    start: () => fapi.startRepublish(getRate()),
    confirmMessage: () =>
      `このツールで非公開にした ${historyCount} 件を公開状態に戻します。よろしいですか？`,
  },
  "republish-all": {
    btn: btnRepublishAll,
    defaultLabel: "非公開のものを全部公開する",
    withBadge: false,
    start: () => fapi.startRepublishAll(getRate(), getAdultOnly()),
    confirmMessage: () =>
      getAdultOnly()
        ? "現在「非公開」状態の R18 投稿を公開に戻します。よろしいですか？"
        : "現在「非公開」状態のすべての投稿 (R18 以外も含む) を公開に戻します。\n元々非公開だったものも含めて公開されます。よろしいですか？",
  },
};

function getRate(): number {
  return Math.max(0, Math.min(60, Number(rateInput.value) || 0));
}

function getAdultOnly(): boolean {
  return adultOnlyInput.checked;
}

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

function setButtonLabel(kind: ActionKind, text: string): void {
  const def = actions[kind];
  const labelEl = def.btn.querySelector(".action-label") as HTMLElement;
  if (def.withBadge) {
    labelEl.innerHTML = `${escapeHtml(text)} <span class="badge" id="historyBadge">${historyCount}</span>`;
  } else {
    labelEl.textContent = text;
  }
}

function setButtonFill(kind: ActionKind, pct: number): void {
  const fill = actions[kind].btn.querySelector(".action-fill") as HTMLElement;
  fill.style.width = `${pct}%`;
}

function resetButton(kind: ActionKind): void {
  setButtonFill(kind, 0);
  setButtonLabel(kind, actions[kind].defaultLabel);
  actions[kind].btn.classList.remove("running");
}

function applyUiState(): void {
  for (const k of Object.keys(actions) as ActionKind[]) {
    const def = actions[k];
    const isRunningThis = running && runningKind === k;
    if (isRunningThis) {
      def.btn.disabled = false;
      def.btn.classList.add("running");
    } else {
      def.btn.classList.remove("running");
      let disabled = running;
      if (k === "republish" && historyCount === 0) disabled = true;
      def.btn.disabled = disabled;
      if (!running) {
        setButtonFill(k, 0);
        setButtonLabel(k, def.defaultLabel);
      }
    }
  }
  btnClearHistory.disabled = running || historyCount === 0;
  btnExportHistory.disabled = running || historyCount === 0;
  btnNavLogin.disabled = running;

  if (actions.republish.withBadge) {
    const badge = document.getElementById("historyBadge");
    if (badge) badge.textContent = String(historyCount);
  }
}

async function refreshState(): Promise<void> {
  const s = await fapi.getState();
  running = s.running;
  historyCount = s.historyCount;
  applyUiState();
}

function attachActionHandler(kind: ActionKind): void {
  const def = actions[kind];
  def.btn.addEventListener("click", async () => {
    if (running && runningKind === kind) {
      if (abortInFlight) return;
      abortInFlight = true;
      setButtonLabel(kind, "中断中…");
      await fapi.abort();
      return;
    }
    if (running) return;
    const ok = window.confirm(def.confirmMessage());
    if (!ok) return;
    runningKind = kind;
    running = true;
    abortInFlight = false;
    setButtonFill(kind, 0);
    setButtonLabel(kind, "開始中… (もう一度押すと中断)");
    applyUiState();
    await def.start();
  });
}

attachActionHandler("unpublish");
attachActionHandler("republish");
attachActionHandler("republish-all");

btnNavLogin.addEventListener("click", () => {
  void fapi.navLogin();
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
  const wasRunning = running;
  running = s.running;
  historyCount = s.historyCount;
  if (wasRunning && !running) {
    if (runningKind) resetButton(runningKind);
    runningKind = null;
    abortInFlight = false;
  }
  applyUiState();
});
fapi.onProgress((p) => {
  if (!runningKind) return;
  if (p.total <= 0) {
    setButtonFill(runningKind, 0);
    if (!abortInFlight) {
      setButtonLabel(runningKind, "準備中… (もう一度押すと中断)");
    }
    return;
  }
  const pct = Math.round((p.current / p.total) * 100);
  setButtonFill(runningKind, pct);
  if (!abortInFlight) {
    setButtonLabel(
      runningKind,
      `${p.current} / ${p.total} (${pct}%) — もう一度押すと中断`
    );
  }
});

void refreshState();
