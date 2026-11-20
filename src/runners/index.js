// Runners — bien task text thanh ket qua. P0: echo, exec, opencode.
// P1 (roadmap): goal-MCP runner (map vao harness goal system), worktree runner.

import { spawn } from 'node:child_process';
import path from 'node:path';

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
    const filled = String(r.command).includes('{task}') ? r.command.replace('{task}', task) : `${r.command} ${task}`;
    const res = await runProcess('cmd.exe', ['/d', '/s', '/c', filled], path.resolve(r.cwd || '.'), r.timeoutMs || 300000, log);
    if (res.code !== 0) throw new Error(`exit ${res.code}: ${(res.stderr || res.stdout).slice(-400)}`);
    return { text: (res.stdout || '(khong co stdout)').trim().slice(0, 4000) };
  },

  /** Chay opencode CLI non-interactive trong project dir cau hinh. */
  opencode: async (task, cfg, log) => {
    const r = cfg.runner;
    const cwd = path.resolve(r.cwd || '.');
    const model = r.model ? ['--model', r.model] : [];
    log('runner', `opencode run trong ${cwd}...`);
    const res = await runProcess('opencode', ['run', ...model, task], cwd, r.timeoutMs || 900000, log);
    if (res.code !== 0) throw new Error(`opencode exit ${res.code}: ${(res.stderr || res.stdout).slice(-600)}`);
    const text = (res.stdout || '').trim();
    if (!text) throw new Error('opencode tra ve rong');
    return { text: text.slice(0, 6000) };
  }
};

export function listRunners() {
  return Object.keys(RUNNERS);
}

export async function runTask(task, cfg, log) {
  const type = cfg.runner.type || 'echo';
  const fn = RUNNERS[type];
  if (!fn) throw new Error(`Runner khong ton tai: ${type} (co san: ${listRunners().join(', ')})`);
  return fn(task, cfg, log);
}
