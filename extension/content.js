// wgb-companion v1.3 — chat web là NÃO chỉ đạo, agent local là TAY CHÂN.
//
// Chống rate-limit (429) — "1 request / 1 tin nhắn":
//  * ChatGPT: nghe submit form (0 request) → 2.5s sau đọc record 1 lần; safety-net 60s.
//  * Gemini + Claude: DOM thuần, 0 request.
//  * SHARED throttle chéo tab (storage.local): 1 tab dính limit → mọi tab cùng nghỉ
//    (tương đương machine-wide throttle file của chatgpt-use).
//  * Budget ledger theo giờ (40 fetch / 40 send) + backoff luỹ thừa + Retry-After.
//  * Dedupe nội dung (aegisloop): task trùng không chạy lại.
//
// UI: pill góc phải — click để mở panel (server, budget, rate-limit, goals gần nhất).

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8787',
  trigger: '@wgb',
  replyPrefix: '[wgb]',
  autoSend: true,
  pollMs: 3000,
  safetyPollMs: 60000,
  goalTimeoutMs: 900000,
  enabled: true
};

const BUDGET = { recordFetch: 40, sends: 40 };
const VERSION = '1.3.0';

const S = { ...DEFAULTS, lastHash: null, busyGoalId: null, lastSendTs: 0, firstPass: true, dead: false };
chrome.storage.sync.get(DEFAULTS, (s) => Object.assign(S, s));
chrome.storage.onChanged.addListener((ch) => {
  for (const [k, v] of Object.entries(ch)) if (k in S) S[k] = v.newValue;
});

let doneHashes = [];
chrome.storage.local.get({ doneHashes: [] }, (s) => { doneHashes = s.doneHashes || []; });
function rememberDone(h) {
  doneHashes.push(h);
  if (doneHashes.length > 100) doneHashes.shift();
  chrome.storage.local.set({ doneHashes });
}

let ledger = { hour: new Date().getHours(), recordFetch: 0, sends: 0 };
chrome.storage.local.get({ ledger: null }, (s) => { if (s.ledger) ledger = s.ledger; });
function rollLedger() {
  const h = new Date().getHours();
  if (ledger.hour !== h) ledger = { hour: h, recordFetch: 0, sends: 0 };
}
function saveLedger() { rollLedger(); chrome.storage.local.set({ ledger }); }
function overBudget() { rollLedger(); return ledger.recordFetch >= BUDGET.recordFetch || ledger.sends >= BUDGET.sends; }

// Shared throttle chéo tab — một tab dính limit, tất cả tab cùng nghỉ.
async function getSharedLimit() {
  const s = await chrome.storage.local.get({ sharedLimit: { until: 0, reason: '' } });
  return s.sharedLimit && s.sharedLimit.until > Date.now() ? s.sharedLimit : null;
}
async function setSharedLimit(waitMs, reason) {
  await chrome.storage.local.set({ sharedLimit: { until: Date.now() + waitMs, reason } });
  rateLimitedUntil = Date.now() + waitMs;
}
async function clearSharedLimit() {
  await chrome.storage.local.set({ sharedLimit: { until: 0, reason: '' } });
  rateLimitedUntil = 0;
  rateLimitStreak = 0;
}

// Ladder cooldown (chatgpt-use throttle.rs): hits cách nhau >1h restart ladder;
// monotonic until — hit lặp lại KHÔNG BAO GIỜ rút ngắn cooldown đang chạy.
const LADDER_MS = [60000, 300000, 900000, 1800000]; // 1p → 5p → 15p → 30p
let limitHits = null;
chrome.storage.local.get({ limitHits: null }, (s) => { limitHits = s.limitHits; });

async function noteLimitHit(minWaitMs, reason) {
  const now = Date.now();
  if (!limitHits || now - limitHits.lastHit > 3600000) limitHits = { lastHit: now, hits: 1 };
  else limitHits.hits++;
  await chrome.storage.local.set({ limitHits });
  const step = LADDER_MS[Math.min(limitHits.hits - 1, LADDER_MS.length - 1)];
  const until = Math.max(now + step, now + minWaitMs, rateLimitedUntil);
  await setSharedLimit(until - now, reason);
}

// Regex đa ngôn ngữ (chatgpt-use channel.rs:384 — tiếng Anh-only từng đọc nhầm trang
// zh-CN đang throttle là "healthy" và poll tiếp vào throttle)
const LIMIT_DIALOG_RE =
  /too many requests|requests too quickly|a temporary limit|gi[ớo]i h[ạa]n t[ạa]m th[ời]|太多请求|过于频繁|リクエストが多すぎ|요청이 너무 많|लिमिट/i;
let dialogHitNoted = 0;
function checkLimitDialog() {
  if (Date.now() - dialogHitNoted < 120000) return;
  const texts = [...document.querySelectorAll('[role="dialog"], [role="alert"], [aria-live="assertive"]')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.innerText || '')
    .join(' ');
  if (!LIMIT_DIALOG_RE.test(texts)) return;
  dialogHitNoted = Date.now();
  noteLimitHit(0, PLATFORM + ' dialog limit');
  const btn = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) =>
    /got it|ok|đóng|close|知道了|了解/i.test(b.innerText || '')
  );
  if (btn) btn.click(); // dismiss (chatgpt-use channel.rs:731)
}

// Chờ trong turn (chatgpt-use channel.rs:2770): throttle nằm ở conversations API,
// không phải generation — sau mỗi lần chờ, hỏi server xem reply xong chưa.
const IN_TURN_WAIT = [20000, 45000, 90000];
let inTurnIdx = 0;
function inTurnBackoffMs() {
  const ms = IN_TURN_WAIT[Math.min(inTurnIdx, IN_TURN_WAIT.length - 1)];
  inTurnIdx++;
  return ms;
}

const HOST = location.host;
const PLATFORM = HOST.includes('chatgpt') ? 'chatgpt' : HOST.includes('gemini') ? 'gemini' : 'claude';

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(16);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- doc tin user cuoi ----------

let wgbTok = null;
let lastRecordFetch = 0;
let rateLimitedUntil = 0;
let rateLimitStreak = 0;
let pendingSubmitReadAt = 0;

async function bearer() {
  if (wgbTok && Date.now() - wgbTok.ts < 5 * 60 * 1000) return wgbTok.v;
  const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
  if (!s || !s.accessToken) return null;
  wgbTok = { v: s.accessToken, ts: Date.now() };
  return wgbTok.v;
}

async function backoffFromResponse(res) {
  const retryAfter = Number(res.headers.get('retry-after') || 0);
  // Stated (Retry-After) luôn thắng guessed (agent-anywhere): clamp riêng 10 phút
  const statedMs = retryAfter > 0 ? Math.min(600000, retryAfter * 1000) : 0;
  await noteLimitHit(statedMs, PLATFORM + ' 429');
}

async function readRecordLastUser() {
  const shared = await getSharedLimit();
  if (shared) { rateLimitedUntil = shared.until; return null; }
  if (overBudget()) return null;
  const convId = (location.pathname.match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  if (!convId) return null;
  const tok = await bearer();
  if (!tok) return null;
  lastRecordFetch = Date.now();
  ledger.recordFetch++; saveLedger();
  let res = null;
  try {
    res = await fetch('/backend-api/conversation/' + convId, {
      headers: { Authorization: 'Bearer ' + tok }
    });
  } catch {
    return null;
  }
  if (!res.ok) { await backoffFromResponse(res); return null; }
  const rec = await res.json().catch(() => null);
  if (!rec || !rec.mapping) return null;
  if (rateLimitedUntil) await clearSharedLimit();
  let node = rec.mapping[rec.current_node];
  const chain = [];
  while (node) { chain.unshift(node); node = rec.mapping[node.parent]; }
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i].message;
    if (!m || !m.author || m.author.role !== 'user' || !m.content || !m.content.parts) continue;
    const text = (m.content.parts || []).filter((p) => typeof p === 'string').join('\n').trim();
    if (text) return text;
  }
  return null;
}

function readLastUserGemini() {
  const users = document.querySelectorAll('user-query');
  const el = users[users.length - 1];
  return el ? (el.innerText || '').trim() || null : null;
}

function readLastUserClaude() {
  const els = document.querySelectorAll('[data-testid="user-message"], .font-user-message');
  const el = els[els.length - 1];
  return el ? (el.innerText || '').trim() || null : null;
}

function shouldReadRecord() {
  if (Date.now() < rateLimitedUntil) return false;
  if (overBudget()) return false;
  if (pendingSubmitReadAt && Date.now() >= pendingSubmitReadAt) {
    pendingSubmitReadAt = 0;
    return true;
  }
  if (Date.now() - lastRecordFetch >= S.safetyPollMs) return true;
  return false;
}

async function readLastUser() {
  if (PLATFORM === 'chatgpt') {
    if (!shouldReadRecord()) return null;
    return readRecordLastUser();
  }
  if (PLATFORM === 'gemini') return readLastUserGemini();
  return readLastUserClaude();
}

// ---------- dien + gui ket qua ----------

const CHATGPT_COMPOSER =
  '#prompt-textarea, [data-testid="prompt-textarea"], ' +
  '[contenteditable="true"][data-lexical-editor="true"], ' +
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
  'form [data-composer-markdown][contenteditable="true"][role="textbox"]';

async function fillAndSend(text) {
  ledger.sends++; saveLedger();
  if (PLATFORM === 'gemini') {
    const el = document.querySelector('.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]');
    if (!el) return { ok: false, why: 'no-editor' };
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(250);
    let tries = 0;
    while (tries++ < 20) {
      const btn =
        document.querySelector("gem-icon-button.send-button:not([aria-disabled='true'])") ||
        [...document.querySelectorAll('button')].find((b) => {
          if (b.disabled) return false;
          const a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('mattooltip') || '');
          return /send|g[ửu]i/i.test(a) && b.offsetParent !== null;
        });
      if (btn) { btn.click(); return { ok: true, via: 'gemini-btn' }; }
      await sleep(250);
    }
    return { ok: false, why: 'send-button-never-enabled' };
  }

  const el =
    PLATFORM === 'chatgpt'
      ? document.querySelector(CHATGPT_COMPOSER)
      : document.querySelector('div[contenteditable="true"]');
  if (!el) return { ok: false, why: 'no-editor' };
  el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  await sleep(250);
  if (PLATFORM === 'claude') {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => /send/i.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null && !b.disabled
    );
    if (btn) { btn.click(); return { ok: true, via: 'claude-send-btn' }; }
  }
  const form = el.closest('form');
  if (form) {
    const sub = form.querySelector('button[type="submit"]');
    if (sub && !sub.disabled) { sub.click(); return { ok: true, via: 'form-submit-btn' }; }
    try { form.requestSubmit(); return { ok: true, via: 'requestSubmit' }; } catch { /* tiep */ }
  }
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return { ok: true, via: 'enter' };
}

// ---------- pill + panel UI ----------

let pill = null;
let panel = null;
let panelOpen = false;
let lastStatusText = PLATFORM + ' khoi dong...';
let lastStatusBusy = false;

function uiRoot() {
  let root = document.getElementById('wgb-companion-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'wgb-companion-root';
    root.style.cssText =
      "all:initial; position:fixed; bottom:14px; right:14px; z-index:2147483647;" +
      "font:12px/1.5 ui-monospace,'Cascadia Mono',Consolas,monospace; color:#c9d4e3;";
    document.documentElement.appendChild(root);
  }
  return root;
}

function pillEnsure() {
  const root = uiRoot();
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'wgb-companion-pill';
    pill.style.cssText =
      'display:inline-block;background:#0a0e14;color:#22d3a5;padding:5px 10px;' +
      'border:1px solid #1e2a3a;font-size:11px;letter-spacing:.5px;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.45);opacity:.94;cursor:pointer;max-width:360px;user-select:none;';
    pill.title = 'Click de mo/doi panel wgb-companion';
    pill.addEventListener('click', () => { panelOpen = !panelOpen; renderPanel(); });
    root.appendChild(pill);
  }
  return pill;
}

function bar(label, value, max, color) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const row = document.createElement('div');
  row.style.cssText = 'margin:5px 0 2px;';
  const lab = document.createElement('div');
  lab.textContent = label;
  lab.style.cssText = 'display:flex;justify-content:space-between;color:#5c7089;font-size:10.5px;';
  const val = document.createElement('span');
  val.textContent = value + '/' + max;
  lab.appendChild(val);
  const track = document.createElement('div');
  track.style.cssText = 'height:4px;background:#101827;border:1px solid #1e2a3a;margin-top:3px;';
  const fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:' + pct + '%;background:' + color + ';';
  track.appendChild(fill);
  row.appendChild(lab); row.appendChild(track);
  return row;
}

function rowLine(label, value, valueColor) {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin:2px 0;';
  const a = document.createElement('span');
  a.textContent = label; a.style.color = '#5c7089';
  const b = document.createElement('span');
  b.textContent = value; b.style.color = valueColor || '#c9d4e3';
  r.appendChild(a); r.appendChild(b);
  return r;
}

const PANEL_TAG = { done: '[OK]', failed: '[ERR]', running: '[RUN]', queued: '[QUE]' };
function goalLine(g) {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;gap:6px;padding:2px 0;border-bottom:1px dashed #1e2a3a;font-size:10.5px;';
  const st = document.createElement('span');
  st.textContent = PANEL_TAG[g.status] || '[···]';
  st.style.color = g.status === 'done' ? '#22d3a5' : g.status === 'failed' ? '#f87171' : g.status === 'running' ? '#38bdf8' : '#fbbf24';
  const id = document.createElement('span');
  id.textContent = g.id.slice(0, 10); id.style.color = '#38bdf8';
  const task = document.createElement('span');
  task.textContent = (g.task || '').slice(0, 48);
  task.style.cssText = 'color:#5c7089;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;';
  r.appendChild(st); r.appendChild(id); r.appendChild(task);
  return r;
}

async function renderPanel() {
  const root = uiRoot();
  if (panel) { panel.remove(); panel = null; }
  if (!panelOpen) return;
  panel = document.createElement('div');
  panel.id = 'wgb-companion-panel';
  panel.style.cssText =
    'background:#0f141b;color:#c9d4e3;border:1px solid #2a3a52;padding:10px 12px;' +
    'margin-bottom:8px;width:360px;box-shadow:0 6px 24px rgba(0,0,0,.6);';

  const head = document.createElement('div');
  head.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;" +
    "border-bottom:1px solid #2a3a52;padding-bottom:5px;";
  const title = document.createElement('b');
  title.textContent = 'WGB//COMPANION';
  title.style.cssText = 'color:#22d3a5;letter-spacing:1px;font-size:12px;';
  const ver = document.createElement('span');
  ver.textContent = 'v' + VERSION;
  ver.style.cssText = 'color:#5c7089;font-size:10px;';
  const close = document.createElement('span');
  close.textContent = '✕'; close.style.cssText = 'cursor:pointer;color:#5c7089;padding:2px 6px;';
  close.addEventListener('click', () => { panelOpen = false; renderPanel(); });
  head.appendChild(title); head.appendChild(ver); head.appendChild(close);
  panel.appendChild(head);

  const [status, goals, shared] = await Promise.all([
    relay({ path: '/status', method: 'GET' }),
    relay({ path: '/goals?limit=5', method: 'GET' }),
    getSharedLimit()
  ]);

  panel.appendChild(rowLine('Nền tảng', PLATFORM, '#38bdf8'));
  panel.appendChild(rowLine('Server', status.error ? 'OFFLINE (' + status.error + ')' : 'online · runner: ' + (status.data?.runner || '?'), status.error ? '#f87171' : '#22d3a5'));
  panel.appendChild(rowLine('Trigger', S.trigger));
  rollLedger();
  panel.appendChild(bar('record fetch (giờ)', ledger.recordFetch, BUDGET.recordFetch, ledger.recordFetch >= BUDGET.recordFetch ? '#f87171' : '#38bdf8'));
  panel.appendChild(bar('send (giờ)', ledger.sends, BUDGET.sends, ledger.sends >= BUDGET.sends ? '#f87171' : '#38bdf8'));
  if (shared) {
    panel.appendChild(rowLine('rate limit', 'nghỉ ' + Math.max(0, Math.round((shared.until - Date.now()) / 1000)) + 's (' + shared.reason + ')', '#fbbf24'));
  } else {
    panel.appendChild(rowLine('rate limit', 'OK', '#22d3a5'));
  }

  const gh = document.createElement('div');
  gh.textContent = '▸ GOALS GẦN NHẤT'; gh.style.cssText = 'color:#5c7089;font-size:10px;letter-spacing:2px;margin-top:8px;';
  panel.appendChild(gh);
  if (Array.isArray(goals) && goals.length) for (const g of goals) panel.appendChild(goalLine(g));
  else {
    const none = document.createElement('div');
    none.textContent = '(chưa có goal — gõ "' + S.trigger + ' <task>" trong chat)';
    none.style.color = '#5c7089';
    panel.appendChild(none);
  }

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';
  const bToggle = document.createElement('button');
  bToggle.textContent = S.enabled ? 'TẮT' : 'BẬT';
  bToggle.style.cssText = 'flex:1;padding:5px 0;font:inherit;font-size:10px;letter-spacing:1px;background:transparent;border:1px solid #2a3a52;color:#5c7089;cursor:pointer;';
  bToggle.addEventListener('click', () => { chrome.storage.sync.set({ enabled: !S.enabled }); S.enabled = !S.enabled; renderPanel(); });
  const bRefresh = document.createElement('button');
  bRefresh.textContent = 'LÀM MỚI';
  bRefresh.style.cssText = 'flex:1;padding:5px 0;font:inherit;font-size:10px;letter-spacing:1px;background:transparent;border:1px solid #22d3a5;color:#22d3a5;cursor:pointer;';
  bRefresh.addEventListener('click', () => { S.firstPass = true; S.lastHash = null; renderPanel(); });
  btnRow.appendChild(bToggle); btnRow.appendChild(bRefresh);
  panel.appendChild(btnRow);

  root.insertBefore(panel, root.firstChild);
}

// giu pill song sau SPA re-render + tao panel reload dinh ky khi mo
setInterval(() => {
  if (S.dead) return;
  if (!document.getElementById('wgb-companion-root')) { pill = null; panel = null; }
  pillEnsure();
  pill.textContent = 'wgb ▸ ' + lastStatusText;
  pill.style.background = lastStatusBusy ? '#0c2a22' : '#0a0e14';
  pill.style.borderColor = lastStatusBusy ? '#22d3a5' : '#1e2a3a';
  if (panelOpen) renderPanel();
}, 2500);

function pillSet(text, busy) {
  lastStatusText = text;
  lastStatusBusy = busy;
  pillEnsure();
  pill.textContent = 'wgb ▸ ' + text;
  pill.style.background = busy ? '#0c2a22' : '#0a0e14';
  pill.style.borderColor = busy ? '#22d3a5' : '#1e2a3a';
}

function relay(msg) {
  return new Promise((resolve) => {
    let done = false;
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        done = true;
        const err = chrome.runtime.lastError;
        if (err) { resolve({ error: 'context-invalidated' }); return; }
        resolve(res && res.ok ? res.data : { error: (res && (res.error || res.status)) || 'no-response' });
      });
    } catch (e) {
      resolve({ error: 'context-invalidated' });
      return;
    }
    setTimeout(() => { if (!done) resolve({ error: 'relay-timeout' }); }, 15000);
  });
}

async function dispatchTask(task, contentHash) {
  if (doneHashes.includes(contentHash)) {
    pillSet('task nay da xu ly truoc — doi y khac', false);
    return;
  }
  if (overBudget()) {
    pillSet('vuot budget gio (' + ledger.recordFetch + ' fetch/' + ledger.sends + ' send)', false);
    return;
  }
  S.busyGoalId = 'pending';
  pillSet('dispatch: ' + task.slice(0, 40), true);
  const d = await relay({ path: '/dispatch', method: 'POST', body: { text: task, platform: PLATFORM, chatUrl: location.href } });
  if (d.error === 'context-invalidated') {
    S.dead = true;
    pillSet('extension moi cap nhat — RELOAD trang de tiep tuc', false);
    return;
  }
  if (!d.goalId) {
    pillSet('dispatch loi: ' + (d.error || '?'), false);
    S.busyGoalId = null;
    return;
  }
  rememberDone(contentHash);
  const goalId = d.goalId;
  S.busyGoalId = goalId;
  pillSet('goal ' + goalId + ' dang chay...', true);
  const deadline = Date.now() + S.goalTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const g = await relay({ path: '/goals/' + goalId });
    if (!g || !g.status) continue;
    if (g.status === 'done' || g.status === 'failed') {
      const body = g.status === 'done'
        ? `${S.replyPrefix} Goal ${goalId}:\n${g.result || '(rong)'}`
        : `${S.replyPrefix} Goal ${goalId} LOI:\n${g.error || '?'}`;
      pillSet('goal ' + goalId + ' ' + g.status + ' — tra ket qua...', true);
      if (S.autoSend) {
        const sent = await fillAndSend(body);
        S.lastSendTs = Date.now();
        pillSet('goal ' + goalId + ' ' + g.status + (sent.ok ? ' da gui' : ' GUI LOI: ' + sent.why), false);
      } else {
        pillSet('goal ' + goalId + ' ' + g.status + ' (autoSend tat)', false);
      }
      S.busyGoalId = null;
      S.lastHash = null;
      return;
    }
  }
  pillSet('goal ' + goalId + ' timeout', false);
  S.busyGoalId = null;
}

async function tick() {
  if (!S.enabled || S.busyGoalId || S.dead) return;
  checkLimitDialog();
  let lastUser = null;
  try { lastUser = await readLastUser(); } catch { return; }
  if (!lastUser) return;
  const flat = lastUser.replace(/\s+/g, ' ').trim();
  if (flat.startsWith(S.replyPrefix)) return;
  if (Date.now() - S.lastSendTs < 20000) return;
  const h = hash(flat);
  if (S.firstPass) {
    S.firstPass = false;
    if (!flat.startsWith(S.trigger)) {
      S.lastHash = h;
      pillSet(PLATFORM + ' san sang — trigger "' + S.trigger + '" (1 request/tin)', false);
      return;
    }
  } else if (h === S.lastHash) {
    return;
  }
  S.lastHash = h;
  if (!flat.startsWith(S.trigger)) return;
  const task = flat.slice(S.trigger.length).trim();
  if (!task) return;
  dispatchTask(task, h);
}

document.addEventListener(
  'submit',
  (e) => {
    if (PLATFORM === 'chatgpt' && e.target && e.target.matches('form')) {
      pendingSubmitReadAt = Date.now() + 2500;
    }
  },
  true
);

// Visibility resurrection (OLmatter user.js:426): tab quay lại hiển thị → đọc record
// 1 lần để bắt kịp tin mới trong lúc tab bị nền (không spam: chỉ 1 request/lần kích hoạt)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && PLATFORM === 'chatgpt') lastRecordFetch = 0;
});

pillSet(PLATFORM + ' khoi dong... (v' + VERSION + ')', false);
setInterval(tick, S.pollMs);
