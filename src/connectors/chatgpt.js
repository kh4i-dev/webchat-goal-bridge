// ChatGPT web connector — v2, cơ chế tổng hợp từ prior art (đã đọc code):
//  * "Record là nguồn sự thật, DOM chỉ là bàn phím" (chatgpt-use): turn xong khi
//    record /backend-api/conversation/<id> có assistant mới nhất end_turn === true.
//  * Composer: KHÔNG bao giờ innerHTML; focus + selectAll + execCommand('insertText')
//    từng khúc ≤1500 ký tự (chatgpt-use fill_composer); fingerprint trước khi submit.
//  * Receipt khi gửi: số user-turn TĂNG (không tin "composer rỗng").
//  * Rate-limit: regex đa ngôn ngữ (chatgpt-use js_rate_limit_re).
//  * Fallback DOM khi chưa có conversation id: stop-button + text ổn định.

import { defineConnector } from './base.js';

const RATE_LIMIT_RE =
  /too many requests|requests too quickly|whoa,?\s+(that|this).+fast|qu[áa] nhi[ềe]u y[êe]u c[ầa]u|请求过于频繁|请求太多了|हाल में बहुत अधिक|a temporary limit is preventing|gi[ớo]i h[ạa]n t[ạa]m th[ời]/i;

// Composer ladder 5 lớp — bê nguyên từ chatgpt-use/src/channel.rs (mới nhất).
const COMPOSER_SELECTOR =
  '#prompt-textarea, [data-testid="prompt-textarea"], ' +
  '[contenteditable="true"][data-lexical-editor="true"], ' +
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
  'form [data-composer-markdown][contenteditable="true"][role="textbox"]';

const EDITOR = `(() => {
  const cands = [...document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)})];
  const vis = cands.filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height >= 8);
  if (vis.length === 0) return { error: 'no-editor', n: cands.length };
  const score = (el) =>
    (el.id === 'prompt-textarea' ? 4 : 0) +
    (el.closest('form[data-chatgpt-composer]') ? 2 : 0) +
    (el.getAttribute('data-placeholder') ? 1 : 0);
  vis.sort((a, b) => score(b) - score(a));
  const top = vis[0];
  const ties = vis.filter((el) => score(el) === score(top)).length;
  if (ties > 1) return { error: 'ambiguous-editors', n: ties, score: score(top) };
  return { editor: top, kind: top.id === 'prompt-textarea' ? 'prosemirror' : 'rich', score: score(top) };
})()`;

const exprProbe = `(() => {
  const q = (s) => document.querySelector(s);
  const hasLoginLink = !!q('a[href*="/auth/login"]') || !!q('[data-testid="login-button"]') || !!q('[data-testid="signup-button"]');
  const hasComposer = !!q(${JSON.stringify(COMPOSER_SELECTOR)});
  const bodyText = (document.body.innerText || '').slice(0, 6000);
  return {
    url: location.href,
    convId: (location.pathname.match(/\\/c\\/([0-9a-f-]{36})/) || [])[1] || null,
    title: document.title,
    readyState: document.readyState,
    hasComposer,
    hasLoginLink,
    loggedIn: !hasLoginLink,
    rateLimited: new RegExp(${JSON.stringify(RATE_LIMIT_RE.source)}, 'i').test(bodyText)
  };
})()`;
const exprProbeFinal = exprProbe;

const exprRead = `(() => {
  const els = Array.from(document.querySelectorAll('[data-message-author-role]'));
  return els.map((el, i) => ({
    i,
    id: el.getAttribute('data-message-id') || ('idx-' + i),
    role: el.getAttribute('data-message-author-role'),
    text: (el.innerText || '').trim()
  })).filter((m) => m.text.length > 0);
})()`;

const exprGenerating = `(() =>
  !!document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"]')
)()`;

const exprConvId = `(() => (location.pathname.match(/\\/c\\/([0-9a-f-]{36})/) || [])[1] || null)()`;

const exprUserCount = `(() => document.querySelectorAll('[data-message-author-role="user"]').length)()`;

/** Danh sach messages tu RECORD (UI moi 2026 khong con data-message-author-role). */
function exprRecordMessages(convId) {
  return `(async () => {
    let tok = window.__wgbTok;
    if (!tok || Date.now() - tok.ts > 5 * 60 * 1000) {
      const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
      if (!s || !s.accessToken) return { auth: false };
      tok = window.__wgbTok = { v: s.accessToken, ts: Date.now() };
    }
    const rec = await fetch('/backend-api/conversation/${convId}', {
      headers: { Authorization: 'Bearer ' + tok.v }
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!rec || !rec.mapping) return { auth: true, rec: false };
    const mapping = rec.mapping;
    let node = mapping[rec.current_node];
    const chain = [];
    while (node) { chain.unshift(node); node = mapping[node.parent]; }
    const msgs = [];
    for (const n of chain) {
      const m = n.message;
      if (!m || !m.author || !m.content || !m.content.parts) continue;
      const role = m.author.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_user) continue;
      const text = (m.content.parts || []).filter((p) => typeof p === 'string').join('\\n').trim();
      if (!text) continue;
      msgs.push({
        id: m.id || (role + '-' + (m.create_time || 0) + '-' + text.slice(0, 24)),
        role,
        text,
        t: m.create_time || 0,
        endTurn: role === 'assistant' ? m.end_turn : undefined
      });
    }
    return { auth: true, rec: true, msgs };
  })()`;
}

/** Dinh kem anh: base64 -> atob -> Blob -> DataTransfer -> input[type=file] + change event.
 * KHONG dung fetch(data:) — CSP cua ChatGPT chan connect-src data:. */
const exprAttach = (entries) => `(async () => {
  const dt = new DataTransfer();
  for (const [i, e] of ${JSON.stringify(entries)}.entries()) {
    const bin = atob(e.b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    const blob = new Blob([bytes], { type: e.mime || 'image/png' });
    dt.items.add(new File([blob], e.name || ('attach-' + (i + 1) + '.png'), { type: blob.type }));
  }
  const input = document.querySelector('form input[type="file"]');
  if (!input) return { ok: false, stage: 'no-file-input' };
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, n: dt.files.length };
})()`;

function exprFill(text) {
  // Chunked insertText ≤1500 chars + fingerprint verify (chatgpt-use check_fingerprint).
  const chunks = [];
  for (let i = 0; i < text.length; i += 1500) chunks.push(text.slice(i, i + 1500));
  return `(() => new Promise((resolve) => {
    const found = ${EDITOR};
    if (found.error) return resolve({ ok: false, stage: 'find-editor', ...found });
    const el = found.editor;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
    const chunks = ${JSON.stringify(chunks)};
    (async () => {
      for (const c of chunks) {
        document.execCommand('insertText', false, c);
        await new Promise((r) => setTimeout(r, 30));
      }
      const got = (el.innerText || el.textContent || '').replace(/\\s+/g, '');
      const want = ${JSON.stringify(text)}.replace(/\\s+/g, '');
      if (got !== want) return resolve({ ok: false, stage: 'fingerprint', gotLen: got.length, wantLen: want.length });
      resolve({ ok: true, stage: 'filled', kind: found.kind, len: got.length });
    })();
  }))()`;
}

const exprSubmit = `(() => new Promise((resolve) => {
  const editor = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
  // 1) form chua composer: requestSubmit / nut submit — tin cay nhat, khong phu thuoc testid
  const form = editor ? editor.closest('form') : null;
  if (form) {
    const sub = form.querySelector('button[type="submit"]');
    if (sub && !sub.disabled) { sub.click(); return resolve({ via: 'form-submit-btn' }); }
    try { form.requestSubmit(); return resolve({ via: 'requestSubmit' }); } catch (e) { /* tiep tuc */ }
  }
  // 2) button co nhan send da ngon ngu (UI moi bo data-testid; tieng Viet: "Gui")
  const btn = [...document.querySelectorAll('button')].find((b) => {
    if (b.disabled) return false;
    const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase();
    return /(send|g[uiử]|submit|dispatch)/i.test(label) && b.offsetParent !== null;
  });
  if (btn) { btn.click(); return resolve({ via: 'aria-send-btn' }); }
  // 3) Enter synthetic (mot so UI chap nhan)
  if (editor) {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    editor.dispatchEvent(ev);
    return resolve({ via: 'enter' });
  }
  resolve({ via: 'none' });
}))()`;

function exprServerFinal(convId) {
  // Port rút gọn từ chatgpt-use js_server_final: record là sự thật.
  return `(async () => {
    let tok = window.__wgbTok;
    if (!tok || Date.now() - tok.ts > 5 * 60 * 1000) {
      const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
      if (!s || !s.accessToken) return { auth: false };
      tok = window.__wgbTok = { v: s.accessToken, ts: Date.now() };
    }
    const rec = await fetch('/backend-api/conversation/${convId}', {
      headers: { Authorization: 'Bearer ' + tok.v }
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!rec || !rec.mapping) return { auth: true, rec: false };
    const mapping = rec.mapping;
    let node = mapping[rec.current_node];
    const chain = [];
    while (node) { chain.unshift(node); node = mapping[node.parent]; }
    let last = null;
    for (const n of chain) { if (n.message && n.message.author) last = n.message; }
    let lastAssistant = null;
    for (const n of chain) {
      const m = n.message;
      if (m && m.author && m.author.role === 'assistant' && m.content && m.content.parts) lastAssistant = m;
    }
    if (!lastAssistant) return { auth: true, rec: true, done: false, lastRole: last ? last.author.role : null };
    const text = (lastAssistant.content.parts || []).filter((p) => typeof p === 'string').join('\\n').trim();
    const finish = (lastAssistant.metadata && lastAssistant.metadata.finish_details && lastAssistant.metadata.finish_details.type) || null;
    return {
      auth: true,
      rec: true,
      done: lastAssistant.end_turn === true,
      finish,
      text,
      lastRole: last ? last.author.role : null
    };
  })()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default defineConnector({
  name: 'chatgpt',

  pickTarget(pages) {
    const conv = pages.filter((t) => /chatgpt\.com\/(c\/|g\/|gpts)/.test(t.url || ''));
    if (conv.length) return conv[0];
    const any = pages.filter((t) => (t.url || '').includes('chatgpt.com'));
    return any[0] || null;
  },

  async waitForReady(conn, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.probe(conn);
        if (last && (last.hasComposer || last.hasLoginLink)) return last;
      } catch {
        /* page van dang load */
      }
      await sleep(800);
    }
    throw new Error('ChatGPT page chua san sang: ' + JSON.stringify(last));
  },

  probe(conn) {
    return conn.evaluate(exprProbeFinal);
  },

  /** Record-first: UI moi 2026 mat data-message-author-role nen DOM chi la fallback. */
  async readMessages(conn) {
    const convId = await this.convId(conn);
    if (convId) {
      try {
        const st = await conn.evaluate(exprRecordMessages(convId));
        if (st && st.rec) return st.msgs;
      } catch { /* roi xuong DOM */ }
    }
    return conn.evaluate(exprRead);
  },

  async isGenerating(conn) {
    const convId = await this.convId(conn);
    if (convId) {
      try {
        const st = await conn.evaluate(exprServerFinal(convId));
        if (st && st.rec) return Boolean(!st.done && st.lastRole === 'assistant');
      } catch { /* roi xuong DOM */ }
    }
    return Boolean(await conn.evaluate(exprGenerating));
  },

  async convId(conn) {
    return conn.evaluate(exprConvId);
  },

  /** Receipt: so user-turn (record neu co, DOM fallback). */
  async userTurnCount(conn) {
    const msgs = await this.readMessages(conn);
    return msgs.filter((m) => m.role === 'user').length;
  },

  /**
   * Send: fill (fingerprint) -> submit -> xac nhan bang user-turn count.
   * submitted: 'yes' | 'unknown' (khong bao gio tu dong gui lai khi unknown).
   */
  async send(conn, text, { images } = {}) {
    if (images && images.length) {
      const att = await conn.evaluate(exprAttach(images));
      if (!att.ok) return { ok: false, stage: 'attach:' + att.stage, detail: att };
      await sleep(1500); // cho preview anh render truoc khi fill text
    }
    const filled = await conn.evaluate(exprFill(String(text)));
    if (!filled.ok) return { ok: false, stage: filled.stage, detail: filled };
    const before = await this.userTurnCount(conn);
    const via = await conn.evaluate(exprSubmit);
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const now = await this.userTurnCount(conn);
      if (now > before) {
        return { ok: true, submitted: 'yes', via: via.via, convId: await this.convId(conn) };
      }
      if (i === 3 && via.via !== 'enter') {
        // mot nha Enter khi receipt chua xac nhan
        await conn.evaluate(exprSubmit);
      }
    }
    return { ok: true, submitted: 'unknown', via: via.via, convId: await this.convId(conn) };
  },

  /** Cho turn xong: uu tien record API; fallback DOM stable-window. */
  async waitForReply(conn, { baselineCount = 0, timeoutMs = 180000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;

    // 1) cho convId xuat hien (chat moi pushState sau khi gui) toi da 12s
    let convId = await this.convId(conn);
    const convDeadline = Date.now() + 12000;
    while (!convId && Date.now() < convDeadline) {
      await sleep(1200);
      convId = await this.convId(conn);
    }

    if (convId) {
      while (Date.now() < deadline) {
        let st;
        try {
          st = await conn.evaluate(exprServerFinal(convId));
        } catch (err) {
          st = { rec: false, error: err.message };
        }
        if (st && st.auth === false) break; // khong lay duoc token -> fallback DOM
        if (st && st.rec && st.done && st.lastRole === 'assistant' && st.text) {
          if (st.finish === 'interrupted') logNote('turn bi interrupted (nguoi dung stop?)');
          return [{ id: 'record-' + convId, role: 'assistant', text: st.text, via: 'record', finish: st.finish }];
        }
        if (onTick) onTick(st);
        await sleep(2000);
      }
      throw new Error('Het cho reply (record timeout ' + timeoutMs + 'ms)');
    }

    // 2) DOM fallback: stop-button + text on dinh
    let sawGenerating = false;
    let lastText = '';
    let stable = 0;
    while (Date.now() < deadline) {
      const messages = await this.readMessages(conn);
      const assistants = messages.filter((m) => m.role === 'assistant');
      const generating = await this.isGenerating(conn);
      if (generating) sawGenerating = true;
      const newText = assistants.length ? assistants[assistants.length - 1].text : '';
      const grew = assistants.length > baselineCount;
      if (grew && !generating) {
        if (newText === lastText) {
          stable++;
          if (stable >= 2 && (sawGenerating || stable >= 3)) return assistants.slice(baselineCount);
        } else {
          stable = 0;
        }
      }
      lastText = newText;
      if (onTick) onTick({ generating, assistants: assistants.length, mode: 'dom' });
      await sleep(1600);
    }
    throw new Error('Het cho reply (DOM timeout ' + timeoutMs + 'ms)');
  },

  /** Kiem tra tin user cuoi co bat dau bang prefix khong (xac nhan da truyen ket qua). */
  async lastUserStartsWith(conn, prefix) {
    const msgs = await this.readMessages(conn);
    const users = msgs.filter((m) => m.role === 'user');
    return users.length > 0 && users[users.length - 1].text.startsWith(prefix);
  }
});

function logNote(msg) {
  // nho, khong phu thuoc vong: in ra stderr
  console.error('[chatgpt-connector] ' + msg);
}
