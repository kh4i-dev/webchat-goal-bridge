// Gemini (web chat) ↔ Agent CDP Bridge — bản tái sử dụng, không cần dependency.
//
// Vòng lặp:
//   tin nhắn MỚI của user trong tab chat (Gemini)  -> <inbox>/goal_<ts>.json (+ ảnh)
//   file <outbox>/reply_*.md                        -> tự gõ vào composer và gửi
//
// Chạy: node gemini_cdp_watcher.mjs [--cdp URL] [--url-pattern REGEX]
//        [--inbox DIR] [--outbox DIR] [--poll-ms N] [--state FILE]
// Yêu cầu: Brave/Chrome khởi động với --remote-debugging-port=9222 (xem start_brave_cdp.bat)
// Node >= 22 (dùng WebSocket toàn cục, không cần cài package).
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ---------- CLI args ----------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
function flag(name) {
  return argv.includes(name);
}

const CDP = arg("--cdp", "http://127.0.0.1:9222");
const URL_PATTERN = new RegExp(arg("--url-pattern", "gemini\\.google\\.com/app"));
const BASE = arg("--base", path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "state"));
const INBOX = arg("--inbox", path.join(BASE, "inbox"));
const OUTBOX = arg("--outbox", path.join(BASE, "outbox"));
const DEBUG = path.join(BASE, "debug");
const POLL_MS = Number(arg("--poll-ms", "4000"));
const STATE_FILE = arg("--state", path.join(BASE, "state.json"));
if (flag("--help") || flag("-h")) {
  console.log(`Gemini CDP Bridge watcher
  --cdp URL            CDP endpoint (mặc định http://127.0.0.1:9222)
  --url-pattern REGEX  regex khớp URL tab cần theo dõi (mặc định gemini\\.google\\.com/app)
  --inbox DIR          thư mục nhận goal (mặc định <script>/state/inbox)
  --outbox DIR         thư mục reply cần gửi (mặc định <script>/state/outbox)
  --poll-ms N          chu kỳ quét (mặc định 4000)
  --state FILE         file lưu trạng thái chống echo`);
  process.exit(0);
}
for (const d of [INBOX, OUTBOX, DEBUG]) fs.mkdirSync(d, { recursive: true });

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function http(p) {
  const res = await fetch(CDP + p);
  return res.json();
}

// ---------- CDP WebSocket (rpc tường minh, tránh proxy 2 cấp) ----------
let ws = null;
let wsId = 0;
let wsPending = new Map();

function makeRpc(wsRef) {
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++wsId;
    wsPending.set(id, { resolve, reject });
    try {
      wsRef.ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      wsPending.delete(id);
      return reject(e);
    }
    setTimeout(() => {
      if (wsPending.has(id)) { wsPending.delete(id); reject(new Error("cdp timeout: " + method)); }
    }, 30000);
  });
}

async function attach(wsUrl) {
  if (ws) { try { ws.close(); } catch {} }
  const wsRef = { ws: null };
  ws = new WebSocket(wsUrl);
  wsRef.ws = ws;
  wsPending = new Map();
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && wsPending.has(msg.id)) {
      const { resolve, reject } = wsPending.get(msg.id);
      wsPending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  return makeRpc(wsRef);
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const r = await cdp("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error("page exception: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result.value;
}

// ---------- JS chạy trong trang chat ----------
const EXTRACT_JS = `(() => {
  const users = [...document.querySelectorAll('user-query, .user-query-container, [data-test-id="user-query"]')];
  const models = [...document.querySelectorAll('model-response, .model-response-container, [data-test-id="model-response"]')];
  const lastUserEl = users[users.length - 1] || null;
  const lastUser = lastUserEl ? lastUserEl.innerText.trim().slice(0, 8000) : null;
  const imgs = lastUserEl
    ? [...lastUserEl.querySelectorAll('img')].map(i => i.src).filter(s => s && !s.startsWith('data:image/svg')).slice(0, 3)
    : [];
  const lastModelEl = models[models.length - 1] || null;
  const lastModel = lastModelEl ? lastModelEl.innerText.trim().slice(0, 3000) : null;
  return JSON.stringify({ lastUser, lastModel, imgs, userCount: users.length, modelCount: models.length });
})()`;

const FETCH_IMG_JS = (src) => `(async () => {
  try {
    const r = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
    const b = await r.blob();
    const buf = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    return JSON.stringify({ ok: true, dataUrl: buf });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e).slice(0, 150) });
  }
})()`;

const SEND_JS = (text) => `(async () => {
  const editor = document.querySelector('rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]')
    || document.querySelector('textarea[aria-label]');
  if (!editor) return JSON.stringify({ ok: false, reason: 'composer_not_found' });
  editor.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(text)});
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('button')].find(b => {
    const a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('mattooltip') || '');
    return /send|g[ửu]i/i.test(a) && !b.disabled;
  }) || document.querySelector('button.send-button, [data-test-id="send-button"]');
  if (!btn) return JSON.stringify({ ok: false, reason: 'send_button_not_found' });
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  return JSON.stringify({ ok: true });
})()`;

// ---------- Trạng thái chống echo ----------
let lastUserHash = null;
let sentPrefixes = [];
let lastSendTs = 0;
if (fs.existsSync(STATE_FILE)) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    lastUserHash = s.lastUserHash ?? null;
    sentPrefixes = s.sentPrefixes ?? [];
    lastSendTs = s.lastSendTs ?? 0;
  } catch {}
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUserHash, sentPrefixes, lastSendTs }));
}
function lightHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(16);
}

async function findTargetTab() {
  const tabs = await http("/json");
  return tabs.find(t => t.type === "page" && URL_PATTERN.test(t.url)) || null;
}

async function handleOutbox(cdp) {
  const files = fs.readdirSync(OUTBOX).filter(f => f.endsWith(".md")).sort();
  for (const f of files.slice(0, 3)) {
    const full = path.join(OUTBOX, f);
    const text = fs.readFileSync(full, "utf8").slice(0, 24000);
    if (!text.trim()) { fs.renameSync(full, full + ".empty"); continue; }
    try {
      const r = JSON.parse(await evaluate(cdp, SEND_JS(text), true));
      if (r.ok) {
        fs.renameSync(full, full + ".sent");
        lastSendTs = Date.now();
        // chống echo-loop: ghi nhớ prefix reply vừa gửi để bỏ qua khi tự thấy nó
        sentPrefixes.push(text.replace(/\s+/g, " ").slice(0, 60));
        if (sentPrefixes.length > 10) sentPrefixes.shift();
        saveState();
        log("reply sent:", f);
      } else {
        log("send failed:", f, r.reason);
        fs.renameSync(full, full + ".failed-" + r.reason);
      }
    } catch (e) {
      log("send error:", f, e.message);
      fs.renameSync(full, full + ".failed-exception");
    }
    await sleep(1500);
  }
}

async function tick() {
  const tab = await findTargetTab();
  if (!tab) { log("không thấy tab khớp --url-pattern"); return; }
  const cdp = await attach(tab.webSocketDebuggerUrl);
  try {
    const data = JSON.parse(await evaluate(cdp, EXTRACT_JS));
    if (data.userCount === 0) {
      // DOM lạ — dump để tinh chỉnh selector
      const html = await evaluate(cdp, "document.body.innerHTML.slice(0, 60000)");
      fs.writeFileSync(path.join(DEBUG, "dom_snapshot.txt"), html);
      log("DOM pattern lạ — dump xong, xem debug/dom_snapshot.txt");
    }
    if (data.lastUser) {
      const h = lightHash(data.lastUser);
      const flattened = data.lastUser.replace(/\s+/g, " ");
      const isEcho = sentPrefixes.some(p => flattened.includes(p))
        || (Date.now() - lastSendTs < 30000 && lastUserHash === h);
      if (h !== lastUserHash && !seenGoals.has(h)) {
        seenGoals.add(h);
        if (isEcho) {
          lastUserHash = h;
          saveState();
          log("bỏ qua echo của reply đã gửi (" + h + ")");
        } else {
          const isNew = lastUserHash !== null; // lần đầu chạy: chỉ ghi nhớ
          lastUserHash = h;
          saveState();
          if (isNew) {
            const ts = Date.now();
            const goal = {
              id: "goal_" + ts, ts: new Date().toISOString(), source: "webchat",
              text: data.lastUser, images: [], tab_url: tab.url,
            };
            for (const [i, src] of (data.imgs || []).entries()) {
              try {
                const r = JSON.parse(await evaluate(cdp, FETCH_IMG_JS(src), true));
                if (r.ok && r.dataUrl.startsWith("data:image")) {
                  const ext = r.dataUrl.slice(11, r.dataUrl.indexOf(";")) || "png";
                  const p = path.join(INBOX, goal.id + "_img" + i + "." + ext);
                  fs.writeFileSync(p, Buffer.from(r.dataUrl.split(",")[1], "base64"));
                  goal.images.push(p);
                } else {
                  goal.images.push("URL_UNFETCHED:" + src.slice(0, 120));
                }
              } catch {
                goal.images.push("URL_FETCH_ERROR:" + src.slice(0, 120));
              }
            }
            fs.writeFileSync(path.join(INBOX, goal.id + ".json"), JSON.stringify(goal, null, 2));
            log("GOAL MỚI:", goal.id, "|", data.lastUser.slice(0, 80).replace(/\n/g, " "), "| imgs:", goal.images.length);
          }
        }
      }
    }
    await handleOutbox(cdp);
  } catch (e) {
    log("tick error:", e.message.slice(0, 200));
  }
}

const seenGoals = new Set();
log("Webchat CDP watcher khởi động — poll mỗi", POLL_MS, "ms");
log("cdp:", CDP, "| pattern:", URL_PATTERN);
log("inbox:", INBOX);
log("outbox:", OUTBOX);
while (true) {
  try { await tick(); } catch (e) { log("loop error:", e.message.slice(0, 200)); }
  await sleep(POLL_MS);
}
