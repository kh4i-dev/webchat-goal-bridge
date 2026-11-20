// wgb serve — control plane HTTP (zero-dep, loopback only) cho extension/CLI ngoài.
// Extension (wgb-companion) POST /dispatch khi thấy "@wgb <task>" trong chat web,
// rồi GET /goals/<id> cho tới done/failed, finally tự điền kết quả vào composer.
// Auth: header x-wgb-token nếu cfg.serve.token đặt; luôn bind 127.0.0.1.

import http from 'node:http';
import { createGoal, updateGoal, loadGoals } from './core/goals.js';
import { runTask, listRunners } from './runners/index.js';
import { log } from './util/log.js';

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body qua lon'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startServer(cfg, logger = log) {
  const port = cfg.serve?.port || 8787;
  const token = cfg.serve?.token || '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (token && req.headers['x-wgb-token'] !== token) {
      return json(res, 401, { error: 'sai token (x-wgb-token)' });
    }
    try {
      // POST /dispatch {text, source?}
      if (req.method === 'POST' && url.pathname === '/dispatch') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: 'thieu text' });
        const goal = createGoal({
          platform: body.platform || 'serve',
          chatUrl: body.chatUrl || url.origin,
          task: text,
          runner: cfg.runner.type
        });
        updateGoal(goal.id, { status: 'running' });
        // chay nen: client poll GET /goals/<id>
        runTask(text, cfg, logger)
          .then((r) => updateGoal(goal.id, { status: 'done', finishedAt: new Date().toISOString(), result: r.text }))
          .catch((err) => updateGoal(goal.id, { status: 'failed', finishedAt: new Date().toISOString(), error: String(err.message || err) }));
        logger('serve', 'dispatch goal', goal.id, '—', text.slice(0, 60));
        return json(res, 200, { goalId: goal.id, status: 'queued' });
      }

      // GET /goals/<id>
      const m = url.pathname.match(/^\/goals\/([\w-]+)$/);
      if (req.method === 'GET' && m) {
        const g = loadGoals().find((x) => x.id === m[1]);
        if (!g) return json(res, 404, { error: 'khong thay goal ' + m[1] });
        return json(res, 200, g);
      }

      // GET /goals?limit=20
      if (req.method === 'GET' && url.pathname === '/goals') {
        const limit = Number(url.searchParams.get('limit') || 20);
        return json(res, 200, loadGoals().slice(-limit).reverse());
      }

      // GET /status
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          ok: true,
          runner: cfg.runner.type,
          runners: listRunners(),
          goals: loadGoals().length,
          trigger: cfg.trigger,
          uptimeSec: Math.round(process.uptime())
        });
      }

      return json(res, 404, { error: 'khong ton tai ' + req.method + ' ' + url.pathname });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log('serve', `control plane: http://127.0.0.1:${port}  (runner=${cfg.runner.type}${token ? ', token bat' : ''})`);
  });
  return server;
}
