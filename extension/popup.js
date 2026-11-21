const FIELDS = { serverUrl: '', token: '', trigger: '@wgb' };
const CHECKS = { enabled: true, autoSend: true };
const BUDGET = { recordFetch: 40, sends: 40 };
const manifest = chrome.runtime.getManifest();
document.getElementById('ver');

// ── tabs ─────────────────────────────────────
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.getElementById('page-monitor').classList.toggle('hidden', t.dataset.tab !== 'monitor');
    document.getElementById('page-settings').classList.toggle('hidden', t.dataset.tab !== 'settings');
  });
});

// ── load settings ────────────────────────────
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

function barColor(pct) {
  if (pct > 90) return 'var(--bad)';
  if (pct > 75) return 'var(--warn)';
  return 'var(--info)';
}

function fmtUp(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'p' : m + 'p';
}

function renderBudget(ledger, shared) {
  const setBar = (id, val, max) => {
    const pct = Math.min(100, Math.round((val / max) * 100));
    const el = document.getElementById(id);
    el.style.width = pct + '%';
    el.style.background = barColor(pct);
    return val + '/' + max;
  };
  const f = Math.min(BUDGET.recordFetch, ledger?.recordFetch || 0);
  const s2 = Math.min(BUDGET.sends, ledger?.sends || 0);
  document.getElementById('bFetch').textContent = setBar('barFetch', f, BUDGET.recordFetch);
  document.getElementById('bSend').textContent = setBar('barSend', s2, BUDGET.sends);

  const badge = document.getElementById('limitBadge');
  if (shared && shared.until > Date.now()) {
    badge.textContent = 'Rate limit: nghỉ ' + Math.round((shared.until - Date.now()) / 1000) + 's';
    badge.className = 'badge warn';
  } else if (f >= BUDGET.recordFetch || s2 >= BUDGET.sends) {
    badge.textContent = 'Budget: đã hết (đổi giờ)';
    badge.className = 'badge bad';
  } else {
    badge.textContent = 'Rate limit: OK';
    badge.className = 'badge ok';
  }
}

const CHK = { done: '✓', failed: '✕', running: '▸', queued: '…' };
function renderGoals(goals) {
  const el = document.getElementById('goals');
  if (!Array.isArray(goals) || !goals.length) {
    el.innerHTML = '<div class="empty">(chưa có goal — gõ @wgb &lt;task&gt; trong chat)</div>';
    return;
  }
  el.innerHTML = '';
  for (const g of goals.slice(0, 5)) {
    const ln = document.createElement('div');
    ln.className = 'gline';
    const chk = document.createElement('span');
    chk.className = 'chk ' + (g.status || 'queued');
    chk.textContent = CHK[g.status] || '…';
    const gid = document.createElement('span');
    gid.className = 'gid';
    gid.textContent = g.id.slice(0, 10);
    const task = document.createElement('span');
    task.className = 'task';
    task.textContent = (g.task || '').slice(0, 60);
    const copied = document.createElement('span');
    copied.className = 'copied';
    copied.textContent = 'Copied!';
    ln.appendChild(chk); ln.appendChild(gid); ln.appendChild(task); ln.appendChild(copied);
    ln.title = 'Click: copy ID · ' + g.status;
    ln.addEventListener('click', () => {
      navigator.clipboard.writeText(g.id).then(() => {
        copied.classList.add('show');
        setTimeout(() => copied.classList.remove('show'), 1100);
      });
    });
    el.appendChild(ln);
  }
}

function refreshLive() {
  relay({ path: '/status', method: 'GET' }, (res) => {
    const online = Boolean(res.data);
    document.body.classList.toggle('online', online);
    document.body.classList.toggle('offline', !online);
    document.getElementById('statusText').textContent = online
      ? 'Online · ' + fmtUp(res.data.uptimeSec)
      : 'Offline';
  });
  relay({ path: '/goals?limit=5', method: 'GET' }, (res) => renderGoals(res.data || []));
  chrome.storage.local.get({ ledger: null, sharedLimit: null }, (s) => renderBudget(s.ledger, s.sharedLimit));
}

refreshLive();
setInterval(refreshLive, 5000);

// ── settings actions ─────────────────────────
document.getElementById('save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      serverUrl: document.getElementById('serverUrl').value.trim(),
      token: document.getElementById('token').value.trim(),
      trigger: document.getElementById('trigger').value.trim() || '@wgb',
      enabled: document.getElementById('enabled').checked,
      autoSend: document.getElementById('autoSend').checked
    },
    () => {
      const st = document.getElementById('status');
      st.textContent = '✓ Đã lưu — reload tab chat để áp dụng.';
      setTimeout(() => { st.textContent = ''; }, 2500);
    }
  );
});

const testBtn = document.getElementById('test');
testBtn.addEventListener('click', () => {
  const t0 = performance.now();
  testBtn.classList.add('busy');
  testBtn.innerHTML = '<span class="spin"></span>Đang kiểm tra…';
  relay({ path: '/status', method: 'GET' }, (res) => {
    const ms = Math.round(performance.now() - t0);
    testBtn.classList.remove('busy');
    testBtn.textContent = res.data ? '✓ ' + ms + 'ms' : '✕ Không kết nối được';
    setTimeout(() => { testBtn.textContent = 'Kiểm tra kết nối'; }, 2600);
  });
});

// ── token eye / paste ────────────────────────
const tokenInput = document.getElementById('token');
document.getElementById('eye').addEventListener('click', () => {
  tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
});
document.getElementById('paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      tokenInput.value = text.trim();
      tokenInput.type = 'text';
    }
  } catch {
    /* clipboard bị chặn — user tự dán */
  }
});
