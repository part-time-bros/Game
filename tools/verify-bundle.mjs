/**
 * verify-bundle.mjs — fast boot check for the shipped builds.
 *
 * The module build and the single-file bundle can diverge (the bundler strips
 * imports, so anything import-shaped that survives into a name is a hazard).
 * A broken bundle has already shipped once; this runs in ~20s and is meant to
 * gate every publish.
 *
 *   node tools/verify-bundle.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8217;

const IGNORE = /fonts\.(googleapis|gstatic)\.com|net::ERR_/;

async function checkPage(page, url, label, results) {
  const errors = [];
  const onErr = (e) => errors.push(String(e.message || e));
  const onConsole = (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); };
  page.on('pageerror', onErr);
  page.on('console', onConsole);

  let booted = false;
  let detail = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 45000 });
    // boot is not enough: drive a few seconds of real gameplay
    const stats = await page.evaluate(() => {
      const N = window.__NOVA;
      N.start('striker', 'pilot', 'campaign', 1);
      N.skipCinematic();
      N.setInput({ move: { x: 1, z: 0 }, fire: true, aim: { x: 0, z: -1 } });
      N.step(1 / 60, 600);
      N.clearInput();
      N.render();
      return N.stats();
    });
    booted = stats.state === 'playing' && Number.isFinite(stats.score);
    detail = `wave ${stats.wave}, ${stats.enemies} hostiles, ${stats.render.calls} draws`;
  } catch (e) {
    detail = e.message.split('\n')[0];
  }
  page.off('pageerror', onErr);
  page.off('console', onConsole);

  const ok = booted && errors.length === 0;
  results.push({ label, ok, detail, errors });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  for (const e of errors.slice(0, 3)) console.log(`      ! ${e.slice(0, 160)}`);
  return ok;
}

async function main() {
  // reproduce the Artifact host's wrapper for the artifact-shaped build
  const content = readFileSync(join(ROOT, 'dist', 'nova-lance.artifact.html'), 'utf8');
  writeFileSync(join(ROOT, 'dist', '.artifact-preview.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
${content}
</body></html>`);

  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  await ctx.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await ctx.route('**/fonts.gstatic.com/**', (r) => r.abort());
  await ctx.route('**cdnjs.cloudflare.com/**/three.min.js', (r) =>
    r.fulfill({ path: join(ROOT, 'vendor', 'three.min.js'), contentType: 'text/javascript' }));

  console.log('\n\x1b[1mBUNDLE VERIFICATION\x1b[0m');
  const results = [];
  for (const [label, path] of [
    ['module build (index.html)', 'index.html'],
    ['single file (dist/nova-lance.html)', 'dist/nova-lance.html'],
    ['artifact build (host-wrapped)', 'dist/.artifact-preview.html'],
  ]) {
    const page = await ctx.newPage();
    await checkPage(page, `http://localhost:${PORT}/${path}`, label, results);
    await page.close();
  }

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed}/${results.length} builds boot and play\n`);
  process.exit(failed ? 1 : 0);
}
main();
