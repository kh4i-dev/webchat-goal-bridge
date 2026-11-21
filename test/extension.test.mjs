// Test extension pure-logic — chạy: node test/extension.test.mjs  (exit 0 = PASS)
// Những hàm ở đây được extract từ extension/content.js để test được ngoài browser.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// lib.js là plain script (Chrome content script không import được ESM) → nạp bằng vm.
const LIB = fileURLToPath(new URL('../extension/lib.js', import.meta.url));
vm.runInThisContext(fs.readFileSync(LIB, 'utf8'), { filename: LIB });
const {
  budgetState,
  nextLimitUntil,
  platformOfHost,
  isReplyEcho,
  shouldSendReceipt,
  manifestVersion
} = globalThis.WGB_LIB;

let pass = true;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ', name);
  else {
    console.error('  FAIL', name, extra === undefined ? '' : '→ ' + JSON.stringify(extra));
    pass = false;
  }
}

console.log('--- platform detection ---');
check('chatgpt host', platformOfHost('chatgpt.com') === 'chatgpt');
check('gemini host', platformOfHost('gemini.google.com') === 'gemini');
check('claude host', platformOfHost('claude.ai') === 'claude');
check('subdomain chatgpt', platformOfHost('foo.chatgpt.com') === 'chatgpt');
check('domain gia mao -> unknown', platformOfHost('chatgpt.com.evil.test') === 'unknown');

console.log('--- budget state (popup badge) ---');
const b0 = budgetState({ recordFetch: 0, sends: 0 }, 40);
check('0 usage = ok', b0.level === 'ok' && b0.pct === 0 && b0.tone === 'info', b0);
const b1 = budgetState({ recordFetch: 40, sends: 0 }, 40);
check('40/40 = blocked (KHONG phai "near limit")', b1.level === 'blocked', b1);
const b2 = budgetState({ recordFetch: 37, sends: 0 }, 40);
check('37/40 (93%) = near', b2.level === 'near' && b2.tone === 'bad', b2);
const b2b = budgetState({ recordFetch: 36, sends: 0 }, 40);
check('36/40 (90%) = chua near (nguong la "> 90")', b2b.level === 'ok' && b2b.tone === 'warn', b2b);
const b3 = budgetState({ recordFetch: 32, sends: 0 }, 40);
check('32/40 (80%) = ok level, warn tone', b3.level === 'ok' && b3.tone === 'warn', b3);
const b4 = budgetState({ recordFetch: 10, sends: 40 }, 40);
check('sends 40 = blocked', b4.level === 'blocked', b4);

console.log('--- limit ladder per platform ---');
const t0 = 1_000_000_000;
const l1 = nextLimitUntil({ now: t0, hits: 1, minWaitMs: 0, currentUntil: 0, ladder: [60000, 300000] });
check('hit 1 = 60s', l1.until === t0 + 60000, l1);
const l2 = nextLimitUntil({ now: t0, hits: 2, minWaitMs: 0, currentUntil: 0, ladder: [60000, 300000] });
check('hit 2 = 300s', l2.until === t0 + 300000, l2);
const l3 = nextLimitUntil({ now: t0, hits: 2, minWaitMs: 600000, currentUntil: t0 + 900000, ladder: [60000, 300000] });
check('monotonic: khong rut ngan cooldown dang chay', l3.until === t0 + 900000, l3);
const l4 = nextLimitUntil({ now: t0, hits: 9, minWaitMs: 0, currentUntil: 0, ladder: [60000, 300000] });
check('clamp o bac cuoi ladder', l4.until === t0 + 300000, l4);

console.log('--- echo loop guard ---');
check('reply prefix bi bo qua', isReplyEcho('[wgb] Goal abc: x', '[wgb]') === true);
check('user message khong phai echo', isReplyEcho('@wgb lam viec', '[wgb]') === false);
check('reply prefix rong -> false', isReplyEcho('bat ky', '') === false);
check('task bat dau bang trigger van chay', isReplyEcho('@wgb status', '[wgb]') === false);

console.log('--- send receipt ---');
check('turn count tang = da gui', shouldSendReceipt({ before: 3, after: 4 }) === true);
check('turn count khong doi = chua gui', shouldSendReceipt({ before: 3, after: 3 }) === false);
check('turn count giam = chua gui', shouldSendReceipt({ before: 3, after: 2 }) === false);

console.log('--- version ---');
check('version tu manifest', manifestVersion({ version: '1.7.1' }) === '1.7.1');
check('manifest khong co version -> fallback', manifestVersion({}) === '0.0.0');

console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
