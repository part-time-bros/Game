/** Syntax-check every source module (ESM aware). Run: node tools/check.mjs */
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})('src');

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad++;
    console.error(`✗ ${f}\n${err.stderr.toString().split('\n').slice(0, 6).join('\n')}`);
  }
}
console.log(bad ? `${bad} file(s) with syntax errors` : `✓ ${files.length} modules parse cleanly`);
process.exit(bad ? 1 : 0);
