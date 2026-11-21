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
  document.getElementById('barFetch').style.width = Math.round((f / BUDGET.recordFetch) * 100) + '%';
  document.getElementById('bSend').textContent = s2 + '/' + BUDGET.sends;
  document.getElementById('barSend').style.width = Math.round((s2 / BUDGET.sends) * 100) + '%';
  const li = document.getElementById('limitInfo');
  if (shared && shared.until > Date.now()) {
    li.textContent = 'nghỉ ' + Math.round((shared.until - Date.now()) / 1000) + 's (' + (shared.reason || '429') + ')';
    li.className = 'warn';
  } else {
    li.textContent = 'OK';
    li.className = 'ok';
  }
}

function renderGoals(goals) {
  const el = document.getElementById('goals');
  if (!Array.isArray(goals) || !goals.length) {
    el.textContent = '(chưa có goal — gõ @wgb <task> trong chat)';
    return;
  }
  el.innerHTML = '';
  for (const g of goals.slice(0, 5)) {
    const icon = g.status === 'done' ? '✅' : g.status === 'failed' ? '❌' : g.status === 'running' ? '▶' : '⏳';
    const d = document.createElement('div');
    d.className = 'gline';
    d.textContent = icon + ' ' + g.id + ' · ' + g.status + ' · ' + (g.task || '').slice(0, 44);
    el.appendChild(d);
  }
}

function refreshLive() {
  relay({ path: '/status', method: 'GET' }, (res) => {
    const el = document.getElementById('serverInfo');
    if (res.data) {
      el.innerHTML = '<span class="ok">● online</span> — runner: ' + res.data.runner + ' · uptime: ' + res.data.uptimeSec + 's';
    } else {
      el.innerHTML = '<span class="bad">● offline</span> — ' + (res.error || 'chạy `node src/cli.js serve`');
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
