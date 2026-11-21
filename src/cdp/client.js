// Minimal CDP (Chrome DevTools Protocol) client — zero dependency.
// Uses Node >= 22 globals: fetch + WebSocket.
// HTTP endpoints (list/new/close targets) + direct page-target WebSocket for Runtime.evaluate.

const base = (port) => `http://127.0.0.1:${port}`;

async function jfetch(url, opts = {}, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export const cdpVersion = (port) => jfetch(`${base(port)}/json/version`);
export const listTargets = (port) => jfetch(`${base(port)}/json/list`, {}, 8000);
export const closeTarget = (port, id) => jfetch(`${base(port)}/json/close/${id}`);

export async function newTarget(port, url) {
  // Chromium >= 111 requires PUT for /json/new
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`${base(port)}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: ctl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} opening new tab for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Nang tab len foreground — bang buoc: tab bi frozen o nen se khong tra loi Runtime.evaluate. */
export async function activateTarget(port, id) {
  try {
    await jfetch(`${base(port)}/json/activate/${id}`, {}, 5000);
    return true;
  } catch {
    return false;
  }
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._id = 0;
    this._pending = new Map();
    this._open = false;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('WebSocket connect error')); }, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const { reject } of this._pending.values()) reject(new Error('WebSocket closed'));
      this._pending.clear();
      this._open = false;
    });
    this._open = true;
    return this;
  }

  get open() {
    return this._open && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(method, params = {}, timeoutMs = 120000) {
    if (!this.open) throw new Error('CDP connection closed');
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, timeoutMs);
    });
  }

  /** Evaluate a JS expression in the page. Returns the JSON-serialised result value. */
  async evaluate(expression, timeoutMs = 120000) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }, timeoutMs);
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      const txt = d.exception?.description || d.text || 'evaluate failed';
      throw new Error('Page JS error: ' + txt.split('\n')[0]);
    }
    return res?.result?.value;
  }

  /** Tab nền có thể bị freeze — đánh thức: HTTP activate + Page.bringToFront. */
  async bringToFront() {
    try { await activateTarget(this.meta.port, this.meta.id); } catch { /* noop */ }
    try { await this.send('Page.bringToFront', {}, 8000); } catch { /* noop */ }
  }

  close() {
    try { this.ws?.close(); } catch { /* noop */ }
    this._open = false;
  }
}

export async function attach(target, port = 9222) {
  const conn = new Cdp(target.webSocketDebuggerUrl);
  conn.meta = { port, id: target.id };
  await conn.connect();
  return conn;
}

/** List page targets, optionally filtered by URL substring. */
export async function findPageTargets(port, urlContains) {
  const targets = await listTargets(port);
  const pages = (targets || []).filter((t) => t.type === 'page');
  if (!urlContains) return pages;
  return pages.filter((t) => (t.url || '').includes(urlContains));
}
