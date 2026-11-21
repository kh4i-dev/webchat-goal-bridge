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

const PLATFORMS = [
  { key: 'chatgpt', name: 'ChatGPT', icon: 'GPT' },
  { key: 'gemini', name: 'Gemini', icon: 'GEM' },
  { key: 'claude', name: 'Claude', icon: 'CLD' }
];

function renderPlatforms(ledgers, sharedLimits, presence) {
  const el = document.getElementById('platforms');
  el.innerHTML = '';
  for (const p of PLATFORMS) {
    const led = ledgers?.[p.key] || { recordFetch: 0, sends: 0 };
    const limit = sharedLimits?.[p.key];
    const limited = limit && limit.until > Date.now();
    const pres = presence?.[p.key];
    const live = pres && Date.now() - pres.ts < 30000;

    const row = document.createElement('div');
    row.className = 'prow';

    const icon = document.createElement('span');
    icon.className = 'picon ' + p.key;
    icon.textContent = p.icon;
    row.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'pinfo';
    const name = document.createElement('div');
    name.className = 'pname';
    name.textContent = p.name;
    const dot = document.createElement('span');
    dot.className = 'pdot' + (live ? ' live' : '');
    dot.title = live ? 'Tab đang mở và beacon' : 'Chưa thấy tab nào của nền tảng này';
    name.appendChild(dot);
    const lab = document.createElement('span');
    lab.className = 'plabel';
    lab.textContent = live ? 'đang hoạt động' : 'tab chưa mở';
    name.appendChild(lab);
    info.appendChild(name);

    const total = Math.max(led.recordFetch || 0, led.sends || 0);
    const pct = Math.min(100, Math.round((total / BUDGET.recordFetch) * 100));
    const bar = document.createElement('div');
    bar.className = 'pbar';
    const fill = document.createElement('div');
    fill.style.width = pct + '%';
    fill.style.background = barColor(pct);
    bar.appendChild(fill);
    info.appendChild(bar);

    const num = document.createElement('div');
    num.className = 'pnum';
    num.textContent = 'fetch ' + (led.recordFetch || 0) + '/' + BUDGET.recordFetch + ' · send ' + (led.sends || 0) + '/' + BUDGET.sends;
    info.appendChild(num);
    row.appendChild(info);

    const badge = document.createElement('span');
    if (limited) {
      badge.className = 'pbadge warn';
      badge.textContent = 'nghỉ ' + Math.max(0, Math.round((limit.until - Date.now()) / 1000)) + 's';
      badge.title = limit.reason || '429';
    } else if (pct > 90) {
      badge.className = 'pbadge bad';
      badge.textContent = 'gần hạn mức';
    } else {
      badge.className = 'pbadge ok';
      badge.textContent = 'OK';
    }
    row.appendChild(badge);
    el.appendChild(row);
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
  chrome.storage.local.get({ ledgers: null, sharedLimits: null, presence: null }, (s) =>
    renderPlatforms(s.ledgers, s.sharedLimits, s.presence)
  );
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
