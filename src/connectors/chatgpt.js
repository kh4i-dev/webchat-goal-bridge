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
  /too many requests|requests too quickly|whoa,?\s+(that|this).+fast|qu[áa] nhi[ềe]u y[êe]u c[ầa]u|请求过于频繁|请求太多了|हाल में बहुत अधिक/i;

// Composer ladder 5 lớp — bê nguyên từ chatgpt-use/src/channel.rs (mới nhất).
const COMPOSER_SELECTOR =
  '#prompt-textarea, [data-testid="prompt-textarea"], ' +
  '[contenteditable="true"][data-lexical-editor="true"], ' +
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], ' +
  'form [data-composer-markdown][contenteditable="true"][role="textbox"]';

const EDITOR = `(() => {
  const cands = [...document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)})]
    .filter((el) => el.offsetParent !== null || el.isContentEditable);
  if (cands.length !== 1) return { error: cands.length === 0 ? 'no-editor' : 'ambiguous-editors', n: cands.length };
  return { editor: cands[0], kind: cands[0].id === 'prompt-textarea' ? 'prosemirror' : 'rich' };
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
  const btn = document.querySelector('button[data-testid="send-button"]')
    || document.querySelector('button[data-testid="fruitjuice-send-button"]')
    || document.querySelector('form[data-chatgpt-composer] button[data-testid*="send"]');
  if (btn && !btn.disabled) { btn.click(); return resolve({ via: 'button' }); }
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
  const el = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
  if (!el) return resolve({ via: 'none' });
  el.dispatchEvent(ev);
  resolve({ via: 'enter' });
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

  readMessages(conn) {
    return conn.evaluate(exprRead);
  },

  async isGenerating(conn) {
    return Boolean(await conn.evaluate(exprGenerating));
  },

  async convId(conn) {
    return conn.evaluate(exprConvId);
  },

  /** Receipt: so user-turn DOM tang len. */
  async userTurnCount(conn) {
    return conn.evaluate(exprUserCount);
  },

  /**
   * Send: fill (fingerprint) -> submit -> xac nhan bang user-turn count.
   * submitted: 'yes' | 'unknown' (khong bao gio tu dong gui lai khi unknown).
   */
  async send(conn, text) {
    const filled = await conn.evaluate(exprFill(String(text)));
    if (!filled.ok) return { ok: false, stage: filled.stage, detail: filled };
    const before = await this.userTurnCount(conn);
    const via = await conn.evaluate(exprSubmit);
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const now = await this.userTurnCount(conn);
      if (now > before) {
        return { ok: true, submitted: 'yes', via: via.via, convId: await this.convId(conn) };
      }
      if (i === 2 && via.via === 'button') {
        // them mot nha Enter fallback
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
