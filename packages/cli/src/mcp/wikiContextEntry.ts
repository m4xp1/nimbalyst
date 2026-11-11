import { readFileSync } from 'node:fs';
import { runHook } from '../commands/hook.js';
console.log = console.error;
const verb = process.argv[2] === 'stop' ? 'stop' : 'session-start';
let text = '';
try { text = readFileSync(0, 'utf8'); } catch { /* a hook without stdin may still use its environment */ }
const line = await runHook(verb, text);
if (line) process.stdout.write(`${line}\n`);
