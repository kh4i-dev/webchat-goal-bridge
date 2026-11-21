// Chẩn đoán nhanh tab Gemini: node tools/probe-gemini.mjs [urlSubstr]
import { findPageTargets, attach, activateTarget } from '../src/cdp/client.js';

const substr = process.argv[2] || 'gemini.google.com';
const pages = await findPageTargets(9222, substr);
if (!pages.length) {
  console.error('khong thay tab:', substr);
  process.exit(1);
}
const t = pages[0];
await activateTarget(9222, t.id);
const c = await attach(t);
const info = await c.evaluate(`(() => {
  const users = [...document.querySelectorAll('user-query')];
  const models = [...document.querySelectorAll('model-response')];
  const spin = !!document.querySelector('mat-progress-spinner, mat-spinner');
  const lastUser = users.length ? (users[users.length - 1].innerText || '').trim().slice(0, 200) : null;
  const lastModel = models.length ? ((models[models.length - 1].querySelector('message-content .markdown') || models[models.length - 1]).innerText || '').trim().slice(0, 300) : null;
  const altUser = [...document.querySelectorAll('[data-test-id="user-query"], .user-query-container')].length;
  const altModel = [...document.querySelectorAll('[data-test-id="model-response"], .model-response-container')].length;
  const bodyHasPong = /PONG/i.test(document.body.innerText || '');
  return { url: location.href, title: document.title, users: users.length, models: models.length, altUser, altModel, spin, lastUser, lastModel, bodyHasPong };
})()`);
console.log(JSON.stringify(info, null, 2));
c.close();
