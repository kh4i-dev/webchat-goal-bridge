const FIELDS = { serverUrl: '', token: '', trigger: '@wgb' };
const CHECKS = { enabled: true, autoSend: true };
const BUDGET = globalThis.WGB_LIB.BUDGET;
const manifest = chrome.runtime.getManifest();
document.getElementById('ver');

// ── tabs (v1.9: ARIA + keyboard navigation theo blueprint Gemini) ──
function switchTab(tabName, { focusToken = false } = {}) {
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const isTarget = tab.dataset.tab === tabName;
    tab.classList.toggle('active', isTarget);
    tab.setAttribute('aria-selected', String(isTarget));
    tab.tabIndex = isTarget ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.classList.toggle('hidden', !isTarget);
  });
  if (focusToken) document.getElementById('token')?.focus();
}
document.querySelectorAll('[role="tab"]').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
document.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const cur = tabs.indexOf(document.activeElement);
  if (cur === -1) return;
  const next = (cur + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
});

// ── click-to-copy (empty state + mọi [data-copy]) ───────────────
function bindCopyButtons(root = document) {
  root.querySelectorAll('[data-copy]').forEach((el) => {
    if (el.dataset.copyBound) return;
    el.dataset.copyBound = '1';
    el.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        const prev = el.textContent;
        el.textContent = '✓ Copied';
        el.classList.add('is-copied');
        setTimeout(() => { el.textContent = prev; el.classList.remove('is-copied'); }, 1200);
      } catch { /* clipboard bị chặn */ }
    });
  });
}
bindCopyButtons();

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
    // v1.9: trả nguyên { ok, status, data, error } để popup phân biệt
    // Offline (fetch fail) với No Token (401/403) — hai cách sửa khác nhau.
    cb(err ? { error: 'context-invalidated' } : (res || { error: 'no-response' }));
  });
}

function barColor(tone) {
  return tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--info)';
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
    // v1.9.1: không nói dối "tab chưa mở" khi tab có thể đang mở nhưng beacon
    // vừa orphan sau update — gợi ý hành động cụ thể thay vì trạng thái sai.
    lab.textContent = live ? 'đang hoạt động' : 'chưa thấy beacon — reload tab chat';
    lab.title = live
      ? 'Beacon presence mới trong 30s'
      : 'Không nhận beacon nào của nền tảng này trong 30s. Nếu tab đang mở: extension vừa update thì background tự re-inject, hoặc bạn reload tab chat.';
    name.appendChild(lab);
    info.appendChild(name);

    const total = Math.max(led.recordFetch || 0, led.sends || 0);
    // v1.8: budgetState là source-of-truth (lib.js). Bug cũ: 40/40 hiện badge
    // "gần hạn mức" trong khi thực tế đã bị CHẶN (overBudget() = true).
    const bs = globalThis.WGB_LIB.budgetState(led, BUDGET.recordFetch);
    const pct = bs.pct;
    const bar = document.createElement('div');
    bar.className = 'pbar';
    const fill = document.createElement('div');
    fill.style.width = pct + '%';
    fill.style.background = barColor(bs.tone);
    bar.appendChild(fill);
    info.appendChild(bar);

    const num = document.createElement('div');
    num.className = 'pnum';
    num.textContent = 'fetch ' + bs.fetch + '/' + BUDGET.recordFetch + ' · send ' + bs.sends + '/' + BUDGET.sends;
    info.appendChild(num);
    row.appendChild(info);

    const badge = document.createElement('span');
    if (limited) {
      // v1.9 (blueprint Gemini): "nghỉ" mơ hồ — nói rõ lý do 429
      badge.className = 'pbadge warn';
      badge.textContent = '429 · chờ ' + Math.max(0, Math.round((limit.until - Date.now()) / 1000)) + 's';
      badge.title = limit.reason || '429';
    } else if (bs.level === 'blocked') {
      badge.className = 'pbadge bad';
      badge.textContent = 'hết hạn mức';
      badge.title = 'Đã chạm trần ' + BUDGET.recordFetch + ' lượt/giờ — task mới sẽ bị chặn';
    } else if (bs.level === 'near') {
      badge.className = 'pbadge bad';
      badge.textContent = 'gần hạn mức';
    } else {
      badge.className = 'pbadge ok';
      badge.textContent = 'OK';
    }
    // trạng thái_budget lên chính card (nền đỏ tint + mờ tên khi chặn)
    row.dataset.budget = limited ? 'cooldown' : bs.level;
    row.appendChild(badge);
    el.appendChild(row);
  }
}

const CHK = { done: '✓', failed: '✕', running: '▸', queued: '…' };
const GOALS_EMPTY_HTML =
  '<div class="empty">' +
  '<div>chưa có goal — gõ <button type="button" class="code-copy" data-copy="@wgb status">@wgb &lt;task&gt;</button> trong chat</div>' +
  '<div class="empty-example">Ví dụ: <code>@wgb tóm tắt diff git hiện tại</code></div>' +
  '</div>';
function renderGoals(goals) {
  const el = document.getElementById('goals');
  const hint = document.getElementById('goals-hint');
  if (hint) hint.style.opacity = Array.isArray(goals) && goals.length ? '1' : '0';
  if (!Array.isArray(goals) || !goals.length) {
    el.innerHTML = GOALS_EMPTY_HTML;
    bindCopyButtons(el);
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

function setServerPill(state, label, title) {
  const pillEl = document.getElementById('server-status');
  if (pillEl) {
    pillEl.dataset.state = state;
    pillEl.title = title || '';
    pillEl.onclick = state === 'no-auth' ? () => switchTab('settings', { focusToken: true }) : null;
  }
  document.body.classList.toggle('online', state === 'online');
  document.body.classList.toggle('offline', state !== 'online');
  document.getElementById('statusText').textContent = label;
}

// v1.9 (blueprint Gemini): 3 trạng thái — Online / No Token (401/403) / Offline
function refreshLive() {
  relay({ path: '/status', method: 'GET' }, (res) => {
    if (res.ok && res.data) {
      setServerPill('online', 'Online · ' + fmtUp(res.data.uptimeSec), 'Kết nối wgb serve ổn định');
    } else if (res.status === 401 || res.status === 403) {
      setServerPill('no-auth', 'Chưa có token', 'Server đang chạy nhưng thiếu/sai token — bấm để mở Cấu hình');
    } else {
      setServerPill('offline', 'Offline', 'Không kết nối được 127.0.0.1:8787 — hãy chạy: node src/cli.js serve');
    }
  });
  relay({ path: '/goals?limit=5', method: 'GET' }, (res) => {
    const goals = res.data || [];
    renderGoals(goals);
    // v1.9: goal đang chạy được pin lên banner ngay dưới tab bar
    const banner = document.getElementById('goal-banner');
    const active = Array.isArray(goals)
      ? goals.find((g) => g.status === 'running' || g.status === 'queued')
      : null;
    if (banner) {
      // v1.9.1 guard: KHÔNG BAO GIỜ hiện banner rỗng — phải có goal thật sự
      if (active && active.id) {
        banner.classList.remove('hidden');
        banner.innerHTML = '';
        const chk = document.createElement('span');
        chk.textContent = CHK[active.status] || '…';
        const gid = document.createElement('span');
        gid.className = 'gid';
        gid.textContent = active.id.slice(0, 10);
        const task = document.createElement('span');
        task.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        task.textContent = (active.task || '').slice(0, 46);
        banner.appendChild(chk); banner.appendChild(gid); banner.appendChild(task);
        banner.title = active.status + ' — bấm dòng trong danh sách để copy ID';
      } else {
        banner.classList.add('hidden');
      }
    }
  });
  chrome.storage.local.get(
    { ledgers: null, sharedLimits: null, presence_chatgpt: null, presence_gemini: null, presence_claude: null },
    (s) => {
      // v1.9.1: presence theo key riêng từng platform (chống race ghi đè)
      const presence = {};
      for (const p of PLATFORMS) {
        if (s['presence_' + p.key]) presence[p.key] = s['presence_' + p.key];
      }
      renderPlatforms(s.ledgers, s.sharedLimits, presence);
    }
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
    if (res.ok && res.data) testBtn.textContent = '✓ ' + ms + 'ms';
    else if (res.status === 401 || res.status === 403) testBtn.textContent = '✕ Token sai/thiếu';
    else testBtn.textContent = '✕ Không kết nối được';
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
