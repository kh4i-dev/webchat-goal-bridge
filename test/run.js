// Test runner — chạy tất cả test/*.test.mjs, fail nếu bất kỳ test nào fail.
// Dùng: npm test
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(ROOT, 'test');
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (!files.length) {
  console.error('Khong co test nao trong test/');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(testDir, f)], {
    stdio: 'inherit',
    cwd: ROOT
  });
  if (r.status !== 0) {
    failed++;
    console.error('--- FAIL: ' + f + ' (exit ' + r.status + ')');
  }
}

console.log('\n========================================');
console.log(failed === 0 ? `ALL ${files.length} TEST FILES PASS` : `${failed}/${files.length} TEST FILES FAILED`);
process.exit(failed === 0 ? 0 : 1);
