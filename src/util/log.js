import fs from 'node:fs';
import path from 'node:path';

let fileStream = null;

export function initFileLog(dataRoot) {
  const dir = path.join(dataRoot, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wgb-${new Date().toISOString().slice(0, 10)}.log`);
  fileStream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

export function log(tag, ...args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.map(String).join(' ')}`;
  console.error(line);
  if (fileStream) fileStream.write(line + '\n');
}
