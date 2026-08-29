/**
 * Syntax-check every source module, then check that every named import
 * actually resolves to an export. `node --check` parses a file in isolation
 * and is blind to cross-module breakage: dropping an `export` keyword during a
 * refactor parses fine and only fails in the browser at load time.
 *
 * Run: node tools/check.mjs
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

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

// ---- cross-module: does every named import exist at the other end? ----
const exportsOf = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const n of m[1].split(',')) {
      const t = n.trim().split(/\s+as\s+/).pop().trim();
      if (t) names.add(t);
    }
  }
  exportsOf.set(resolve(f), names);
}
let broken = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!m[2].startsWith('.')) continue;
    const target = resolve(dirname(resolve(f)), m[2]);
    const have = exportsOf.get(target);
    if (!have) { console.error(`✗ ${f}: cannot resolve ${m[2]}`); broken++; continue; }
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/)[0].trim();
      if (n && !have.has(n)) { console.error(`✗ ${f}: imports "${n}", which ${m[2]} does not export`); broken++; }
    }
  }
}
console.log(broken ? `${broken} broken import(s)` : '✓ every named import resolves');
process.exit(bad || broken ? 1 : 0);
