// Security gate + audit — tổng hợp từ prior art:
//  * aegisloop: sanitizeForGate (bỏ dòng phủ định trước khi quét denylist để payload
//    kiểu "do not run rm -rf" không tự whitelist chính nó), audit JSONL mọi quyết định
//  * AgentControlPlane: workspace allowlist — KHÔNG BAO GIỜ nhận path từ chat
//  * codex-chatgpt-control: block-with-reason thay vì retry mù

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

const DEFAULT_DENYLIST = [
  /\brm\s+(-[a-z]*r[a-z]*f|\/[a-z]*r[a-z]*)/i,
  /remove-item\b[^|]*-recurse/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[sq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bshutdown\b/i,
  /\btaskkill\s+\/f/i,
  /curl[^|]*\|\s*(ba)?sh/i,
  /wget[^|]*\|\s*(ba)?sh/i,
  /\b(invokexpression|invoke-expression|iex)\b/i,
  /\bset-executionpolicy\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bschtasks\b/i,
  /\bnet\s+user\b/i,
  /\bDiskpart\b/i,
  /\b(vssadmin|bcdedit)\b/i,
  /(id_rsa|\.env\b|credentials|\.npmrc|\.git-credentials|\.ssh[\/\\])/i
];

export function sanitizeForGate(text) {
  // Bỏ TỪ phủ định (giữ phần còn lại của câu) — aegisloop: payload nói
  // "do not run rm -rf" không được whitelist bởi chính sự phủ định của nó.
  return String(text)
    .replace(/\b(do not|don'?t|never|kh[ôo]ng|ch[ạa]y l[êe]n|l[àa]m ơn)\b/gi, ' ')
    .replace(/\s+/g, ' ');
}

export function gateCheck(task, cfg, log = () => {}) {
  const patterns = [...DEFAULT_DENYLIST, ...(cfg.runner?.denylistPatterns || []).map((p) => new RegExp(p, 'i'))];
  const sanitized = sanitizeForGate(task);
  const hit = patterns.find((re) => re.test(sanitized));
  if (hit) {
    log('gate', 'CHAN task khop denylist:', String(hit));
    audit('gate_block', { task: String(task).slice(0, 200), pattern: String(hit) });
    throw new Error(
      'Task bi CHAN boi security gate (denylist). Neu day la y ban that, sua runner.denylistPatterns trong config.json.'
    );
  }
  return true;
}

export function audit(kind, data = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n';
    fs.appendFileSync(path.join(dataDir(), 'events.jsonl'), line);
  } catch {
    /* audit khong bao gio lam roi flow */
  }
}

export function assertAllowedRoot(cwd, cfg) {
  const roots = (cfg.runner?.allowedRoots || [cfg.runner?.cwd || '.']).map((r) => path.resolve(r));
  const target = path.resolve(cwd);
  const ok = roots.some((r) => target === r || target.startsWith(r + path.sep));
  if (!ok) {
    audit('root_block', { cwd: target });
    throw new Error('cwd nam ngoai allowedRoots: ' + target + ' (chi dinh runner.allowedRoots trong config.json neu dung)');
  }
  return target;
}
