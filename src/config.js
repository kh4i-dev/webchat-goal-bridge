import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './util/log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function projectRoot() {
  return ROOT;
}

export function dataDir(...sub) {
  const d = path.join(ROOT, 'data', ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const DEFAULTS = {
  brave: {
    exe: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    cdpPort: 9222,
    restoreArgs: ['--restore-last-session'],
    gracefulCloseTimeoutMs: 20000
  },
  platforms: {
    chatgpt: { homeUrl: 'https://chatgpt.com/' },
    gemini: { homeUrl: 'https://gemini.google.com/app' }
  },
  trigger: '@bridge',
  replyPrefix: '[wgb]',
  pollMs: 8000,
  replyTimeoutMs: 180000,
  runner: {
    type: 'echo',
    cwd: '.',
    timeoutMs: 600000
  },
  serve: {
    port: 8787,
    token: ''
  }
};

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] ?? {}, v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

export function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), p);
    log('config', 'da tao config.json tu config.example.json (sua neu can)');
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return deepMerge(structuredClone(DEFAULTS), raw);
}
