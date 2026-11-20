// wgb-companion content script — chat web là NÃO chỉ đạo, agent local là TAY CHÂN.
// Vòng: thấy tin user moi bat dau bang trigger (@wgb) -> POST /dispatch ->
//       poll GET /goals/<id> -> done -> dien "[wgb] ..." vao composer + Send -> NAO duyet.
// Selector: chuan hoa tu wgb connectors (da thu that tren UI 2026) + gemini_cdp_watcher.

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8787',
  trigger: '@wgb',
  replyPrefix: '[wgb]',
  autoSend: true,
  pollMs: 3000,
  goalTimeoutMs: 900000,
  enabled: true
};

const S = { ...DEFAULTS, lastHash: null, busyGoalId: null, lastSendTs: 0, firstPass: true };
chrome.storage.sync.get(DEFAULTS, (s) => Object.assign(S, s));
chrome.storage.onChanged.addListener((ch) => {
  for (const [k, v] of Object.entries(ch)) S[k] = v.newValue;
});

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
async function bearer() {
  if (wgbTok && Date.now() - wgbTok.ts < 5 * 60 * 1000) return wgbTok.v;
  const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
  if (!s || !s.accessToken) return null;
  wgbTok = { v: s.accessToken, ts: Date.now() };
  return wgbTok.v;
}

async function readLastUserChatGPT() {
  const convId = (location.pathname.match(/\/c\/([0-9a-f-]{36})/) || [])[1];
  if (!convId) return null;
  const tok = await bearer();
  if (!tok) return null;
  const rec = await fetch('/backend-api/conversation/' + convId, {
    headers: { Authorization: 'Bearer ' + tok }
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!rec || !rec.mapping) return null;
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
  const els = document.querySelectorAll('[data-testid="user-message"]');
  const el = els[els.length - 1];
  return el ? (el.innerText || '').trim() || null : null;
}

function readLastUser() {
  if (PLATFORM === 'chatgpt') return readLastUserChatGPT();
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

// ---------- vong chinh ----------

function relay(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      resolve(res && res.ok ? res.data : { error: (res && (res.error || res.status)) || 'no-response' });
    });
  });
}

async function dispatchTask(task) {
  S.busyGoalId = 'pending';
  pillSet('dispatch: ' + task.slice(0, 40), true);
  const d = await relay({ path: '/dispatch', method: 'POST', body: { text: task, platform: PLATFORM, chatUrl: location.href } });
  if (!d.goalId) {
    pillSet('dispatch loi: ' + (d.error || '?'), false);
    S.busyGoalId = null;
    return;
  }
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
      S.lastHash = null; // doc lai tin moi (bao gom ket qua) o vong sau
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
  if (S.firstPass) { S.lastHash = h; S.firstPass = false; pillSet(PLATFORM + ' san sang — trigger "' + S.trigger + '"', false); return; }
  if (h === S.lastHash) return;
  S.lastHash = h;
  if (!flat.startsWith(S.trigger)) return;
  const task = flat.slice(S.trigger.length).trim();
  if (!task) return;
  dispatchTask(task);
}

pillSet(PLATFORM + ' khoi dong...', false);
setInterval(tick, 3000);
