// Runners — bien task text thanh ket qua. P0: echo, exec, opencode, inbox (file protocol).
// inbox runner = giao khep voi BAT KY agent nao qua inbox/outbox (giao thuc cua
// gemini_cdp_watcher.mjs / SemanticLab bridge): goal JSON ra inbox/, reply .md ve outbox/.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gateCheck, assertAllowedRoot } from '../security.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runProcess(cmd, args, cwd, timeoutMs, log) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      log('runner', 'timeout, kill:', cmd);
      try { child.kill(); } catch { /* noop */ }
      resolve({ code: -1, stdout, stderr: stderr + '\n[killed by timeout]' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const RUNNERS = {
  /** Tra lai chinh task — dung de test vong lap end-to-end khong ton token. */
  echo: async (task) => ({ text: `[echo] ${task}` }),

  /** Chay cau lenh shell cau hinh truoc, task duoc chen vao {task}. */
  exec: async (task, cfg, log) => {
    const r = cfg.runner;
    if (!r.command) throw new Error('runner.exec can cfg.runner.command (dung {task} de chen)');
    const cwd = assertAllowedRoot(r.cwd || '.', cfg);
    const filled = String(r.command).includes('{task}') ? r.command.replace('{task}', task) : `${r.command} ${task}`;
    const res = await runProcess('cmd.exe', ['/d', '/s', '/c', filled], cwd, r.timeoutMs || 300000, log);
    if (res.code !== 0) throw new Error(`exit ${res.code}: ${(res.stderr || res.stdout).slice(-400)}`);
    return { text: (res.stdout || '(khong co stdout)').trim().slice(0, 4000) };
  },

  /** Chay opencode CLI non-interactive trong project dir cau hinh. */
  opencode: async (task, cfg, log) => {
    const r = cfg.runner;
    const cwd = assertAllowedRoot(r.cwd || '.', cfg);
    const model = r.model ? ['--model', r.model] : [];
    log('runner', `opencode run trong ${cwd}...`);
    const res = await runProcess('opencode', ['run', ...model, task], cwd, r.timeoutMs || 900000, log);
    if (res.code !== 0) throw new Error(`opencode exit ${res.code}: ${(res.stderr || res.stdout).slice(-600)}`);
    const text = (res.stdout || '').trim();
    if (!text) throw new Error('opencode tra ve rong');
    return { text: text.slice(0, 6000) };
  },

  /**
   * File protocol (harness-agnostic): ghi goal JSON vao inbox/, cho bat ky
   * agent nao viet reply_*.md vao outbox/ (bat ky ten nao xuat hien SAU khi
   * goal duoc ghi). Nhan tin .sent sau khi lay; goal file doi thanh .processed.
   */
  inbox: async (task, cfg, log) => {
    const r = cfg.runner;
    const inbox = path.resolve(r.inbox || path.join('data', 'inbox'));
    const outbox = path.resolve(r.outbox || path.join('data', 'outbox'));
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(outbox, { recursive: true });
    const before = new Set(fs.readdirSync(outbox));
    const id = 'goal_' + Date.now();
    const goalFile = path.join(inbox, id + '.json');
    fs.writeFileSync(
      goalFile,
      JSON.stringify({ id, ts: new Date().toISOString(), source: 'wgb', text: task }, null, 2)
    );
    log('runner', 'goal file ghi ra:', goalFile);
    const deadline = Date.now() + (r.timeoutMs || 900000);
    while (Date.now() < deadline) {
      const fresh = fs
        .readdirSync(outbox)
        .filter((f) => f.endsWith('.md') && !before.has(f));
      if (fresh.length) {
        const f = fresh.sort()[0];
        const full = path.join(outbox, f);
        const text = fs.readFileSync(full, 'utf8').trim();
        try { fs.renameSync(full, full + '.sent'); } catch { /* noop */ }
        try { fs.renameSync(goalFile, goalFile + '.processed'); } catch { /* noop */ }
        if (!text) throw new Error('reply file rong: ' + f);
        return { text: text.slice(0, 12000), via: 'inbox:' + f };
      }
      await sleep(1500);
    }
    throw new Error('inbox runner timeout — khong agent nao tra reply cho ' + id);
  }
};

export function listRunners() {
  return Object.keys(RUNNERS);
}

export async function runTask(task, cfg, log) {
  const type = cfg.runner.type || 'echo';
  const fn = RUNNERS[type];
  if (!fn) throw new Error(`Runner khong ton tai: ${type} (co san: ${listRunners().join(', ')})`);
  if (type !== 'echo') gateCheck(task, cfg, log); // echo la runner test, van cho qua
  return fn(task, cfg, log);
}
