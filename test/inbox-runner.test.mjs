// Test inbox runner (file protocol): goal JSON -> outbox reply -> resolve.
// Chay: node test/inbox-runner.test.mjs   (exit 0 = PASS)
import { runTask } from '../src/runners/index.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = { runner: { type: 'inbox', timeoutMs: 20000, inbox: 'data/inbox', outbox: 'data/outbox' } };
const log = (tag, ...a) => console.error(`[${tag}]`, ...a);

const p = runTask('test inbox protocol — goal tu wgb', cfg, log);

// Gia lap agent: sau 2.5s viet reply vao outbox (ten bat ky, dung giao thuc reply_*.md)
setTimeout(() => {
  const outbox = path.resolve('data/outbox');
  fs.writeFileSync(
    path.join(outbox, 'reply_test_agent.md'),
    'Reply tu agent gia lap: da nhan goal, lam xong, day la bang chung nghiem thu.'
  );
}, 2500);

const r = await p;
console.log('INBOX RUNNER RESULT:', JSON.stringify(r, null, 2));
const pass = r.text.includes('gia lap') && r.via.startsWith('inbox:');
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
