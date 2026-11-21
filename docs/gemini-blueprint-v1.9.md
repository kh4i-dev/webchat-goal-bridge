Gemini đã nói

Here is a technical and UI/UX audit of wgb-companion v1.8 based on the live popup capture (wgb-panel-v2.png) and your architectural notes.

Part 1: Panel UI/UX & Accessibility Audit
1. Information Hierarchy

Current Flow: Header (wgb companion + Offline pill) 
→
→ Navigation Tabs (Giám sát | Cấu hình) 
→
→ Platform Quotas (Nền tảng) 
→
→ Goal Feed (Goals gần nhất).

Verdict: The top-down order is logical for a monitoring dashboard, except when an active goal is running. In a developer tool where the primary loop is dispatching and waiting on local execution, active/running goals are higher priority than static quota bars.

Recommendation: Keep Nền tảng above Goals gần nhất when all goals are terminal (done / failed), or dynamically pin any running / queued goal to a compact banner right below the tab bar so you don't have to scan past 3 platform cards to see if your task is still executing. Also, in the screenshot, the popup canvas is huge (looks like a full-tab capture over CDP); ensure body in popup.html has a strict width: 360px–380px so it never stretches awkwardly if opened in a tab.

2. Empty State (Goals gần nhất)

Current: (chưa có goal — gõ @wgb <task> trong chat) in very low-contrast grey, centered/left-aligned inside a dark box.

Verdict: Too passive. A user opening the popup for the first time sees Offline at the top and a faint parenthetical hint at the bottom, which feels like an error state rather than an onboarding prompt.

Recommendation:

Make the trigger interactive: render @wgb <task> inside a clickable <code> pill that copies a starter snippet (e.g., @wgb status) to the clipboard.

Add a concrete 1-line example directly underneath in dim text: Ví dụ: @wgb tóm tắt diff git hiện tại.

Notice a subtle trigger mismatch in your docs vs. UI: Section 1's ASCII diagram mentions @bridge, while the extension UI and Section 3 say @wgb. Standardize on @wgb across both layers or support both as aliases so users aren't confused.

3. Per-Platform Cards & Quota Badges

Current: OK (green outline pill), gần hạn mức (near limit), hết hạn mức (blocked), nghỉ Ns (cooldown).

Verdict: The copy is concise and clear in Vietnamese, except nghỉ Ns—in a rate-limit context, chờ Ns (wait Ns) or 429 · Ns communicates why it is paused much better than nghỉ (resting).

Visual Hierarchy for Blocked State: Yes, a blocked platform (40/40 or 429) must be visually stronger than near.

OK: Subtle green border/text (as currently shown).

gần hạn mức (
≥
80
%
≥80%): Amber text + amber progress bar fill.

hết hạn mức / chờ Ns: Solid or tinted red background (rgba(239, 68, 68, 0.15)), red border on the card itself, and 50% opacity on the platform name/icon to visually signal "disabled/throttled."

4. The Offline Status Pill

Current: Red dot + Offline at top right.

Verdict: Yes, distinguish them. In a local-first architecture (127.0.0.1:8787 + auth token), the #1 setup friction is forgetting to paste the bearer token into Cấu hình vs. forgetting to run wgb serve.

Recommendation: Split into three distinct states:

Online (Green): GET /health returns 200 + valid token.

No Token / 401 (Amber): Server is reachable on :8787, but auth fails—clicking the pill should switch directly to the Cấu hình tab and focus the token input.

Offline (Red): Connection refused (fetch throws TypeError)—tooltip should show Chạy: wgb serve.

5. Copy Affordance (bấm dòng để copy ID)

Verdict: Currently, the header hint bấm dòng để copy ID sits on the right, which adds visual noise before any goals even exist, and once goals exist, a whole-row click target with no hover affordance looks non-interactive.

Recommendation: Remove bấm dòng để copy ID from the section header when the list is empty. On rendered goal rows, show a subtle copy icon (⧉) on hover (or alongside the short ID gmwqfya2) that swaps to a green ✓ Copied badge for 1.2s.

6. Dark-Theme Contrast (WCAG AA)

Measured from Screenshot:

Background (--bg): #0d1117 (approx. RGB 13, 17, 23)

Card surface: #161b22 (approx. RGB 22, 27, 34)

Muted text (tab chưa mở, fetch 4/40, mỗi app một hạn mức riêng): #586374 (approx. RGB 88, 99, 116)

Contrast Ratio: #586374 on #161b22 yields a contrast ratio of ~3.1:1. For 10px–11px text, WCAG AA requires 4.5:1 (and AAA requires 7:1). In your screenshot, (chưa có goal — gõ @wgb <task> trong chat) and fetch 0/40 · send 0/40 are genuinely difficult to read on low-brightness screens.

Recommendation: Bump --dim to at least #8b949e (~5.8:1 contrast on #161b22) and --faint (used for empty states/subtitles) to #768390 (~4.6:1 contrast). Keep #484f58 strictly for hairline borders and progress bar tracks, never for text.

7. Accessibility (ARIA & Non-Color Indicators)

Tabs: Currently uses solid green fill (#2ea043 / #3fb950) vs. transparent background. Add role="tablist" on the container, role="tab" and aria-selected="true|false" on each button, and tabindex="0|-1" for arrow-key navigation.

Status Dots: The dot next to ChatGPT • tab chưa mở is tiny (6px) and relies solely on grey vs. green. Keep the text label (tab chưa mở vs. đang mở), add aria-hidden="true" to the decorative dot, and give an active tab dot a subtle outer ring (box-shadow: 0 0 0 2px rgba(63, 185, 80, 0.25)) so shape/glow reinforces color.

Part 2: Architecture & Source Review
8. extension/lib.js Split & Selector Drift (src/ vs extension/)

Is extension/lib.js the right seam? Yes. Keeping lib.js 100% pure ESM functions (budgetState, nextLimitUntil, shouldSendReceipt, platformOfHost) with zero chrome.* or window references is why your new node test/run.js loop works cleanly without needing JSDOM or Puppeteer.

Eliminating Selector Drift: Duplicating DOM selectors between src/connectors/*.js (Node/CDP) and extension/content.js (MV3) will break—especially on ChatGPT and Gemini, which rotate CSS classes and contenteditable attributes frequently.

Clean Solution: Create a shared/ directory (e.g., shared/platforms.js and shared/selectors.js) containing pure data and pure functions (host matchers, echo-guard regexes, selector arrays, and DOM query helpers).

Node (src/) imports ../shared/selectors.js directly via ESM.

For the extension (since MV3 content scripts don't support top-level ESM import cleanly without a bundler or dynamic import(chrome.runtime.getURL(...))), either add a 15-line zero-dependency build/sync script (node scripts/sync-shared.js that copies shared/*.js into extension/vendor/ and exposes them via manifest.json web_accessible_resources) or load them via import(chrome.runtime.getURL('shared/selectors.js')). Both preserve your zero-dependency rule while giving you a single source of truth.

9. Goal State Machine (queued -> running -> done | failed)

Missing States: Yes, for the "web chat as brain, local agent as hands" workflow, a 4-state machine conflates execution completion with human acceptance. Right now, once the local agent writes a reply, the goal is done, even if the agent broke the build or misunderstood the prompt.

Recommended State Machine:

Plaintext
queued ──► running ──► delivered ──► accepted
              │            │
              ▼            └──► changes_requested ──► queued (re-run with feedback)
            failed


delivered: Agent finished and [wgb] Goal <id>: was posted back to the web chat (receipt confirmed).

accepted: User replied @wgb accept <id> (or clicked Accept in the popup/review UI)—triggers auto-commit, cleanup of data/inbox/goal_<id>.json, or unblocks dependent goals.

changes_requested: User replied @wgb revise <id> <notes>—appends the revision notes to the existing goal context and transitions back to queued without losing the original goal ID or history.

Also add submitted_unknown (or a deliveryStatus: 'confirmed' | 'unconfirmed' flag on delivered) to cleanly surface Invariant #3 in the UI when a reply might not have landed in the chat DOM.

10. Single Highest-Value Next Feature

Between image/file upload, per-project routing (#slug), goal-MCP mapping, and a one-click review WebUI:

Winner: Per-project routing (#slug) + allowedRoots map.

Why: Right now, wgb serve binds to a single working directory (or requires manual config edits when switching repos). In real usage, you are constantly bouncing between multiple repositories—whether it's a web platform, a C++ judge, or an open-source CLI tool—within the same browser session.

How it unlocks everything else:

Zero-friction context switching: Typing @wgb #timgiasu fix prisma schema or @wgb #knowns run tests in any chat tab routes the goal directly to that repo's cwd (validated against a projects: { slug: path } allowlist in config.json, preserving Invariant #6).

Foundation for the other candidates: Once every goal carries a projectSlug, Goal-MCP mapping (wgb exposing an MCP server so your local harness/opencode can pull tasks and push structured diffs directly instead of polling data/inbox/*.json) becomes trivial to scope per workspace, and a Review WebUI (127.0.0.1:8787/review/<goalId>) can render git diff straight from that project's root.

===== NEXT RESPONSE =====

Gemini đã nói

Here is the concrete implementation blueprint for the top audit recommendations—covering the popup CSS/HTML accessibility & contrast fixes, the shared selector module (zero-dependency), and the #slug per-project router + extended goal state machine.

1. Popup CSS & HTML Fixes (popup.html / popup.css)

Fixes WCAG AA contrast (#8b949e / #768390), constrains popup viewport width, differentiates the No Token vs. Offline server states, and strengthens the blocked (hết hạn mức) visual state:

CSS
:root {
  --bg: #0d1117;
  --card: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --dim: #8b949e;      /* ~5.8:1 on --card (passes WCAG AA) */
  --faint: #768390;    /* ~4.6:1 on --card (passes WCAG AA) */
  --green: #3fb950;
  --amber: #d29922;
  --red: #f85149;
}

body {
  width: 368px;
  min-height: 420px;
  margin: 0;
  padding: 12px;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* Server Status Pill States */
.status-pill[data-state="online"]  { color: var(--green); border-color: rgba(63, 185, 80, 0.4); }
.status-pill[data-state="no-auth"] { color: var(--amber); border-color: rgba(210, 153, 34, 0.5); cursor: pointer; }
.status-pill[data-state="offline"] { color: var(--red);   border-color: rgba(248, 81, 73, 0.4); }

/* Platform Card Severity States */
.platform-card[data-budget="near"] {
  border-color: rgba(210, 153, 34, 0.45);
}
.platform-card[data-budget="blocked"],
.platform-card[data-budget="cooldown"] {
  border-color: rgba(248, 81, 73, 0.6);
  background: rgba(248, 81, 73, 0.08);
}
.platform-card[data-budget="blocked"] .platform-name,
.platform-card[data-budget="cooldown"] .platform-name {
  opacity: 0.65;
}

/* Active Tab Dot Glow */
.live-dot[data-active="true"] {
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(63, 185, 80, 0.25);
}

Accessible Tab Markup & Interactive Empty State (popup.html)
HTML
<div class="tabs" role="tablist" aria-label="Chế độ xem">
  <button id="tab-monitor" role="tab" aria-selected="true" aria-controls="panel-monitor" tabindex="0">
    Giám sát
  </button>
  <button id="tab-config" role="tab" aria-selected="false" aria-controls="panel-config" tabindex="-1">
    Cấu hình
  </button>
</div>

<!-- Empty State inside Goals Card -->
<div class="empty-state" id="goals-empty">
  <div>Chưa có goal — gõ <button type="button" class="code-copy" data-copy="@wgb status">@wgb &lt;task&gt;</button> trong chat</div>
  <div class="empty-example">Ví dụ: <code>@wgb #app kiểm tra lỗi build</code></div>
</div>

2. Eliminating Selector Drift (shared/selectors.js)

To share selectors between Node (src/connectors/*.js) and the MV3 extension (extension/content.js) with zero external dependencies:

JavaScript
// shared/selectors.js — Single source of truth for DOM selectors & guards
export const PLATFORMS = {
  chatgpt: {
    hosts: ['chatgpt.com', 'chat.openai.com'],
    composer: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]'],
    sendBtn: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
    userTurn: ['[data-message-author-role="user"]', 'article[data-testid^="conversation-turn-"]'],
  },
  gemini: {
    hosts: ['gemini.google.com'],
    composer: ['rich-textarea div[contenteditable="true"]', '.ql-editor[contenteditable="true"]'],
    sendBtn: ['button.send-button', 'button[aria-label*="Send"]', 'button[aria-label*="Gửi"]'],
    userTurn: ['user-query', '.user-query-container'],
  },
  claude: {
    hosts: ['claude.ai'],
    composer: ['div[contenteditable="true"].ProseMirror', 'fieldset div[contenteditable="true"]'],
    sendBtn: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]'],
    userTurn: ['[data-testid="user-message"]', '.font-user-message'],
  },
};

export function queryFirst(root, selectorList) {
  for (const sel of selectorList) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}


In extension/manifest.json: Expose "web_accessible_resources": [{ "resources": ["shared/selectors.js"], "matches": ["[https://chatgpt.com/](https://chatgpt.com/)*", "[https://gemini.google.com/](https://gemini.google.com/)*", "[https://claude.ai/](https://claude.ai/)*"] }].

In extension/content.js: Load once at boot via const { PLATFORMS, queryFirst } = await import(chrome.runtime.getURL('shared/selectors.js'));.

In test/selectors.test.mjs: Import shared/selectors.js directly in Node to verify every platform defines non-empty hosts, composer, sendBtn, and userTurn arrays.

3. #slug Project Routing + Review State Machine (src/router.js)

Combines #slug routing (validated against allowedRoots / projects map) with the delivered -> accepted | changes_requested review commands in one parser:

JavaScript
// src/router.js
import path from 'node:path';

/**
 * Parses commands like:
 *   "@wgb #timgiasu fix prisma schema" -> { type: 'dispatch', slug: 'timgiasu', task: 'fix prisma schema' }
 *   "@wgb accept gmwqfya2e7skg"        -> { type: 'accept', goalId: 'gmwqfya2e7skg' }
 *   "@wgb revise gmwqfya2e7skg use UTC" -> { type: 'revise', goalId: 'gmwqfya2e7skg', notes: 'use UTC' }
 */
export function parseBridgeCommand(rawText, { defaultSlug = 'default', projects = {} } = {}) {
  const text = rawText.replace(/^@(?:wgb|bridge)\s+/i, '').trim();

  // 1. Review actions
  const acceptMatch = text.match(/^accept\s+([a-z0-9_-]+)$/i);
  if (acceptMatch) {
    return { type: 'accept', goalId: acceptMatch[1] };
  }

  const reviseMatch = text.match(/^revise\s+([a-z0-9_-]+)\s+([\s\S]+)$/i);
  if (reviseMatch) {
    return { type: 'revise', goalId: reviseMatch[1], notes: reviseMatch[2].trim() };
  }

  // 2. Dispatch with optional #slug
  const slugMatch = text.match(/^#([a-z0-9_-]+)\s+([\s\S]+)$/i);
  const slug = slugMatch ? slugMatch[1].toLowerCase() : defaultSlug;
  const task = slugMatch ? slugMatch[2].trim() : text;

  const cwd = projects[slug];
  if (!cwd) {
    return {
      type: 'error',
      reason: `Unknown project slug "#${slug}". Configured: ${Object.keys(projects).join(', ') || 'none'}`,
    };
  }

  return {
    type: 'dispatch',
    slug,
    cwd: path.resolve(cwd),
    task,
  };
}

Goal Store Transition Rules (src/store.js)
JavaScript
const VALID_TRANSITIONS = {
  queued:            ['running', 'failed'],
  running:           ['delivered', 'failed'],
  delivered:         ['accepted', 'changes_requested'],
  changes_requested: ['queued'],
  accepted:          [],
  failed:            ['queued'], // manual retry
};

export function transitionGoal(goal, nextStatus, meta = {}) {
  const allowed = VALID_TRANSITIONS[goal.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(`Invalid goal transition: ${goal.status} -> ${nextStatus}`);
  }
  return {
    ...goal,
    ...meta,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
    history: [...(goal.history || []), { from: goal.status, to: nextStatus, at: Date.now(), ...meta }],
  };
}

Recommended Rollout Order

Patch popup.css + popup.html (--dim/--faint contrast + No Token vs. Offline status pill) and re-capture over CDP :9222 to verify contrast and layout.

Extract shared/selectors.js and wire test/selectors.test.mjs into node test/run.js.

Add parseBridgeCommand + transitionGoal to src/ so @wgb #<slug> and @wgb accept|revise <id> work end-to-end from any chat tab.

Would you like to apply one of these patches directly to your repo files or start with a specific file?

===== NEXT RESPONSE =====

Gemini đã nói

Here is the remaining implementation kit for wgb-companion v1.9: the popup JS controller (popup.js wiring up the 3-state server pill, ARIA tabs, and click-to-copy goal rows), the test/selectors.test.mjs suite, and the HTTP server endpoints (src/serve.js) that connect #slug routing and accept / revise commands end-to-end.

1. Popup Controller (extension/popup.js)

Wires up the three-state server health check (Online / No Token / Offline), accessible tab keyboard navigation (ArrowLeft / ArrowRight), and click-to-copy goal IDs with transient feedback:

JavaScript
// extension/popup.js
const API_BASE = 'http://127.0.0.1:8787';

async function checkServerHealth(token) {
  const pill = document.getElementById('server-status');
  const label = pill.querySelector('.status-text');

  try {
    const res = await fetch(`${API_BASE}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });

    if (res.status === 401 || res.status === 403) {
      pill.dataset.state = 'no-auth';
      label.textContent = 'No Token';
      pill.title = 'Server đang chạy nhưng thiếu hoặc sai token — bấm để mở Cấu hình';
      pill.onclick = () => switchTab('config', { focusToken: true });
      return { ok: false, reason: 'auth' };
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    pill.dataset.state = 'online';
    label.textContent = 'Online';
    pill.title = 'Kết nối wgb serve (127.0.0.1:8787) ổn định';
    pill.onclick = null;
    return { ok: true };
  } catch {
    pill.dataset.state = 'offline';
    label.textContent = 'Offline';
    pill.title = 'Không kết nối được 127.0.0.1:8787 — hãy chạy: wgb serve';
    pill.onclick = null;
    return { ok: false, reason: 'offline' };
  }
}

function switchTab(tabName, { focusToken = false } = {}) {
  const tabs = document.querySelectorAll('[role="tab"]');
  tabs.forEach((tab) => {
    const isTarget = tab.id === `tab-${tabName}`;
    tab.setAttribute('aria-selected', String(isTarget));
    tab.tabIndex = isTarget ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !isTarget;
  });

  if (focusToken) {
    document.getElementById('input-token')?.focus();
  }
}

function bindTabKeyboardNav() {
  const tablist = document.querySelector('[role="tablist"]');
  tablist?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    if (current === -1) return;
    const next = (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  });
}

function bindCopyButtons(root = document) {
  root.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', async () => {
      const value = el.dataset.copy;
      await navigator.clipboard.writeText(value);
      const badge = el.querySelector('.copy-badge') || el;
      const prev = badge.textContent;
      badge.textContent = '✓ Copied';
      badge.classList.add('is-copied');
      setTimeout(() => {
        badge.textContent = prev;
        badge.classList.remove('is-copied');
      }, 1200);
    });
  });
}

2. Selector & Router Tests (test/selectors-and-router.test.mjs)

Plugs directly into your existing node test/run.js runner using Node's built-in node:test and node:assert/strict:

JavaScript
// test/selectors-and-router.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PLATFORMS } from '../shared/selectors.js';
import { parseBridgeCommand } from '../src/router.js';
import { transitionGoal } from '../src/store.js';

describe('shared/selectors.js integrity', () => {
  for (const [name, cfg] of Object.entries(PLATFORMS)) {
    it(`${name} defines non-empty hosts, composer, sendBtn, and userTurn`, () => {
      assert.ok(Array.isArray(cfg.hosts) && cfg.hosts.length > 0);
      assert.ok(Array.isArray(cfg.composer) && cfg.composer.length > 0);
      assert.ok(Array.isArray(cfg.sendBtn) && cfg.sendBtn.length > 0);
      assert.ok(Array.isArray(cfg.userTurn) && cfg.userTurn.length > 0);
    });
  }
});

describe('parseBridgeCommand (#slug + review verbs)', () => {
  const projects = {
    default: '/srv/repos/main',
    timgiasu: '/srv/repos/timgiasuthainguyen',
    knowns: '/srv/repos/knowns',
  };

  it('routes explicit #slug to configured project path', () => {
    const res = parseBridgeCommand('@wgb #timgiasu fix prisma migration', { projects });
    assert.equal(res.type, 'dispatch');
    assert.equal(res.slug, 'timgiasu');
    assert.equal(res.cwd, path.resolve('/srv/repos/timgiasuthainguyen'));
    assert.equal(res.task, 'fix prisma migration');
  });

  it('falls back to default project when no #slug is provided', () => {
    const res = parseBridgeCommand('@wgb status', { projects });
    assert.equal(res.type, 'dispatch');
    assert.equal(res.slug, 'default');
    assert.equal(res.task, 'status');
  });

  it('rejects unknown #slug values safely', () => {
    const res = parseBridgeCommand('@wgb #unknown rm -rf', { projects });
    assert.equal(res.type, 'error');
    assert.match(res.reason, /Unknown project slug "#unknown"/);
  });

  it('parses accept and revise review commands', () => {
    assert.deepEqual(parseBridgeCommand('@wgb accept gmwqfya2e7skg', { projects }), {
      type: 'accept',
      goalId: 'gmwqfya2e7skg',
    });

    assert.deepEqual(parseBridgeCommand('@wgb revise gmwqfya2e7skg add unit tests', { projects }), {
      type: 'revise',
      goalId: 'gmwqfya2e7skg',
      notes: 'add unit tests',
    });
  });
});

describe('transitionGoal state machine', () => {
  it('supports delivered -> changes_requested -> queued -> delivered -> accepted', () => {
    let g = { id: 'g1', status: 'queued' };
    g = transitionGoal(g, 'running');
    g = transitionGoal(g, 'delivered');
    g = transitionGoal(g, 'changes_requested', { notes: 'fix lint' });
    g = transitionGoal(g, 'queued');
    g = transitionGoal(g, 'running');
    g = transitionGoal(g, 'delivered');
    g = transitionGoal(g, 'accepted');
    assert.equal(g.status, 'accepted');
    assert.equal(g.history.length, 7);
  });

  it('blocks illegal jumps like queued -> accepted', () => {
    assert.throws(
      () => transitionGoal({ id: 'g1', status: 'queued' }, 'accepted'),
      /Invalid goal transition/
    );
  });
});

3. Control-Plane Dispatch Integration (src/serve.js)

Connects incoming POST /goals payloads from the extension (@wgb ...) to parseBridgeCommand + securityGate before enqueuing:

JavaScript
// Inside POST /goals handler in src/serve.js
const parsed = parseBridgeCommand(body.rawText, {
  defaultSlug: config.defaultProject || 'default',
  projects: config.projects || { default: config.cwd },
});

if (parsed.type === 'error') {
  return sendJson(res, 400, { ok: false, error: parsed.reason });
}

if (parsed.type === 'accept') {
  const updated = store.update(parsed.goalId, (g) => transitionGoal(g, 'accepted'));
  auditEvent({ type: 'goal.accepted', goalId: parsed.goalId });
  return sendJson(res, 200, { ok: true, goal: updated });
}

if (parsed.type === 'revise') {
  const updated = store.update(parsed.goalId, (g) => {
    const rev = transitionGoal(g, 'changes_requested', { notes: parsed.notes });
    return transitionGoal(rev, 'queued', {
      task: `${g.task}\n\n[Revision notes]: ${parsed.notes}`,
    });
  });
  auditEvent({ type: 'goal.revised', goalId: parsed.goalId, notes: parsed.notes });
  return sendJson(res, 200, { ok: true, goal: updated });
}

// parsed.type === 'dispatch'
const sec = checkSecurityGate(parsed.task, parsed.cwd, Object.values(config.projects || {}));
if (!sec.allowed) {
  auditEvent({ type: 'goal.blocked', reason: sec.reason, slug: parsed.slug });
  return sendJson(res, 403, { ok: false, error: sec.reason });
}

const goal = store.create({
  slug: parsed.slug,
  cwd: parsed.cwd,
  task: parsed.task,
  platform: body.platform,
});
return sendJson(res, 201, { ok: true, goal });

Summary of v1.9 Config Addition (config.json)
JSON
{
  "defaultProject": "default",
  "projects": {
    "default": "/path/to/webchat-goal-bridge",
    "timgiasu": "/path/to/timgiasuthainguyen",
    "knowns": "/path/to/knowns"
  }
}


This keeps allowedRoots strictly derived from Object.values(config.projects) so a prompt in a web tab can never escape into arbitrary directories on disk.