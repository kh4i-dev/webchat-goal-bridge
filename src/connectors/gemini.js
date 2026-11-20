// Gemini web connector — DOM-based (custom elements), selector tổng hợp từ
// auto-chat (gemini.ts) + OLmatter userscript:
//   editor:   .ql-editor / rich-textarea [contenteditable="true"]
//   send:     gem-icon-button.send-button (aria-disabled / .disabled)
//   messages: user-query / model-response > message-content .markdown
//   generating: mat-progress-spinner / mat-spinner

import { defineConnector } from './base.js';

const exprEditor = `(() => {
  const cands = [
    ...document.querySelectorAll('.ql-editor[contenteditable="true"]'),
    ...document.querySelectorAll('rich-textarea [contenteditable="true"]'),
    ...document.querySelectorAll('div[contenteditable="true"][role="textbox"]')
  ].filter((el) => el.offsetParent !== null);
  if (cands.length === 0) return { error: 'no-editor' };
  return { editor: cands[0] };
})()`;

const exprProbe = `(() => {
  const q = (s) => document.querySelector(s);
  const hasLoginLink = !!q('a[href*="ServiceLogin"], a[data-test-id="sign-in-button"]');
  const editor = !!q('.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"]');
  const bodyText = (document.body.innerText || '').slice(0, 6000);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    hasComposer: editor,
    hasLoginLink,
    loggedIn: !hasLoginLink && editor,
    rateLimited: new RegExp(${JSON.stringify(/too many requests|qu[áa] nhi[ềe]u y[êe]u c[ầa]u|请求过多|अनुरोध बहुत/i.source)}, 'i').test(bodyText)
  };
})()`;

const exprRead = `(() => {
  const blocks = Array.from(document.querySelectorAll('user-query, model-response'));
  return blocks.map((el, i) => {
    const isUser = el.tagName === 'USER-QUERY';
    const textEl = isUser ? el : (el.querySelector('message-content .markdown') || el);
    return {
      i,
      id: (isUser ? 'u' : 'a') + i + '-' + (textEl.innerText || '').length,
      role: isUser ? 'user' : 'assistant',
      text: (textEl.innerText || '').trim()
    };
  }).filter((m) => m.text.length > 0);
})()`;

const exprGenerating = `(() => {
  const spinner = !!document.querySelector('mat-progress-spinner, mat-spinner');
  const btn = document.querySelector("gem-icon-button.send-button");
  const disabled = btn && (btn.hasAttribute('aria-disabled') || btn.closest('.disabled') !== null);
  return spinner || Boolean(disabled);
})()`;

const exprUserCount = `(() => document.querySelectorAll('user-query').length)()`;

function exprSend(text) {
  return `(() => new Promise((resolve) => {
    const found = ${exprEditor};
    if (found.error) return resolve({ ok: false, stage: 'find-editor' });
    const el = found.editor;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    setTimeout(() => {
      const got = (el.innerText || '').replace(/\\s+/g, '');
      const want = ${JSON.stringify(text)}.replace(/\\s+/g, '');
      if (got !== want) return resolve({ ok: false, stage: 'fingerprint', gotLen: got.length, wantLen: want.length });
      // doi send button enabled roi click
      let tries = 0;
      const tick = () => {
        tries++;
        const btn = document.querySelector("gem-icon-button.send-button:not([aria-disabled='true'])") ||
          document.querySelector("div[data-test-id='send-button-container']:not(.disabled) gem-icon-button.send-button");
        if (btn) { btn.click(); return resolve({ ok: true, via: 'button', tries }); }
        if (tries > 20) return resolve({ ok: false, stage: 'send-button-never-enabled' });
        setTimeout(tick, 250);
      };
      tick();
    }, 150);
  }))()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default defineConnector({
  name: 'gemini',

  pickTarget(pages) {
    const app = pages.filter((t) => /gemini\.google\.com\/(app|gem)/.test(t.url || ''));
    if (app.length) return app[0];
    return pages.find((t) => (t.url || '').includes('gemini.google.com')) || null;
  },

  async waitForReady(conn, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.probe(conn);
        if (last && (last.hasComposer || last.hasLoginLink)) return last;
      } catch {
        /* dang load */
      }
      await sleep(800);
    }
    throw new Error('Gemini page chua san sang: ' + JSON.stringify(last));
  },

  probe(conn) {
    return conn.evaluate(exprProbe);
  },

  readMessages(conn) {
    return conn.evaluate(exprRead);
  },

  async isGenerating(conn) {
    return Boolean(await conn.evaluate(exprGenerating));
  },

  async userTurnCount(conn) {
    return conn.evaluate(exprUserCount);
  },

  async send(conn, text) {
    const res = await conn.evaluate(exprSend(String(text)));
    if (!res.ok) return res;
    const before = await this.userTurnCount(conn);
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      const now = await this.userTurnCount(conn);
      if (now > before) return { ok: true, submitted: 'yes', via: res.via };
    }
    return { ok: true, submitted: 'unknown', via: res.via };
  },

  async waitForReply(conn, { baselineCount = 0, timeoutMs = 180000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;
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
      if (onTick) onTick({ generating, assistants: assistants.length });
      await sleep(1800);
    }
    throw new Error('Het cho reply Gemini (timeout ' + timeoutMs + 'ms)');
  },

  async lastUserStartsWith(conn, prefix) {
    const msgs = await this.readMessages(conn);
    const users = msgs.filter((m) => m.role === 'user');
    return users.length > 0 && users[users.length - 1].text.startsWith(prefix);
  }
});
