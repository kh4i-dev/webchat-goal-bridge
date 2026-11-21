const FIELDS = { serverUrl: '', token: '', trigger: '@wgb' };
const CHECKS = { enabled: true, autoSend: true };
const BUDGET = { recordFetch: 40, sends: 40 };
const manifest = chrome.runtime.getManifest();
document.getElementById('ver').textContent = 'v' + manifest.version;

chrome.storage.sync.get({ ...FIELDS, ...CHECKS }, (s) => {
  document.getElementById('serverUrl').value = s.serverUrl;
  document.getElementById('token').value = s.token;
  document.getElementById('trigger').value = s.trigger;
  document.getElementById('enabled').checked = s.enabled;
  document.getElementById('autoSend').checked = s.autoSend;
});

function relay(msg, cb) {
  chrome.runtime.sendMessage(msg, (res) => {
    const err = chrome.runtime.lastError;
    cb(err ? { error: 'context-invalidated' } : res && res.ok ? { data: res.data } : { error: (res && (res.error || res.status)) || 'no-response' });
  });
}

function renderBudget(ledger, shared) {
  const f = Math.min(BUDGET.recordFetch, ledger?.recordFetch || 0);
  const s2 = Math.min(BUDGET.sends, ledger?.sends || 0);
  document.getElementById('bFetch').textContent = f + '/' + BUDGET.recordFetch;
  const bf = document.getElementById('barFetch');
  bf.style.width = Math.round((f / BUDGET.recordFetch) * 100) + '%';
  bf.className = f >= BUDGET.recordFetch ? 'hot' : '';
  document.getElementById('bSend').textContent = s2 + '/' + BUDGET.sends;
  const bs = document.getElementById('barSend');
  bs.style.width = Math.round((s2 / BUDGET.sends) * 100) + '%';
  bs.className = s2 >= BUDGET.sends ? 'hot' : '';
  const li = document.getElementById('limitInfo');
  if (shared && shared.until > Date.now()) {
    li.textContent = 'nghỉ ' + Math.round((shared.until - Date.now()) / 1000) + 's (' + (shared.reason || '429') + ')';
    li.className = 'warn';
  } else {
    li.textContent = 'OK';
    li.className = 'ok';
  }
}

const ST_TAG = { done: '[OK] ', failed: '[ERR]', running: '[RUN]', queued: '[QUE]' };
function renderGoals(goals) {
  const el = document.getElementById('goals');
  if (!Array.isArray(goals) || !goals.length) {
    el.innerHTML = '<div class="empty">(chưa có goal — gõ @wgb &lt;task&gt; trong chat)</div>';
    return;
  }
  el.innerHTML = '';
  for (const g of goals.slice(0, 5)) {
    const ln = document.createElement('div');
    ln.className = 'ln';
    const st = document.createElement('span');
    st.className = 'st ' + g.status;
    st.textContent = ST_TAG[g.status] || '[···]';
    const id = document.createElement('span');
    id.className = 'gid';
    id.textContent = g.id.slice(0, 10);
    const task = document.createElement('span');
    task.className = 'task';
    task.textContent = (g.task || '').slice(0, 60);
    ln.appendChild(st); ln.appendChild(id); ln.appendChild(task);
    el.appendChild(ln);
  }
}

function refreshLive() {
  relay({ path: '/status', method: 'GET' }, (res) => {
    const el = document.getElementById('serverInfo');
    if (res.data) {
      const up = res.data.uptimeSec >= 3600
        ? Math.floor(res.data.uptimeSec / 3600) + 'h' + Math.round((res.data.uptimeSec % 3600) / 60) + 'p'
        : Math.round(res.data.uptimeSec / 60) + 'p';
      el.innerHTML = '<span class="led"></span><span class="ok">online</span> &nbsp;runner: <span class="info">' + res.data.runner + '</span> &nbsp;· up ' + up;
    } else {
      el.innerHTML = '<span class="led bad"></span><span class="bad">offline</span> — ' + (res.error || 'chạy: node src/cli.js serve');
    }
  });
  relay({ path: '/goals?limit=5', method: 'GET' }, (res) => renderGoals(res.data || []));
  chrome.storage.local.get({ ledger: null, sharedLimit: null }, (s) => renderBudget(s.ledger, s.sharedLimit));
}

refreshLive();
setInterval(refreshLive, 5000);

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      serverUrl: document.getElementById('serverUrl').value.trim(),
      token: document.getElementById('token').value.trim(),
      trigger: document.getElementById('trigger').value.trim() || '@wgb',
      enabled: document.getElementById('enabled').checked,
      autoSend: document.getElementById('autoSend').checked
    },
    () => { document.getElementById('status').textContent = 'Đã lưu — reload tab chat để áp dụng.'; }
  );
});

document.getElementById('test').addEventListener('click', () => {
  const st = document.getElementById('status');
  st.textContent = 'Đang gọi /status ...';
  relay({ path: '/status', method: 'GET' }, (res) => {
    if (res.data) st.textContent = `OK — runner: ${res.data.runner}, goals: ${res.data.goals}, uptime: ${res.data.uptimeSec}s`;
    else st.textContent = 'LỖI: ' + (res.error || 'không kết nối được wgb serve');
  });
});
