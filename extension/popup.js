const FIELDS = ['serverUrl', 'token', 'trigger', 'enabled', 'autoSend'];
const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8787',
  token: '',
  trigger: '@wgb',
  enabled: true,
  autoSend: true
};

chrome.storage.sync.get(DEFAULTS, (s) => {
  document.getElementById('serverUrl').value = s.serverUrl;
  document.getElementById('token').value = s.token;
  document.getElementById('trigger').value = s.trigger;
  document.getElementById('enabled').checked = s.enabled;
  document.getElementById('autoSend').checked = s.autoSend;
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      serverUrl: document.getElementById('serverUrl').value.trim(),
      token: document.getElementById('token').value.trim(),
      trigger: document.getElementById('trigger').value.trim() || '@wgb',
      enabled: document.getElementById('enabled').checked,
      autoSend: document.getElementById('autoSend').checked
    },
    () => { document.getElementById('status').textContent = 'Da luu — reload tab chat de ap dung.'; }
  );
});

document.getElementById('test').addEventListener('click', async () => {
  const st = document.getElementById('status');
  st.textContent = 'Dang goi /status ...';
  chrome.runtime.sendMessage({ path: '/status', method: 'GET' }, (res) => {
    if (res && res.ok) {
      st.textContent = `OK — runner: ${res.data.runner}, goals: ${res.data.goals}, uptime: ${res.data.uptimeSec}s`;
    } else {
      st.textContent = 'LOI: ' + ((res && (res.error || res.status)) || 'khong ket noi duoc wgb serve');
    }
  });
});
