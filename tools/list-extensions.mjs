// Liệt kê extension đang chạy trong Brave (qua CDP service worker targets)
import { listTargets, attach } from '../src/cdp/client.js';

const targets = await listTargets(9222);
const sws = targets.filter((t) => t.type === 'service_worker' || t.type === 'background_page');
for (const t of sws) {
  try {
    const c = await attach(t);
    const info = await c.evaluate(
      `(() => { try { const m = chrome.runtime.getManifest(); return m.name + ' v' + m.version; } catch (e) { return 'err: ' + e.message; } })()`
    );
    console.log(t.url.slice(0, 60), '=>', info);
    c.close();
  } catch (err) {
    console.log(t.url.slice(0, 60), '=> attach/eval fail:', String(err).slice(0, 80));
  }
}
