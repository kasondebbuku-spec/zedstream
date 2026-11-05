// Saves your Lipila API key into .env without showing it on screen.
// Usage: npm run set-key
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(1); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        value += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

const key = (await askHidden('Paste your Lipila API key (lsk_... or lpk_...) and press Enter: ')).trim().replace(/^['"]|['"]$/g, '');
if (!/^(lsk|lpk)_\S+$/.test(key)) {
  console.error('That does not look like a Lipila key (it should start with lsk_ or lpk_). Nothing was saved.');
  process.exit(1);
}

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const setLine = (name, value) => {
  const re = new RegExp(`^${name}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
};
setLine('LIPILA_API_KEY', key);
setLine('LIPILA_MODE', key.startsWith('lpk_') ? 'live' : 'sandbox');
fs.writeFileSync(envPath, env);
console.log(`Saved. Payment mode is now: ${key.startsWith('lpk_') ? 'LIVE (real money)' : 'sandbox (test money)'}.`);
