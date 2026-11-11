import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const viewOncePath = path.join(config.diagnosticsDir, 'view-once.jsonl');
const deletionsPath = path.join(config.diagnosticsDir, 'deletions.jsonl');

function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

export function logViewOnce(entry) {
  appendLine(viewOncePath, { timestamp: new Date().toISOString(), ...entry });
}

export function logDeletion(entry) {
  appendLine(deletionsPath, { timestamp: new Date().toISOString(), ...entry });
}
