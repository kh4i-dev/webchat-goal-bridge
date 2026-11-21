// wgb-companion v1.2 — chat web là NÃO chỉ đạo, agent local là TAY CHÂN.
//
// Chống rate-limit (429) — nguyên tắc "1 request / 1 tin nhắn":
//  * ChatGPT (UI 2026 không còn DOM role): KHÔNG poll record API. Nghe sự kiện
//    submit của form composer (MutationObserver-free, 0 request) → sau 2.5s đọc
//    record ĐÚNG 1 LẦN để lấy nội dung tin. Safety-net poll 60s/lần.
//  * Gemini + Claude: đọc DOM thuần (user-query / user-message) — 0 request.
//  * Budget ledger theo giờ (chatgpt-use: ~15 loads/40 sends): vượt ngưỡng → nghỉ.
//  * Backoff 429/limit: 60s → 120s → ... tối đa 5 phút; honor Retry-After nếu có.
//  * Dedupe nội dung (aegisloop): task trùng không chạy lại → gõ 1 lần là chạy.

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

const BUDGET = { recordFetch: 40, sends: 40 }; // mỗi giờ — chatgpt-use pace ledger

const S = { ...DEFAULTS, lastHash: null, busyGoalId: null, lastSendTs: 0, firstPass: true };
chrome.storage.sync.get(DEFAULTS, (s) => Object.assign(S, s));
chrome.storage.onChanged.addListener((ch) => {
  for (const [k, v] of Object.entries(ch)) S[k] = v.newValue;
});

// Dedupe theo nội dung (aegisloop hashPayload + executedHashes)
let doneHashes = [];
chrome.storage.local.get({ doneHashes: [] }, (s) => { doneHashes = s.doneHashes || []; });
function rememberDone(h) {
  doneHashes.push(h);
  if (doneHashes.length > 100) doneHashes.shift();
  chrome.storage.local.set({ doneHashes });
}

// Budget ledger theo giờ
let ledger = { hour: new Date().getHours(), recordFetch: 0, sends: 0 };
chrome.storage.local.get({ ledger: null }, (s) => { if (s.ledger) ledger = s.ledger; });
function rollLedger() {
  const h = new Date().getHours();
  if (ledger.hour !== h) { ledger = { hour: h, recordFetch: 0, sends: 0 }; }
}
function saveLedger() { chrome.storage.local.set({ ledger }); }
function overBudget() {
  rollLedger();
  return ledger.recordFetch >= BUDGET.recordFetch || ledger.sends >= BUDGET.sends;
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
let pendingSubmitReadAt = 0; // chatgpt: submit xong → doc record 1 lan

async function bearer() {
  if (wgbTok && Date.now() - wgbTok.ts < 5 * 60 * 1000) return wgbTok.v;
  const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
  if (!s || !s.accessToken) return null;
  wgbTok = { v: s.accessToken, ts: Date.now() };
  return wgbTok.v;
}

function backoffFromResponse(res) {
  const retryAfter = Number(res.headers.get('retry-after') || 0);
  if (retryAfter > 0) {
    rateLimitedUntil = Date.now() + Math.min(600000, retryAfter * 1000);
  } else {
    rateLimitStreak++;
    const waitMs = Math.min(300000, 60000 * rateLimitStreak);
    rateLimitedUntil = Date.now() + waitMs;
  }
  const waitSec = Math.max(0, Math.round((rateLimitedUntil - Date.now()) / 1000));
  pillSet('ChatGPT rate limit — nghi ' + waitSec + 's (tin cu khong mat)', false);
}

async function readRecordLastUser() {
  if (Date.now() < rateLimitedUntil) return null;
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
  if (!res.ok) { backoffFromResponse(res); return null; }
  const rec = await res.json().catch(() => null);
  if (!rec || !rec.mapping) return null;
  rateLimitStreak = 0; rateLimitedUntil = 0;
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

function readLastUser() {
  if (PLATFORM === 'chatgpt') {
    if (!shouldReadRecord()) return Promise.resolve(null);
    return readRecordLastUser();
  }
  if (PLATFORM === 'gemini') return Promise.resolve(readLastUserGemini());
  return Promise.resolve(readLastUserClaude());
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

  // chatgpt + claude (best-effort cho claude)
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

// ---------- pill UI ----------

let pill = null;
function pillEnsure() {
  if (pill) return pill;
  pill = document.createElement('div');
  pill.id = 'wgb-companion-pill';
  pill.style.cssText =
    'position:fixed;bottom:14px;right:14px;z-index:999999;font:12px/1.4 system-ui,sans-serif;' +
    'background:#111827;color:#e5e7eb;padding:6px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);' +
    'opacity:.88;cursor:default;max-width:340px';
  document.documentElement.appendChild(pill);
  return pill;
}
function pillSet(text, busy) {
  const p = pillEnsure();
  p.textContent = 'wgb ▸ ' + text;
  p.style.background = busy ? '#1d4ed8' : '#111827';
}

// ---------- relay ----------

function relay(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      resolve(res && res.ok ? res.data : { error: (res && (res.error || res.status)) || 'no-response' });
    });
  });
}

async function dispatchTask(task, contentHash) {
  if (doneHashes.includes(contentHash)) {
    pillSet('task nay da xu ly truoc — doi y khac', false);
    return;
  }
  if (overBudget()) {
    pillSet('vuot budget gio (' + ledger.recordFetch + ' fetch/' + ledger.sends + ' send) — nghi den gio sau', false);
    return;
  }
  S.busyGoalId = 'pending';
  pillSet('dispatch: ' + task.slice(0, 40), true);
  const d = await relay({ path: '/dispatch', method: 'POST', body: { text: task, platform: PLATFORM, chatUrl: location.href } });
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
  if (!S.enabled || S.busyGoalId) return;
  let lastUser = null;
  try { lastUser = await readLastUser(); } catch { return; }
  if (!lastUser) return;
  const flat = lastUser.replace(/\s+/g, ' ').trim();
  if (flat.startsWith(S.replyPrefix)) return;                    // echo cua chinh no
  if (Date.now() - S.lastSendTs < 20000) return;                 // cooldown
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

// ChatGPT: nghe submit cua form composer — khong ton request. Submit xong 2.5s
// thi doc record dung 1 lan de lay noi dung tin (neu la trigger thi dispatch).
document.addEventListener(
  'submit',
  (e) => {
    if (PLATFORM === 'chatgpt' && e.target && e.target.matches('form')) {
      pendingSubmitReadAt = Date.now() + 2500;
    }
  },
  true
);

pillSet(PLATFORM + ' khoi dong... (v1.2, 1 request/tin)', false);
setInterval(tick, S.pollMs);
