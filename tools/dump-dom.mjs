// One-off DOM diagnostic for a platform tab: node tools/dump-dom.mjs [urlSubstr]
import { findPageTargets, attach, activateTarget } from '../src/cdp/client.js';

const substr = process.argv[2] || 'chatgpt.com';
const pages = await findPageTargets(9222, substr);
if (!pages.length) {
  console.error('khong thay tab:', substr);
  process.exit(1);
}
const t = pages[0];
await activateTarget(9222, t.id);
const c = await attach(t);
const info = await c.evaluate(`(() => {
  const ces = [...document.querySelectorAll('[contenteditable="true"]')].map((el) => ({
    tag: el.tagName, id: el.id, testid: el.getAttribute('data-testid'),
    role: el.getAttribute('role'), visible: el.offsetParent !== null,
    cls: String(el.className || '').slice(0, 80),
    ph: el.getAttribute('data-placeholder') || el.dataset?.placeholder || null
  }));
  const tas = [...document.querySelectorAll('textarea')].map((el) => ({
    id: el.id, testid: el.getAttribute('data-testid'), ph: el.placeholder,
    visible: el.offsetParent !== null, cls: String(el.className || '').slice(0, 80)
  }));
  const boxes = [...document.querySelectorAll('[role="textbox"]')].map((el) => ({
    tag: el.tagName, id: el.id, testid: el.getAttribute('data-testid'),
    visible: el.offsetParent !== null, cls: String(el.className || '').slice(0, 60)
  }));
  const btnTestids = [...new Set([...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')))].slice(0, 80);
  const msgRoles = [...new Set([...document.querySelectorAll('[data-message-author-role]')].map((el) => el.getAttribute('data-message-author-role')))];
  const sendish = [...document.querySelectorAll('button')].filter((b) => /send|submit/i.test(b.getAttribute('aria-label') || '') || /send/.test(b.getAttribute('data-testid') || '')).map((b) => ({ testid: b.getAttribute('data-testid'), aria: b.getAttribute('aria-label'), disabled: b.disabled }));
  return { url: location.href, ces, tas, boxes, btnTestids, msgRoles, sendish };
})()`);
console.log(JSON.stringify(info, null, 2));
c.close();
