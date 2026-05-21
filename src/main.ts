import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";

const FANTIA_LOGIN = "https://fantia.jp/sessions/signin";
// status_eq=1 で「公開中」のみ、status_eq=0 で「非公開」のみに絞る
const FANTIA_POSTS_LIST_OPEN =
  "https://fantia.jp/mypage/fanclubs/posts?q%5Bstatus_eq%5D=1&q%5Bs%5D=created_at+desc";
const FANTIA_POSTS_LIST_CLOSED =
  "https://fantia.jp/mypage/fanclubs/posts?q%5Bstatus_eq%5D=0&q%5Bs%5D=created_at+desc";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PARTITION = "persist:fantia-unpublish";

let controlWindow: BrowserWindow | null = null;
let fantiaWindow: BrowserWindow | null = null;
let running = false;
let abortRequested = false;

type Action = "unpublish" | "republish";

type LogLevel = "info" | "warn" | "error" | "success" | "debug";

function historyPath(): string {
  return path.join(app.getPath("userData"), "unpublished-by-tool.json");
}

interface HistoryFile {
  postIds: string[];
  lastUpdated: string;
}

function loadHistory(): Set<string> {
  try {
    const txt = fs.readFileSync(historyPath(), "utf8");
    const data = JSON.parse(txt) as HistoryFile;
    return new Set<string>(data.postIds || []);
  } catch {
    return new Set();
  }
}

function saveHistory(ids: Set<string>): void {
  const data: HistoryFile = {
    postIds: Array.from(ids),
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(historyPath(), JSON.stringify(data, null, 2));
}

function emit(level: LogLevel, msg: string): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("log", { level, msg, ts: Date.now() });
  }
  console.log(`[${level}] ${msg}`);
}

function emitProgress(current: number, total: number, label: string): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("progress", { current, total, label });
  }
}

function emitCompleted(message: string): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("completed", { message });
  }
}

function emitState(): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("state", {
      running,
      historyCount: loadHistory().size,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createWindows(): Promise<void> {
  controlWindow = new BrowserWindow({
    width: 560,
    height: 820,
    x: 60,
    y: 80,
    title: "Fantia Unpublish Tool",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWindow.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      console.log(`[ctrl-renderer ${level}] ${message}  (${sourceId}:${line})`);
    }
  );
  controlWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[ctrl-fail-load] ${code} ${desc} ${url}`);
  });
  controlWindow.webContents.on(
    "preload-error",
    (_e, preloadPath, err) => {
      console.error(`[preload-error] ${preloadPath}: ${err}`);
    }
  );

  const indexPath = path.join(__dirname, "renderer/index.html");
  console.log(`[boot] loading control html: ${indexPath}`);
  console.log(`[boot] preload path: ${path.join(__dirname, "preload.js")}`);
  console.log(
    `[boot] preload exists: ${fs.existsSync(path.join(__dirname, "preload.js"))}`
  );
  console.log(`[boot] html exists: ${fs.existsSync(indexPath)}`);
  await controlWindow.loadFile(indexPath);

  if (process.env.FU_DEVTOOLS) {
    controlWindow.webContents.openDevTools({ mode: "detach" });
  }

  controlWindow.on("closed", () => {
    if (fantiaWindow && !fantiaWindow.isDestroyed()) fantiaWindow.close();
    controlWindow = null;
  });

  await openFantiaWindow(FANTIA_LOGIN);
}

async function navToLogin(): Promise<void> {
  if (!fantiaWindow || fantiaWindow.isDestroyed()) {
    await openFantiaWindow(FANTIA_LOGIN);
    return;
  }
  try {
    await fantiaWindow.loadURL(FANTIA_LOGIN);
    fantiaWindow.show();
    fantiaWindow.focus();
  } catch (e) {
    emit("warn", `ログイン画面遷移失敗: ${String((e as Error).message || e)}`);
  }
}

async function openFantiaWindow(initialUrl: string): Promise<void> {
  if (fantiaWindow && !fantiaWindow.isDestroyed()) {
    emit("debug", "Fantia ウィンドウは既に開いています");
    return;
  }
  emit("info", "Fantia ウィンドウを生成します");
  fantiaWindow = new BrowserWindow({
    width: 1100,
    height: 880,
    x: 640,
    y: 50,
    title: "Fantia (操作対象ブラウザ)",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
    },
  });
  fantiaWindow.webContents.setUserAgent(USER_AGENT);

  const blockScript = `
    (() => {
      if (window.__fdBlock) return;
      window.__fdBlock = true;
      window.confirm = () => true;
      window.alert = () => {};
    })();
  `;
  fantiaWindow.webContents.on("did-finish-load", () => {
    const url = fantiaWindow?.webContents.getURL();
    emit("debug", `did-finish-load: ${url}`);
    fantiaWindow?.webContents.executeJavaScript(blockScript).catch(() => {});
  });
  fantiaWindow.webContents.on("did-navigate", (_e, url) => {
    emit("debug", `did-navigate: ${url}`);
    fantiaWindow?.webContents.executeJavaScript(blockScript).catch(() => {});
  });
  fantiaWindow.webContents.on(
    "did-fail-load",
    (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return; // ERR_ABORTED is normal on nav-cancel
      emit("error", `読み込み失敗 code=${code} ${desc} url=${url}`);
    }
  );

  fantiaWindow.on("closed", () => {
    emit("warn", "Fantia ウィンドウが閉じられました");
    fantiaWindow = null;
    emitState();
  });

  try {
    await fantiaWindow.loadURL(initialUrl);
  } catch (e) {
    emit("warn", `初期ページ読み込み失敗: ${String((e as Error).message || e)}`);
  }
}

async function waitForSelector(sel: string, timeoutMs = 15000): Promise<boolean> {
  if (!fantiaWindow) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (abortRequested) return false;
    try {
      const found = await fantiaWindow.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(sel)})`
      );
      if (found) return true;
    } catch {
      // navigating, retry
    }
    await sleep(200);
  }
  return false;
}

async function collectPostIds(
  baseUrl: string,
  label: string,
  adultOnly: boolean
): Promise<string[]> {
  if (!fantiaWindow) return [];
  emit(
    "info",
    `${label}の投稿一覧を取得します... (R18 のみ: ${adultOnly ? "ON" : "OFF"})`
  );
  const all = new Set<string>();
  let page = 1;
  let totalSkipped = 0;
  while (true) {
    if (abortRequested) break;
    const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    try {
      await fantiaWindow.loadURL(url);
    } catch (e) {
      emit("warn", `ページ ${page} 読み込み失敗: ${String(e)}`);
      break;
    }
    const ok = await waitForSelector("body", 10000);
    if (!ok) break;
    await sleep(600);
    const result = (await fantiaWindow.webContents.executeJavaScript(`
      (() => {
        const adultOnly = ${adultOnly ? "true" : "false"};
        const found = [];
        const skipped = [];
        const seen = new Set();

        function findCard(linkEl, postId) {
          let current = linkEl;
          let last = linkEl;
          while (current.parentElement) {
            current = current.parentElement;
            if (current.tagName === 'BODY') break;
            const childLinks = current.querySelectorAll('a[href*="/posts/"]');
            let otherCount = 0;
            for (const a of childLinks) {
              const m = a.href.match(/\\/posts\\/(\\d+)/);
              if (!m) continue;
              if (/\\/posts\\/new/.test(a.href)) continue;
              if (m[1] !== postId) otherCount++;
            }
            if (otherCount > 0) break;
            last = current;
          }
          return last;
        }

        const links = Array.from(document.querySelectorAll('a[href*="/posts/"]'));
        for (const a of links) {
          if (!/\\/posts\\/\\d+/.test(a.href)) continue;
          if (/\\/posts\\/new/.test(a.href)) continue;
          const m = a.href.match(/\\/posts\\/(\\d+)/);
          if (!m) continue;
          const id = m[1];
          if (seen.has(id)) continue;
          seen.add(id);
          if (adultOnly) {
            const card = findCard(a, id);
            const text = (card.innerText || '') + ' ' + (card.textContent || '');
            const isAdult = /18\\+|R-?18|アダルト|成人/i.test(text);
            if (!isAdult) {
              skipped.push(id);
              continue;
            }
          }
          found.push(id);
        }
        return { found, skipped };
      })()
    `)) as { found: string[]; skipped: string[] };
    const ids = result.found;
    const pageSkipped = result.skipped.length;
    totalSkipped += pageSkipped;
    if (!ids.length && !pageSkipped) {
      emit("info", `  page ${page}: 0 件 (終了)`);
      break;
    }
    const before = all.size;
    for (const id of ids) all.add(id);
    const added = all.size - before;
    const skipMsg = pageSkipped > 0 ? ` (除外 ${pageSkipped} 件)` : "";
    emit(
      "info",
      `  page ${page}: ${ids.length} 件${skipMsg} (新規 ${added} 件 / 累積 ${all.size} 件)`
    );
    if (added === 0 && pageSkipped === 0) break;
    page++;
    if (page > 200) {
      emit("warn", "ページ上限に到達 (200)");
      break;
    }
    await sleep(400);
  }
  if (adultOnly && totalSkipped > 0) {
    emit("info", `R18 フィルタにより ${totalSkipped} 件を対象外にしました`);
  }
  return Array.from(all);
}

async function dismissDraftModal(): Promise<void> {
  if (!fantiaWindow) return;
  await fantiaWindow.webContents.executeJavaScript(`
    (() => {
      const modal = document.querySelector('.modal.fade.in, .modal.show');
      if (!modal) return null;
      const text = modal.innerText || '';
      if (!/編集途中|復元|下書き/.test(text)) return null;
      const btns = Array.from(modal.querySelectorAll('button'));
      const target = btns.find(b => /破棄|新規|復元しない|やめる|キャンセル/.test((b.innerText || '').trim()));
      if (target) target.click();
      return 'dismissed';
    })()
  `);
  await sleep(250);
}

interface StatusResult {
  ok: boolean;
  reason?: string;
  previousStatus?: string;
  alreadyAtTarget?: boolean;
}

async function changePostStatus(
  postId: string,
  newStatus: "open" | "closed"
): Promise<StatusResult> {
  if (!fantiaWindow) return { ok: false, reason: "no-window" };
  const editUrl = `https://fantia.jp/mypage/fanclubs/posts/${postId}/edit`;
  try {
    await fantiaWindow.loadURL(editUrl);
  } catch (e) {
    return { ok: false, reason: `load-failed: ${String(e)}` };
  }
  const ready = await waitForSelector('select[name="status"]', 15000);
  if (!ready) return { ok: false, reason: "edit-page-not-ready" };
  await sleep(400);
  await dismissDraftModal();

  const result = (await fantiaWindow.webContents.executeJavaScript(`
    (() => {
      const sel = document.querySelector('select[name="status"]');
      if (!sel) return { ok: false, reason: 'no-status-select' };
      const previousStatus = sel.value;
      if (previousStatus === ${JSON.stringify(newStatus)}) {
        return { ok: true, alreadyAtTarget: true, previousStatus };
      }
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      desc.set.call(sel, ${JSON.stringify(newStatus)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      for (const name of ['agreeToTheTermsOfUse', 'withParentalConsent', 'consentToProvideInformation']) {
        const cb = document.querySelector('input[name="' + name + '"]');
        if (cb && !cb.checked) cb.click();
      }
      return { ok: true, previousStatus, newValue: sel.value };
    })()
  `)) as StatusResult & { newValue?: string };

  if (!result.ok) return result;
  if (result.alreadyAtTarget) return result;

  await sleep(300);

  const saveRes = (await fantiaWindow.webContents.executeJavaScript(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
      const target = btns.find(b => /(変更を保存|保存する|同意して公開|更新する)/.test((b.innerText || '').trim()));
      if (!target) return { ok: false, reason: 'no-save-btn' };
      if (target.disabled) return { ok: false, reason: 'save-disabled' };
      target.scrollIntoView({ block: 'center' });
      target.click();
      return { ok: true, text: (target.innerText || '').trim().slice(0, 40) };
    })()
  `)) as { ok: boolean; reason?: string; text?: string };

  if (!saveRes.ok) return { ok: false, reason: saveRes.reason };

  const saved = await waitForSaveSuccess(20000);
  if (!saved) return { ok: false, reason: "save-confirm-timeout" };
  return { ok: true, previousStatus: result.previousStatus };
}

async function waitForSaveSuccess(timeoutMs = 15000): Promise<boolean> {
  if (!fantiaWindow) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (abortRequested) return false;
    try {
      const found = await fantiaWindow.webContents.executeJavaScript(`
        (() => {
          const t = document.body ? (document.body.innerText || '') : '';
          return /投稿を更新しました|続けて投稿する|更新が完了/.test(t);
        })()
      `);
      if (found) return true;
    } catch {
      // navigating mid-poll
    }
    await sleep(150);
  }
  return false;
}

function waitForNavigation(timeoutMs = 15000): Promise<string | null> {
  if (!fantiaWindow) return Promise.resolve(null);
  const wc = fantiaWindow.webContents;
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      wc.off("did-finish-load", handler);
      resolve(url);
    };
    const handler = () => finish(wc.getURL());
    wc.on("did-finish-load", handler);
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function runUnpublishAll(
  rateSeconds: number,
  adultOnly: boolean
): Promise<void> {
  if (running) {
    emit("warn", "すでに実行中です");
    return;
  }
  running = true;
  abortRequested = false;
  emitState();
  try {
    const targets = await collectPostIds(
      FANTIA_POSTS_LIST_OPEN,
      "公開中",
      adultOnly
    );
    if (!targets.length) {
      const msg = adultOnly
        ? "対象となる R18 投稿が見つかりませんでした。\nR18 (18+) フィルタを OFF にすると全年齢投稿も対象にできます。"
        : "公開中の投稿が見つかりませんでした。\nFantia にログイン (年齢確認も) しているか、公開中の投稿があるか確認してください。";
      emit("warn", msg);
      emitCompleted(msg);
      return;
    }
    emit("info", `対象 (公開中): ${targets.length} 件`);
    const history = loadHistory();
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    for (let i = 0; i < targets.length; i++) {
      if (abortRequested) {
        emit("warn", "中断要求を検出 — 停止します");
        break;
      }
      const id = targets[i];
      emitProgress(i + 1, targets.length, `処理中: post ${id}`);
      emit("info", `[${i + 1}/${targets.length}] post ${id} を非公開化中...`);
      const r = await changePostStatus(id, "closed");
      if (r.ok && r.alreadyAtTarget) {
        emit("info", `  → 既に非公開 (previous=${r.previousStatus})`);
        skipCount++;
      } else if (r.ok) {
        emit("success", `  ✓ 非公開化完了 (previous=${r.previousStatus})`);
        history.add(id);
        saveHistory(history);
        emitState();
        okCount++;
      } else {
        emit("error", `  ✗ 失敗: ${r.reason}`);
        failCount++;
      }
      if (i < targets.length - 1 && !abortRequested) {
        await sleep(Math.max(0, rateSeconds * 1000));
      }
    }
    const summary = `非公開化 ${okCount} 件 / スキップ ${skipCount} 件 / 失敗 ${failCount} 件`;
    emit("success", `完了: ${summary}`);
    emitCompleted(
      abortRequested ? `中断されました\n${summary}` : `非公開化が完了しました\n${summary}`
    );
  } catch (e) {
    emit("error", `予期しないエラー: ${String((e as Error).message || e)}`);
    emitCompleted(`エラーで停止しました: ${String((e as Error).message || e)}`);
  } finally {
    running = false;
    abortRequested = false;
    emitState();
    emitProgress(0, 0, "");
  }
}

async function runRepublishFromHistory(rateSeconds: number): Promise<void> {
  if (running) {
    emit("warn", "すでに実行中です");
    return;
  }
  running = true;
  abortRequested = false;
  emitState();
  try {
    const history = loadHistory();
    const ids = Array.from(history);
    emit("info", `履歴にある投稿: ${ids.length} 件`);
    if (!ids.length) {
      const msg = "再公開対象がありません。\nこのツールで非公開化した記録がありません。";
      emit("warn", msg);
      emitCompleted(msg);
      return;
    }
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    for (let i = 0; i < ids.length; i++) {
      if (abortRequested) {
        emit("warn", "中断要求を検出 — 停止します");
        break;
      }
      const id = ids[i];
      emitProgress(i + 1, ids.length, `処理中: post ${id}`);
      emit("info", `[${i + 1}/${ids.length}] post ${id} を公開化中...`);
      const r = await changePostStatus(id, "open");
      if (r.ok && r.alreadyAtTarget) {
        emit("info", `  → 既に公開 (履歴から削除)`);
        history.delete(id);
        saveHistory(history);
        emitState();
        skipCount++;
      } else if (r.ok) {
        emit("success", `  ✓ 公開化完了 (previous=${r.previousStatus})`);
        history.delete(id);
        saveHistory(history);
        emitState();
        okCount++;
      } else {
        emit("error", `  ✗ 失敗: ${r.reason}`);
        failCount++;
      }
      if (i < ids.length - 1 && !abortRequested) {
        await sleep(Math.max(0, rateSeconds * 1000));
      }
    }
    const summary = `公開化 ${okCount} 件 / スキップ ${skipCount} 件 / 失敗 ${failCount} 件`;
    emit("success", `完了: ${summary}`);
    emitCompleted(
      abortRequested ? `中断されました\n${summary}` : `公開化が完了しました\n${summary}`
    );
  } catch (e) {
    emit("error", `予期しないエラー: ${String((e as Error).message || e)}`);
    emitCompleted(`エラーで停止しました: ${String((e as Error).message || e)}`);
  } finally {
    running = false;
    abortRequested = false;
    emitState();
    emitProgress(0, 0, "");
  }
}

async function runRepublishAllClosed(
  rateSeconds: number,
  adultOnly: boolean
): Promise<void> {
  if (running) {
    emit("warn", "すでに実行中です");
    return;
  }
  running = true;
  abortRequested = false;
  emitState();
  try {
    const targets = await collectPostIds(
      FANTIA_POSTS_LIST_CLOSED,
      "非公開",
      adultOnly
    );
    if (!targets.length) {
      const msg = adultOnly
        ? "対象となる R18 の非公開投稿が見つかりませんでした。\nR18 (18+) フィルタを OFF にすると全年齢投稿も対象にできます。"
        : "非公開の投稿が見つかりませんでした。\nFantia にログイン (年齢確認も) しているか、非公開の投稿があるか確認してください。";
      emit("warn", msg);
      emitCompleted(msg);
      return;
    }
    emit("info", `対象 (非公開): ${targets.length} 件`);
    const history = loadHistory();
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    for (let i = 0; i < targets.length; i++) {
      if (abortRequested) {
        emit("warn", "中断要求を検出 — 停止します");
        break;
      }
      const id = targets[i];
      emitProgress(i + 1, targets.length, `処理中: post ${id}`);
      emit("info", `[${i + 1}/${targets.length}] post ${id} を公開化中...`);
      const r = await changePostStatus(id, "open");
      if (r.ok && r.alreadyAtTarget) {
        emit("info", `  → 既に公開`);
        history.delete(id);
        saveHistory(history);
        emitState();
        skipCount++;
      } else if (r.ok) {
        emit("success", `  ✓ 公開化完了 (previous=${r.previousStatus})`);
        history.delete(id);
        saveHistory(history);
        emitState();
        okCount++;
      } else {
        emit("error", `  ✗ 失敗: ${r.reason}`);
        failCount++;
      }
      if (i < targets.length - 1 && !abortRequested) {
        await sleep(Math.max(0, rateSeconds * 1000));
      }
    }
    const summary = `公開化 ${okCount} 件 / スキップ ${skipCount} 件 / 失敗 ${failCount} 件`;
    emit("success", `完了: ${summary}`);
    emitCompleted(
      abortRequested ? `中断されました\n${summary}` : `公開化が完了しました\n${summary}`
    );
  } catch (e) {
    emit("error", `予期しないエラー: ${String((e as Error).message || e)}`);
    emitCompleted(`エラーで停止しました: ${String((e as Error).message || e)}`);
  } finally {
    running = false;
    abortRequested = false;
    emitState();
    emitProgress(0, 0, "");
  }
}

async function exportHistoryCsv(): Promise<{ ok: boolean; reason?: string }> {
  const history = loadHistory();
  const ids = Array.from(history);
  const defaultName = `fantia-unpublished-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  const res = await dialog.showSaveDialog(controlWindow ?? undefined!, {
    title: "非公開化履歴を CSV で保存",
    defaultPath: defaultName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, reason: "canceled" };
  const lines = ["post_id,url"];
  for (const id of ids) lines.push(`${id},https://fantia.jp/posts/${id}`);
  fs.writeFileSync(res.filePath, lines.join("\n") + "\n", "utf8");
  emit("success", `履歴を保存しました: ${res.filePath} (${ids.length} 件)`);
  return { ok: true };
}

function registerIpc(): void {
  ipcMain.handle(
    "start-unpublish",
    async (_e, rateSeconds: number, adultOnly: boolean) => {
      void runUnpublishAll(rateSeconds, adultOnly);
      return { ok: true };
    }
  );
  ipcMain.handle("start-republish", async (_e, rateSeconds: number) => {
    void runRepublishFromHistory(rateSeconds);
    return { ok: true };
  });
  ipcMain.handle(
    "start-republish-all",
    async (_e, rateSeconds: number, adultOnly: boolean) => {
      void runRepublishAllClosed(rateSeconds, adultOnly);
      return { ok: true };
    }
  );
  ipcMain.handle("abort", async () => {
    if (running) abortRequested = true;
    return { ok: true };
  });
  ipcMain.handle("get-state", async () => {
    return {
      running,
      historyCount: loadHistory().size,
    };
  });
  ipcMain.handle("nav-login", async () => {
    await navToLogin();
    return { ok: true };
  });
  ipcMain.handle("clear-history", async () => {
    saveHistory(new Set());
    emitState();
    return { ok: true };
  });
  ipcMain.handle("export-history-csv", async () => {
    return await exportHistoryCsv();
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindows();
  emitState();
});

app.on("window-all-closed", () => {
  app.quit();
});
