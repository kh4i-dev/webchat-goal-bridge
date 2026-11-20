// Goal store — 1 viec moi tu chat web <-> 1 goal. State machine:
// queued -> running -> done | failed ; (nghiem thu P1: delivered -> accepted | changes_requested)

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { log } from '../util/log.js';

const filePath = () => path.join(dataDir(), 'goals.json');

export function loadGoals() {
  const p = filePath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log('goals', 'goals.json loi parse, backup va de trong:', err.message);
    try { fs.copyFileSync(p, p + '.bad-' + Date.now()); } catch { /* noop */ }
    return [];
  }
}

export function saveGoals(goals) {
  fs.writeFileSync(filePath(), JSON.stringify(goals, null, 2));
}

export function createGoal({ platform, chatUrl, task, runner }) {
  const goals = loadGoals();
  const goal = {
    id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    platform,
    chatUrl,
    task,
    runner,
    status: 'queued',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null
  };
  goals.push(goal);
  saveGoals(goals);
  log('goals', 'tao goal', goal.id, '—', task.slice(0, 60));
  return goal;
}

export function updateGoal(id, patch) {
  const goals = loadGoals();
  const g = goals.find((x) => x.id === id);
  if (!g) return null;
  Object.assign(g, patch);
  saveGoals(goals);
  return g;
}

export function summary() {
  const goals = loadGoals();
  if (!goals.length) return '(chua co goal nao)';
  return goals
    .slice(-10)
    .map((g) => `${g.id} [${g.status}] ${g.task.slice(0, 60)}`)
    .join('\n');
}
