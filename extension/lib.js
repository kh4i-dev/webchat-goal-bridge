// wgb-companion — pure logic (không đụng DOM/chrome API).
// Tách ra để test được ngoài browser: node test/extension.test.mjs
// Đây là SOURCE OF TRUTH cho các quy tắc dùng chung giữa content.js và popup.js.
//
// Plain script (không dùng ESM) vì Chrome content script không import được.
// Browser:  manifest content_scripts.js = ["lib.js", "content.js"]; popup.html <script src="lib.js">
// Node test: vm.runInThisContext(file) → globalThis.WGB_LIB
(function (root) {
  'use strict';

  const BUDGET = { recordFetch: 40, sends: 40 };

  /** Cooldown ladder: 1p -> 5p -> 15p -> 30p (đọc từ content.js cũ). */
  const LADDER_MS = [60000, 300000, 900000, 1800000];

  /**
   * Suy ra platform từ hostname. Không dùng includes() trần — phải khớp domain thật.
   * Domain giả mạo (chatgpt.com.evil.test) phải rơi về 'unknown'.
   */
  function platformOfHost(host) {
    const h = String(host || '').toLowerCase();
    if (h === 'chatgpt.com' || h.endsWith('.chatgpt.com')) return 'chatgpt';
    if (h === 'gemini.google.com' || h.endsWith('.gemini.google.com')) return 'gemini';
    if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude';
    return 'unknown';
  }

  /**
   * Trạng thái hạn mức của 1 platform.
   *
   * level (badge):  'ok' | 'near' | 'blocked'
   *   blocked = đã chạm trần -> dispatch thực sự bị chặn (overBudget() = true).
   *             UI phải nói "hết hạn mức", KHÔNG nói "gần hạn mức" (bug cũ).
   *   near   = pct > 90 -> "gần hạn mức".
   *
   * tone (màu thanh): 'info' | 'warn' | 'bad' — ngưỡng 75/90 theo spec popup.
   */
  function budgetState(ledger, limit) {
    const lim = Number(limit) > 0 ? Number(limit) : BUDGET.recordFetch;
    const fetch = Number((ledger && ledger.recordFetch) || 0);
    const sends = Number((ledger && ledger.sends) || 0);
    const total = Math.max(fetch, sends);
    const pct = Math.min(100, Math.round((total / lim) * 100));
    let level = 'ok';
    if (total >= lim) level = 'blocked';
    else if (pct > 90) level = 'near';
    let tone = 'info';
    if (total >= lim || pct > 90) tone = 'bad';
    else if (pct > 75) tone = 'warn';
    return { fetch, sends, total, pct, level, tone, limit: lim };
  }

  /**
   * Tính mốc hết hạn tiếp theo của cooldown ladder.
   * - hits: số lần đã trúng limit trong cửa sổ 1h
   * - minWaitMs: Retry-After từ server (stated luôn thắng guessed)
   * - currentUntil: mốc đang chạy (monotonic — không bao giờ rút ngắn)
   */
  function nextLimitUntil(opts) {
    const o = opts || {};
    const now = Number(o.now) || 0;
    const ladder = o.ladder && o.ladder.length ? o.ladder : LADDER_MS;
    const hits = Math.max(1, Number(o.hits) || 1);
    const step = ladder[Math.min(hits - 1, ladder.length - 1)];
    const until = Math.max(now + step, now + (Number(o.minWaitMs) || 0), Number(o.currentUntil) || 0);
    return { until, waitMs: until - now };
  }

  /**
   * Echo-loop guard: reply agent gửi vào chat thành tin user mới.
   * Chỉ prefix reply ([wgb]) bị bỏ qua — KHÔNG bỏ qua mọi tin bắt đầu bằng trigger.
   */
  function isReplyEcho(flatText, replyPrefix) {
    if (!replyPrefix) return false;
    return String(flatText || '').startsWith(replyPrefix);
  }

  /**
   * Receipt cho submit: chỉ coi là "đã gửi" khi số user-turn TĂNG.
   * submitted=unknown => không bao giờ tự gửi lại (chống gửi trùng).
   */
  function shouldSendReceipt(receipt) {
    const r = receipt || {};
    return Number(r.after) > Number(r.before);
  }

  /** Đọc version từ manifest — không hardcode trong content.js (trước đây lệch 1.3.0 vs 1.7.1). */
  function manifestVersion(manifest) {
    const v = manifest && manifest.version;
    return typeof v === 'string' && v ? v : '0.0.0';
  }

  root.WGB_LIB = {
    BUDGET,
    LADDER_MS,
    platformOfHost,
    budgetState,
    nextLimitUntil,
    isReplyEcho,
    shouldSendReceipt,
    manifestVersion
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
