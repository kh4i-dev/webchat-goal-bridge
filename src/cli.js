#!/usr/bin/env node
// webchat-goal-bridge CLI — zero dependency.
// Logs go to stderr; data (and --json output) go to stdout.

import { loadConfig, projectRoot, dataDir } from './config.js';
import { log, initFileLog } from './util/log.js';
import { ensureOn, ensureOff, cdpStatus, braveProcessCount } from './cdp/browser.js';
import { listTargets, findPageTargets, newTarget, attach, activateTarget } from './cdp/client.js';
import { PLATFORM_HOSTS, homeUrl, knownPlatform } from './connectors/base.js';
import chatgpt from './connectors/chatgpt.js';
import gemini from './connectors/gemini.js';
import { createGoal, updateGoal, loadGoals, summary } from './core/goals.js';
import { runTask, listRunners } from './runners/index.js';

const CONNECTORS = { chatgpt, gemini };

const HELP = `
webchat-goal-bridge (wgb) — cau noi chat web <-> harness, goal loop, nghiem thu

Cach dung: node src/cli.js <command> [flags]

  brave on|off|status     Quan ly Brave + CDP port (tam thoi; off = dong port, nap lai binh thuong)
  tabs [--url <substr>]   Liet ke tab dang mo trong Brave (qua CDP)
  probe --platform <p>    Kiem tra da login chua + trang thai page
  read --platform <p>     Doc cac tin nhan gan nhat (--last N, mac 10)
  send --platform <p> --text "..."   Gui 1 tin nhan va cho reply
  watch --platform <p>    Vong lap: cho tin nhan moi co trigger -> tao goal -> chay runner -> tra ket qua
                          flags: --once (1 vong), --catchup (xu ly tin @bridge dang ton tai), --trigger "@bridge"
  goals [--short]         Xem goal store
  runners                 Liet ke runner co san (echo, exec, opencode)
  config path             In duong dan config

Platform: chatgpt, gemini. Flags chung: --json, --url <substr>, --last N
`.trim();

function parseArgs(argv) {
  const cmd = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      cmd.push(a);
    }
  }
  return { cmd, flags };
}

function out(data, flags) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- platform resolution ----

async function resolvePlatform(cfg, flags) {
  const platform = flags.platform || 'chatgpt';
  if (!knownPlatform(platform)) throw new Error('Platform khong ho tro: ' + platform);
  const connector = CONNECTORS[platform];
  if (!connector) throw new Error('Connector chua duoc trien khai cho: ' + platform);

  const port = cfg.brave.cdpPort;
  const hosts = PLATFORM_HOSTS[platform];
  let pages = [];
  for (const h of hosts) pages = pages.concat(await findPageTargets(port, h));

  let target = null;
  if (flags.new) {
    log('platform', `mo chat moi: ${homeUrl(cfg, platform)}`);
    target = await newTarget(port, homeUrl(cfg, platform));
    await sleep(2000);
  } else if (flags.url) {
    target = pages.find((t) => (t.url || '').includes(flags.url)) || null;
    if (!target) throw new Error(`Khong co tab nao khop --url "${flags.url}"`);
  } else {
    target = connector.pickTarget(pages);
  }
  if (!target) {
    log('platform', `mo tab moi: ${homeUrl(cfg, platform)}`);
    target = await newTarget(port, homeUrl(cfg, platform));
    await sleep(1500);
  }

  // Tab o nen co the bi frozen — bat buoc activate truoc khi attach/evaluate.
  await activateTarget(port, target.id);

  // Fresh tabs may not expose a debugger socket immediately — retry attach.
  let conn = null;
  for (let i = 0; i < 5 && !conn; i++) {
    try {
      conn = await attach(target);
    } catch (err) {
      log('platform', `attach retry ${i + 1}: ${err.message}`);
      await sleep(1000);
      const fresh = await findPageTargets(port, hosts[0]);
      target = fresh.find((t) => t.id === target?.id) || fresh[0] || target;
    }
  }
  if (!conn) throw new Error('Khong attach duoc CDP vao tab: ' + (target?.url || '?'));

  const ready = await connector.waitForReady(conn);
  return { platform, connector, target, conn, ready };
}

// ---- commands ----

async function cmdBrave(cfg, flags, action) {
  if (!action || !['on', 'off', 'status'].includes(action)) throw new Error('brave on|off|status');
  if (action === 'on') out(await ensureOn(cfg.brave, log), flags);
  else if (action === 'off') out(await ensureOff(cfg.brave, log), flags);
  else {
    const st = await cdpStatus(cfg.brave.cdpPort);
    out({ cdp: st, braveProcesses: await braveProcessCount(), cdpPort: cfg.brave.cdpPort }, flags);
  }
}

async function cmdTabs(cfg, flags) {
  const targets = await findPageTargets(cfg.brave.cdpPort, flags.url);
  out(targets.map((t) => ({ id: t.id, title: t.title, url: t.url })), flags);
}

async function cmdProbe(cfg, flags) {
  const ctx = await resolvePlatform(cfg, flags);
  try {
    out({ ...ctx.ready, tabTitle: ctx.target.title, tabUrl: ctx.target.url }, flags);
  } finally {
    ctx.conn.close();
  }
}

async function cmdRead(cfg, flags) {
  const ctx = await resolvePlatform(cfg, flags);
  try {
    const msgs = await ctx.connector.readMessages(ctx.conn);
    const last = Number(flags.last || 10);
    out(msgs.slice(-last), flags);
  } finally {
    ctx.conn.close();
  }
}

async function cmdSend(cfg, flags) {
  if (!flags.text) throw new Error('thieu --text "..."');
  const ctx = await resolvePlatform(cfg, flags);
  try {
    const baseline = (await ctx.connector.readMessages(ctx.conn)).filter((m) => m.role === 'assistant').length;
    const sent = await ctx.connector.send(ctx.conn, String(flags.text));
    if (!sent.ok) throw new Error('Gui that bai: ' + JSON.stringify(sent));
    log('send', `da gui (${sent.via}, submitted=${sent.submitted}) — doi reply...`);
    const replies = await ctx.connector.waitForReply(ctx.conn, {
      baselineCount: baseline,
      timeoutMs: cfg.replyTimeoutMs
    });
    const reply = replies.length ? replies[replies.length - 1].text : null;
    if (flags.json) out({ sent, reply }, flags);
    else out(reply || '(khong co assistant moi)', flags);
  } finally {
    ctx.conn.close();
  }
}

// ---- goal loop (watch) ----

/** Gui ket qua ve chat: cho page idle, prefix [wgb], cat 12k. */
async function sendResultSafe(cfg, ctx, text) {
  for (let i = 0; i < 20 && (await ctx.connector.isGenerating(ctx.conn)); i++) {
    await sleep(2000);
  }
  const msg = `${cfg.replyPrefix} ${text}`.slice(0, 12000);
  const sent = await ctx.connector.send(ctx.conn, msg);
  log('watch', 'da tra ket qua:', JSON.stringify({ submitted: sent.submitted || sent.ok, via: sent.via }));
  return sent;
}

async function handleTask(cfg, ctx, task) {
  if (!task) return null;
  if (/^status$/i.test(task)) {
    await sendResultSafe(cfg, ctx, `Goals gan nhat:\n${summary()}`);
    return { kind: 'status' };
  }
  const goal = createGoal({ platform: ctx.platform, chatUrl: ctx.target.url, task, runner: cfg.runner.type });
  updateGoal(goal.id, { status: 'running' });
  let result;
  try {
    result = await runTask(task, cfg, log);
    updateGoal(goal.id, { status: 'done', finishedAt: new Date().toISOString(), result: result.text });
  } catch (err) {
    updateGoal(goal.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: String(err.message || err)
    });
    result = { text: `LOI: ${err.message || err}` };
  }
  const delivered = await sendResultSafe(cfg, ctx, `Goal ${goal.id} (${cfg.runner.type}):\n${result.text}`);
  return { kind: 'goal', goalId: goal.id, status: 'done', delivered: delivered.submitted || delivered.ok };
}

async function cmdWatch(cfg, flags) {
  const once = Boolean(flags.once);
  const trigger = String(flags.trigger || cfg.trigger);
  const ctx = await resolvePlatform(cfg, flags);
  let lastSeenId = null;
  let firstPass = true;
  let consecutiveErrors = 0;
  const handled = [];
  log('watch', `bat dau xem ${ctx.platform} — trigger "${trigger}", runner "${cfg.runner.type}", poll ${cfg.pollMs}ms`);
  try {
    do {
      try {
        const msgs = await ctx.connector.readMessages(ctx.conn);
        consecutiveErrors = 0;
        const users = msgs.filter((m) => m.role === 'user' && !m.text.startsWith(cfg.replyPrefix));
        const lastUser = users[users.length - 1] || null;
        if (firstPass) {
          lastSeenId = lastUser ? lastUser.id : null;
          firstPass = false;
          log('watch', 'baseline:', lastUser ? lastUser.text.slice(0, 60) : '(khong co tin user)');
          if (flags.catchup && lastUser && lastUser.text.startsWith(trigger)) {
            lastSeenId = null; // xu ly ngay tin @bridge dang ton tai
          }
        }
        if (lastUser && lastUser.id !== lastSeenId) {
          if (lastUser.text.startsWith(trigger)) {
            lastSeenId = lastUser.id;
            const task = lastUser.text.slice(trigger.length).trim();
            log('watch', 'nhan viec moi:', task.slice(0, 80));
            handled.push(await handleTask(cfg, ctx, task));
          } else {
            lastSeenId = lastUser.id;
          }
        }
      } catch (err) {
        consecutiveErrors++;
        log('watch', `loop error (${consecutiveErrors}):`, err.message);
        if (consecutiveErrors >= 5) throw new Error('Loop error lien tuc 5 lan — dung watch (tab co the da dong).');
      }
      if (!once) await sleep(cfg.pollMs);
    } while (!once);
  } finally {
    ctx.conn.close();
  }
  if (flags.json) out({ handled }, flags);
}

async function cmdGoals(cfg, flags) {
  const goals = loadGoals();
  if (flags.json || !flags.short) return out(goals, flags);
  out(
    goals.map((g) => `${g.id} [${g.status}] (${g.runner}) ${g.task.slice(0, 70)}`).join('\n') || '(trong)',
    flags
  );
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd.length === 0 || cmd[0] === 'help' || flags.help) {
    console.log(HELP);
    return;
  }
  initFileLog(dataDir());
  const cfg = loadConfig();
  log('cli', 'command:', cmd.join(' '));

  const [head, sub] = cmd;
  switch (head) {
    case 'brave':
      return cmdBrave(cfg, flags, sub);
    case 'tabs':
      return cmdTabs(cfg, flags);
    case 'probe':
      return cmdProbe(cfg, flags);
    case 'read':
      return cmdRead(cfg, flags);
    case 'send':
      return cmdSend(cfg, flags);
    case 'watch':
      return cmdWatch(cfg, flags);
    case 'goals':
      return cmdGoals(cfg, flags);
    case 'runners':
      return out(listRunners(), flags);
    case 'config':
      return out({ config: projectRoot() + '\\config.json', root: projectRoot() }, flags);
    default:
      throw new Error(`Lenh chua duoc trien khai trong slice nay: ${head} (xem help)`);
  }
}

main().catch((err) => {
  log('error', err.stack || err.message || String(err));
  process.exitCode = 1;
});
