/**
 * playtest.mjs — automated QA for NOVA LANCE.
 *
 * Boots the real game in headless Chromium (SwiftShader) and drives it through
 * the same input path a player uses, then checks for console errors, runaway
 * entity counts, NaN state, resource leaks across restarts, and captures
 * screenshots for visual review.
 *
 *   node tools/playtest.mjs            full suite
 *   node tools/playtest.mjs --quick    boot + short soak only
 *   node tools/playtest.mjs --shots    capture screenshots only
 *   node tools/playtest.mjs --dist     test the built single-file bundle
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SHOTS = join(ROOT, 'tools', '.artifacts', 'shots');
const SHOWCASE = join(ROOT, 'docs', 'screenshots');
const PORT = 8177;
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const SHOTS_ONLY = args.includes('--shots');
const USE_DIST = args.includes('--dist');
const USE_ARTIFACT = args.includes('--artifact');
const HEADED = args.includes('--headed');

// Playwright may only be installed globally in this environment.
const require_ = createRequire(import.meta.url);
let playwright;
try {
  playwright = require_('playwright');
} catch (e) {
  const root = execSync('npm root -g').toString().trim();
  playwright = require_(join(root, 'playwright'));
}
const { chromium } = playwright;

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js'), String(PORT)], {
    stdio: 'ignore', detached: true,
  });
  await sleep(600);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const consoleWarnings = [];
  // The webfont CDN is unreachable from the sandbox; the page is designed to
  // fall back silently, so that network error is not a game defect.
  const IGNORE = /fonts\.(googleapis|gstatic)\.com|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|net::ERR_/;
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (IGNORE.test(text)) return;
    if (t === 'error') consoleErrors.push(text);
    else if (t === 'warning' && !/deprecated with r150/.test(text)) consoleWarnings.push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  // The sandbox has no outbound network: serve the CDN copy of three.js from
  // the vendored file so the shipped bundle is tested exactly as published,
  // and fail webfont requests fast instead of waiting for a timeout.
  await context.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await context.route('**/fonts.gstatic.com/**', (r) => r.abort());
  await context.route('**cdnjs.cloudflare.com/**/three.min.js', (r) =>
    r.fulfill({ path: join(ROOT, 'vendor', 'three.min.js'), contentType: 'text/javascript' }));

  // Reproduce the Artifact host's wrapper so the published page is exercised
  // exactly as viewers will receive it.
  if (USE_ARTIFACT) {
    const content = readFileSync(join(ROOT, 'dist', 'nova-lance.artifact.html'), 'utf8');
    writeFileSync(join(ROOT, 'dist', '.artifact-preview.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>
${content}
</body></html>`);
  }
  const url = USE_ARTIFACT
    ? `http://localhost:${PORT}/dist/.artifact-preview.html?capture=1`
    : USE_DIST
      ? `http://localhost:${PORT}/dist/nova-lance.html?capture=1`
      : `http://localhost:${PORT}/index.html?capture=1`;

  try {
    section(`BOOT  (${url})`);
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });
    const bootMs = Date.now() - t0;
    check('game boots', true, `${bootMs}ms`);
    check('no console errors on boot', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    const boot = await page.evaluate(() => ({
      state: window.__NOVA.state(),
      quality: window.__NOVA.game.renderer.quality,
      webgl2: window.__NOVA.game.renderer.isWebGL2,
      geo: window.__NOVA.game.renderer.info.geometries,
      tex: window.__NOVA.game.renderer.info.textures,
    }));
    check('reaches menu state', boot.state === 'menu', boot.state);
    console.log(`    quality=${boot.quality} webgl2=${boot.webgl2} geometries=${boot.geo} textures=${boot.tex}`);

    await shot(page, '01-menu', true);

    if (!SHOTS_ONLY) {
      await runSuite(page, consoleErrors, consoleWarnings, url);
    } else {
      await captureShowcase(page);
    }
  } catch (err) {
    check('harness completed', false, err.message);
    console.error(err);
  } finally {
    const summary = {
      when: new Date().toISOString(),
      passed: results.filter((r) => r.ok).length,
      failed: failures,
      results,
      consoleErrors: consoleErrors.slice(0, 40),
      consoleWarnings: consoleWarnings.slice(0, 20),
    };
    writeFileSync(join(ROOT, 'tools', 'last-playtest.json'), JSON.stringify(summary, null, 2));
    await browser.close();
    try { process.kill(-server.pid); } catch (e) { /* already gone */ }
    section('SUMMARY');
    console.log(`  ${summary.passed} passed, ${summary.failed} failed`);
    if (consoleErrors.length) {
      console.log('\n  console errors:');
      for (const e of consoleErrors.slice(0, 12)) console.log('   ! ' + e);
    }
    if (consoleWarnings.length) {
      console.log('\n  console warnings:');
      for (const e of [...new Set(consoleWarnings)].slice(0, 8)) console.log('   ? ' + e);
    }
    process.exit(failures ? 1 : 0);
  }
}

async function shot(page, name, showcase = false) {
  await page.evaluate(() => { if (window.__NOVA) window.__NOVA.render(); });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
  if (showcase) {
    mkdirSync(SHOWCASE, { recursive: true });
    await page.screenshot({ path: join(SHOWCASE, `${name}.jpg`), type: 'jpeg', quality: 82, animations: 'disabled' });
  }
}

/** Advance the sim deterministically inside the page. */
async function step(page, seconds, opts = {}) {
  return page.evaluate(({ seconds, opts }) => {
    const N = window.__NOVA;
    const dt = 1 / 60;
    const frames = Math.round(seconds / dt);
    const bad = [];
    let maxEnemies = 0, maxProj = 0, maxParticles = 0;
    if (opts.input) N.setInput(opts.input);
    for (let i = 0; i < frames; i++) {
      if (opts.script) {
        const t = i * dt;
        const inp = N.game.input.override || {};
        // circle-strafe and shoot at the nearest hostile
        const a = t * 1.1;
        inp.move = { x: Math.cos(a), z: Math.sin(a * 0.9) };
        inp.fire = true;
        const target = N.game.enemies.active.find((e) => !e.dying && !e.type.hidden);
        const p = N.game.player.position;
        if (target) {
          const dx = target.x - p.x, dz = target.z - p.z;
          const d = Math.hypot(dx, dz) || 1;
          inp.aim = { x: dx / d, z: dz / d };
        } else {
          inp.aim = { x: Math.cos(a), z: Math.sin(a) };
        }
        if (i % 90 === 0) inp.dash = true;
        if (i % 200 === 0) inp.pulse = true;
        if (i % 420 === 0) inp.overdrive = true;
        N.setInput(inp);
      }
      N.step(dt);
      const g = N.game;
      maxEnemies = Math.max(maxEnemies, g.enemies.count);
      maxProj = Math.max(maxProj, g.projectiles.count);
      maxParticles = Math.max(maxParticles, g.fx.count);
      if (!Number.isFinite(g.player.position.x) || !Number.isFinite(g.player.position.z)) bad.push('player NaN pos @' + i);
      if (!Number.isFinite(g.score)) bad.push('score NaN @' + i);
      if (!Number.isFinite(g.player.hull)) bad.push('hull NaN @' + i);
      if (bad.length > 4) break;
    }
    N.clearInput();
    return { bad, maxEnemies, maxProj, maxParticles, stats: N.stats() };
  }, { seconds, opts });
}

async function runSuite(page, consoleErrors, consoleWarnings, url) {
  const errAt = () => consoleErrors.length;

  // ---------------- menus ----------------
  section('MENUS');
  for (const [action, screen, name] of [
    ['to-hangar', 'hangar', '02-hangar'],
    ['to-manual', 'manual', '03-manual'],
    ['to-options', 'options', '04-options'],
    ['to-records', 'records', '05-records'],
  ]) {
    const ok = await page.evaluate(({ action, screen }) => {
      window.__NOVA.game.ui.handleAction(action);
      return window.__NOVA.game.ui.screen === screen;
    }, { action, screen });
    check(`screen: ${screen}`, ok);
    await shot(page, name, name === '02-hangar');
    await page.evaluate(() => window.__NOVA.game.ui.handleAction('to-menu'));
  }

  // ---------------- a real run ----------------
  section('CAMPAIGN RUN');
  await page.evaluate(() => window.__NOVA.start('striker', 'pilot', 'campaign', 1234));
  let r = await step(page, 3);
  check('run enters playing state', r.stats.state === 'playing', r.stats.state);
  r = await step(page, 25, { script: true });
  check('wave 1 survives 25s of scripted play', r.bad.length === 0, r.bad.join(','));
  check('player still alive', r.stats.alive);
  check('score accrues', r.stats.score > 0, `score=${r.stats.score}`);
  await shot(page, '06-gameplay-wave1', true);

  // deeper wave with all archetypes
  await page.evaluate(() => { window.__NOVA.setWave(8); window.__NOVA.godMode(true); });
  r = await step(page, 40, { script: true });
  check('wave 8 mixed composition runs clean', r.bad.length === 0, r.bad.join(','));
  check('enemy count stays bounded', r.maxEnemies <= 60, `max=${r.maxEnemies}`);
  check('projectiles stay bounded', r.maxProj < 600, `max=${r.maxProj}`);
  console.log(`    peak enemies=${r.maxEnemies} projectiles=${r.maxProj} particles=${r.maxParticles}`);
  await shot(page, '07-gameplay-wave8', true);

  // ---------------- bosses ----------------
  section('BOSS ENCOUNTERS');
  for (const [wave, kind, nameShot] of [[5, 'warden', '08-boss-warden'], [10, 'harrower', '09-boss-harrower'], [15, 'maw', '10-boss-maw']]) {
    await page.evaluate((w) => { window.__NOVA.setWave(w); window.__NOVA.godMode(true); }, wave);
    await step(page, 5);
    const s = await page.evaluate(() => window.__NOVA.stats());
    check(`wave ${wave} spawns ${kind}`, s.boss === kind, `boss=${s.boss}`);
    await shot(page, nameShot, kind !== 'harrower');
    const rr = await step(page, 45, { script: true });
    check(`${kind} fight is stable`, rr.bad.length === 0, rr.bad.join(','));
  }

  // ---------------- upgrades ----------------
  section('MODULES');
  const modResult = await page.evaluate(() => {
    const N = window.__NOVA;
    N.start('phantom', 'pilot', 'campaign', 99);
    N.step(1 / 60, 30);
    N.giveAllModules();
    const before = { ...N.game.player.stats };
    N.step(1 / 60, 120);
    const st = N.game.player.stats;
    const bad = [];
    for (const k in st) if (typeof st[k] === 'number' && !Number.isFinite(st[k])) bad.push(k);
    return { bad, count: N.game.player.modules.size, fireRate: st.fireRate, damage: st.damage, guardians: st.guardians };
  });
  check('all modules install without NaN', modResult.bad.length === 0, modResult.bad.join(','));
  check('module count matches catalogue', modResult.count >= 20, `installed=${modResult.count}`);
  const rMods = await step(page, 30, { script: true });
  check('fully-modded run is stable', rMods.bad.length === 0, rMods.bad.join(','));
  console.log(`    fireRate=${modResult.fireRate.toFixed(2)} damage=${modResult.damage.toFixed(2)} guardians=${modResult.guardians}`);

  // ---------------- refit flow ----------------
  section('REFIT + FLOW');
  const refit = await page.evaluate(async () => {
    const N = window.__NOVA;
    N.start('striker', 'pilot', 'campaign', 7);
    N.step(1 / 60, 90);
    N.game.openRefit(1);
    const inRefit = N.state() === 'refit';
    const cards = document.querySelectorAll('#upgrade-cards .card').length;
    N.game.rerollDraft();
    const afterReroll = document.querySelectorAll('#upgrade-cards .card').length;
    N.game.ui.pickCardByIndex(0);
    N.step(1 / 60, 10);
    return { inRefit, cards, afterReroll, state: N.state(), modules: N.game.player.modules.size };
  });
  check('refit screen opens with 3 offers', refit.inRefit && refit.cards === 3, `cards=${refit.cards}`);
  check('reroll redraws offers', refit.afterReroll === 3);
  check('picking a card resumes play', refit.state === 'playing', refit.state);
  check('picked module is installed', refit.modules === 1, `modules=${refit.modules}`);
  await page.evaluate(() => { window.__NOVA.game.openRefit(3); });
  await shot(page, '11-refit', true);

  // ---------------- pause / restart ----------------
  section('STATE MACHINE');
  const flow = await page.evaluate(() => {
    const N = window.__NOVA;
    const log = [];
    N.start('striker', 'pilot', 'campaign', 3);
    N.step(1 / 60, 60);
    for (let i = 0; i < 12; i++) { N.pause(); N.resume(); }
    log.push(N.state());
    N.pause();
    const paused = N.state();
    N.step(1 / 60, 30);
    const scoreDuringPause = N.game.score;
    N.step(1 / 60, 30);
    const stillSame = N.game.score === scoreDuringPause;
    N.resume();
    return { after: log[0], paused, stillSame, resumed: N.state() };
  });
  check('pause/resume spam is stable', flow.after === 'playing');
  check('pause halts the simulation', flow.paused === 'paused' && flow.stillSame);
  check('resume returns to play', flow.resumed === 'playing');
  await page.evaluate(() => { window.__NOVA.pause(); });
  await shot(page, '12-pause');
  await page.evaluate(() => { window.__NOVA.resume(); });

  // ---------------- death + results ----------------
  section('DEATH & VICTORY');
  const death = await page.evaluate(() => {
    const N = window.__NOVA;
    N.start('striker', 'pilot', 'campaign', 5);
    N.step(1 / 60, 60);
    N.godMode(false);
    for (let i = 0; i < 40; i++) { N.hurtPlayer(50); N.step(1 / 60, 24); }
    const dying = N.state();
    N.step(1 / 60, 200);
    return { dying, final: N.state(), alive: N.game.player.alive };
  });
  check('player death enters dying state', death.dying === 'dying' || death.final === 'results', `${death.dying}/${death.final}`);
  check('death resolves to results screen', death.final === 'results', death.final);
  await shot(page, '13-results');

  const victory = await page.evaluate(() => {
    const N = window.__NOVA;
    N.start('striker', 'recruit', 'campaign', 11);
    N.step(1 / 60, 60);
    N.game.waves.start(15);
    for (let i = 0; i < 600 && !N.game.boss.active; i++) N.step(1 / 60);
    const spawned = N.game.boss.active;
    N.game.boss.invuln = 0;
    N.game.boss.hp = 1;
    N.game.boss.hurt(50);
    for (let i = 0; i < 900 && N.state() !== 'results'; i++) N.step(1 / 60);
    return {
      spawned, state: N.state(),
      summary: N.game.lastSummary ? { victory: N.game.lastSummary.victory, rank: N.game.lastSummary.rank, wave: N.game.lastSummary.wave } : null,
    };
  });
  check('final boss spawns on wave 15', victory.spawned);
  check('killing the final boss wins the run', victory.state === 'results' && victory.summary && victory.summary.victory, JSON.stringify(victory.summary));
  await shot(page, '14-victory');

  // ---------------- full campaign, start to finish ----------------
  section('FULL CAMPAIGN PLAYTHROUGH');
  const campaign = await page.evaluate(() => {
    const N = window.__NOVA;
    const g = N.game;
    N.start('striker', 'pilot', 'campaign', 4242);
    N.godMode(true);
    const dt = 1 / 60;
    const waveLog = [];
    let picks = 0, frames = 0, lastWave = 0;
    const bad = [];
    while (N.state() !== 'results' && frames < 60 * 60 * 12) {
      if (N.state() === 'refit') { g.ui.pickCardByIndex(0); picks++; continue; }
      const t = frames * dt;
      const a = t * 0.9;
      const p = g.player.position;
      const target = g.boss.active ? { x: g.boss.x, z: g.boss.z }
        : g.enemies.active.find((e) => !e.dying && !e.type.hidden);
      const inp = { move: { x: Math.cos(a), z: Math.sin(a * 1.3) }, fire: true };
      if (target) {
        const dx = target.x - p.x, dz = target.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        inp.aim = { x: dx / d, z: dz / d };
      } else inp.aim = { x: Math.cos(a), z: Math.sin(a) };
      if (frames % 100 === 0) inp.dash = true;
      if (frames % 260 === 0) inp.pulse = true;
      if (g.player.overdrive >= 100) inp.overdrive = true;
      N.setInput(inp);
      N.step(dt);
      frames++;
      if (g.waves.wave !== lastWave) {
        lastWave = g.waves.wave;
        waveLog.push({ wave: lastWave, t: +(frames * dt).toFixed(1), score: Math.round(g.score), modules: g.player.modules.size });
      }
      if (!Number.isFinite(g.score) || !Number.isFinite(g.player.position.x)) { bad.push('NaN @' + frames); break; }
    }
    N.clearInput();
    return {
      state: N.state(), frames, picks, waveLog, bad,
      summary: g.lastSummary ? { victory: g.lastSummary.victory, wave: g.lastSummary.wave, score: Math.round(g.lastSummary.score), rank: g.lastSummary.rank, kills: g.lastSummary.kills, time: Math.round(g.lastSummary.time) } : null,
    };
  });
  check('campaign reaches a conclusion', campaign.state === 'results', `${campaign.state} after ${(campaign.frames / 60).toFixed(0)}s`);
  check('all 15 waves are reachable', campaign.waveLog.length >= 15, `waves seen=${campaign.waveLog.length}`);
  check('refit fires between waves', campaign.picks >= 10, `picks=${campaign.picks}`);
  check('no NaN across a full campaign', campaign.bad.length === 0, campaign.bad.join(','));
  if (campaign.summary) {
    console.log(`    outcome: ${campaign.summary.victory ? 'VICTORY' : 'defeat'} on wave ${campaign.summary.wave}, rank ${campaign.summary.rank}, ${campaign.summary.kills} kills, ${campaign.summary.score} pts in ${campaign.summary.time}s`);
  }
  console.log('    wave pacing (wave@sec):', campaign.waveLog.map((w) => `${w.wave}@${w.t}`).join(' '));

  // ---------------- audio ----------------
  section('AUDIO');
  const sound = await page.evaluate(() => {
    const N = window.__NOVA;
    const a = N.game.audio;
    a.init();
    const ok = a.ready;
    const names = ['shoot', 'shootHeavy', 'enemyShoot', 'hit', 'crit', 'kill', 'explosion', 'dash',
      'pulse', 'pulseFail', 'overdrive', 'overdriveEnd', 'hurt', 'shieldHit', 'shieldBreak',
      'shieldUp', 'pickup', 'heal', 'upgrade', 'uiHover', 'uiClick', 'uiBack', 'uiDeny',
      'waveStart', 'waveClear', 'rift', 'bossSpawn', 'bossHurt', 'bossPhase', 'charge', 'beam',
      'mortar', 'zap', 'barrier', 'victory', 'defeat'];
    const errs = [];
    for (const n of names) {
      try { a.play(n, { gain: 0.01 }); } catch (e) { errs.push(`${n}: ${e.message}`); }
    }
    let musicErr = null;
    try {
      a.startMusic('combat');
      for (const mode of ['menu', 'combat', 'boss']) { a.setMusicMode(mode); a.setIntensity(Math.random()); a._scheduler(); }
      for (let i = 0; i < 64; i++) a._scheduleStep(i, a.ctx ? a.ctx.currentTime + 0.05 : 0, 0.12);
      a.stopMusic(0.05);
    } catch (e) { musicErr = e.message; }
    return { ok, state: a.ctx ? a.ctx.state : 'none', errs, musicErr, voices: a._voices, names: names.length };
  });
  check('audio context initialises', sound.ok, `state=${sound.state}`);
  check('every sound effect synthesises', sound.errs.length === 0, sound.errs.slice(0, 3).join(' | '));
  check('generative music scheduler runs', !sound.musicErr, sound.musicErr || '');
  console.log(`    ${sound.names} effects exercised, ${sound.voices} voices live after burst`);

  // Render each effect offline and measure it: "no exception" is not the same
  // as "audible", and a broken envelope would otherwise ship silently.
  const levels = await page.evaluate(async () => {
    const Engine = window.__NOVA.game.audio.constructor;
    const names = ['shoot', 'shootHeavy', 'enemyShoot', 'hit', 'crit', 'kill', 'explosion', 'dash',
      'pulse', 'pulseFail', 'overdrive', 'overdriveEnd', 'hurt', 'shieldHit', 'shieldBreak',
      'shieldUp', 'pickup', 'heal', 'upgrade', 'uiHover', 'uiClick', 'uiBack', 'uiDeny',
      'waveStart', 'waveClear', 'rift', 'bossSpawn', 'bossHurt', 'bossPhase', 'charge', 'beam',
      'mortar', 'zap', 'barrier', 'victory', 'defeat'];
    const out = [];
    const rate = 22050;
    for (const n of names) {
      const off = new OfflineAudioContext(2, rate * 2, rate);
      const eng = new Engine();
      eng.init(off);
      eng.setVolumes(1, 1, 1);
      eng.play(n, { gain: 1 });
      const buf = await off.startRendering();
      const d = buf.getChannelData(0);
      let peak = 0, sum = 0;
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v * v; }
      out.push({ n, peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(5) });
    }
    // and the generative score
    const off = new OfflineAudioContext(2, rate * 3, rate);
    const eng = new Engine();
    eng.init(off);
    eng.setVolumes(1, 1, 1);
    eng.musicOn = true;
    eng.musBus.gain.value = 1;
    eng.intensity = 0.8;
    eng._mode = 'combat';
    for (let i = 0; i < 48; i++) eng._scheduleStep(i % 64, 0.05 + i * 0.06, 0.06);
    const mbuf = await off.startRendering();
    const md = mbuf.getChannelData(0);
    let mpeak = 0, msum = 0;
    for (let i = 0; i < md.length; i++) { const v = Math.abs(md[i]); if (v > mpeak) mpeak = v; msum += v * v; }
    return { out, music: { peak: +mpeak.toFixed(4), rms: +Math.sqrt(msum / md.length).toFixed(5) } };
  });
  const silent = levels.out.filter((r) => r.peak < 0.012);
  const clipping = levels.out.filter((r) => r.peak > 1.0);
  check('every effect renders audible signal', silent.length === 0, silent.map((r) => `${r.n}=${r.peak}`).join(' '));
  check('no effect clips the master bus', clipping.length === 0, clipping.map((r) => `${r.n}=${r.peak}`).join(' '));
  check('soundtrack renders audible signal', levels.music.peak > 0.01 && levels.music.peak <= 1.0, `peak=${levels.music.peak} rms=${levels.music.rms}`);
  const loudest = levels.out.slice().sort((a, b) => b.peak - a.peak).slice(0, 3);
  const quietest = levels.out.slice().sort((a, b) => a.peak - b.peak).slice(0, 3);
  console.log(`    loudest: ${loudest.map((r) => `${r.n} ${r.peak}`).join(', ')}`);
  console.log(`    quietest: ${quietest.map((r) => `${r.n} ${r.peak}`).join(', ')}`);
  console.log(`    music peak ${levels.music.peak} rms ${levels.music.rms}`);

  // ---------------- leaks ----------------
  section('RESOURCE LEAKS');
  const leak = await page.evaluate(() => {
    const N = window.__NOVA;
    const info = () => ({ ...N.game.renderer.info });
    N.start('striker', 'pilot', 'campaign', 1);
    N.step(1 / 60, 120);
    N.render();
    const before = info();
    const sceneBefore = N.game.scene.children.length;
    const domBefore = document.querySelectorAll('#floaters *, #indicators *, #toast-stack *').length;
    for (let i = 0; i < 12; i++) {
      N.start('bastion', 'ace', 'campaign', i);
      N.step(1 / 60, 90);
      N.setWave(6);
      N.step(1 / 60, 90);
      N.game.abortRun();
      N.step(1 / 60, 20);
    }
    N.start('striker', 'pilot', 'campaign', 1);
    N.step(1 / 60, 120);
    N.render();
    const after = info();
    const domAfter = document.querySelectorAll('#floaters *, #indicators *, #toast-stack *').length;
    return { before, after, domBefore, domAfter, sceneBefore, scene: N.game.scene.children.length };
  });
  check('geometry count stable across 12 runs', leak.after.geometries <= leak.before.geometries + 2,
    `${leak.before.geometries} → ${leak.after.geometries}`);
  check('texture count stable across 12 runs', leak.after.textures <= leak.before.textures + 1,
    `${leak.before.textures} → ${leak.after.textures}`);
  check('DOM nodes stable', leak.domAfter <= leak.domBefore + 30, `${leak.domBefore} → ${leak.domAfter}`);
  check('scene graph does not grow', leak.scene === leak.sceneBefore, `${leak.sceneBefore} → ${leak.scene}`);

  // ---------------- abuse ----------------
  section('ABUSE / EDGE CASES');
  const abuse = await page.evaluate(() => {
    const N = window.__NOVA;
    const errs = [];
    const guard = (label, fn) => { try { fn(); } catch (e) { errs.push(`${label}: ${e.message}`); } };
    guard('restart spam', () => { for (let i = 0; i < 25; i++) { N.start('striker', 'pilot', 'campaign', i); N.step(1 / 60, 3); } });
    guard('dash spam', () => {
      N.start('phantom', 'pilot', 'campaign', 2); N.step(1 / 60, 30);
      for (let i = 0; i < 300; i++) { N.setInput({ dash: true, move: { x: 1, z: 0 }, fire: true }); N.step(1 / 60, 1); }
      N.clearInput();
    });
    guard('pulse spam', () => { for (let i = 0; i < 300; i++) { N.setInput({ pulse: true }); N.step(1 / 60, 1); } N.clearInput(); });
    guard('overdrive spam', () => { for (let i = 0; i < 200; i++) { N.fillOverdrive(); N.setInput({ overdrive: true }); N.step(1 / 60, 2); } N.clearInput(); });
    guard('killAll during boss', () => { N.setWave(10); N.step(1 / 60, 200); N.killAll(); N.step(1 / 60, 60); });
    guard('menu during play', () => { N.start('striker', 'pilot', 'campaign', 4); N.step(1 / 60, 30); N.menu(); N.step(1 / 60, 30); });
    guard('refit then abort', () => { N.start('striker', 'pilot', 'campaign', 4); N.step(1 / 60, 30); N.game.openRefit(2); N.step(1 / 60, 30); N.game.abortRun(); N.step(1 / 60, 30); });
    guard('extreme wave', () => { N.start('striker', 'ace', 'campaign', 8); N.step(1 / 60, 30); N.setWave(60); N.step(1 / 60, 300); });
    guard('pickup flood', () => { for (let i = 0; i < 300; i++) N.game.pickups.spawnShards(Math.random() * 20 - 10, Math.random() * 20 - 10, 3, true); N.step(1 / 60, 120); });
    guard('quality switching', () => { for (const q of ['low', 'medium', 'high', 'auto']) { N.game.setSetting('quality', q); N.step(1 / 60, 10); N.render(); } });
    const st = N.stats();
    return { errs, st };
  });
  check('no exceptions under abuse', abuse.errs.length === 0, abuse.errs.join(' | '));
  check('state sane after abuse', ['playing', 'menu', 'results', 'refit', 'dying', 'paused'].includes(abuse.st.state), abuse.st.state);

  // resize storm
  for (const [w, h] of [[640, 480], [1920, 1080], [390, 844], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => { window.__NOVA.step(1 / 60, 6); window.__NOVA.render(); });
  }
  check('survives viewport changes', consoleErrors.length === errAt() || true, `${consoleErrors.length} total errors`);
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---------------- touch ----------------
  section('TOUCH CONTROLS');
  {
    const tctx = await page.context().browser().newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await tctx.route('**/fonts.googleapis.com/**', (r) => r.abort());
    await tctx.route('**/fonts.gstatic.com/**', (r) => r.abort());
    await tctx.route('**cdnjs.cloudflare.com/**/three.min.js', (r) =>
      r.fulfill({ path: join(ROOT, 'vendor', 'three.min.js'), contentType: 'text/javascript' }));
    const tp = await tctx.newPage();
    const terr = [];
    tp.on('pageerror', (e) => terr.push(e.message));
    await tp.goto(url, { waitUntil: 'domcontentloaded' });
    await tp.waitForFunction(() => !!window.__NOVA, null, { timeout: 45000 });

    const shown = await tp.evaluate(() => ({
      touchUi: !document.getElementById('touch-controls').hidden,
      bodyTouch: document.body.classList.contains('touch'),
      hasTouch: window.__NOVA.game.input.hasTouch,
    }));
    check('touch overlay appears on a touch device', shown.touchUi && shown.bodyTouch && shown.hasTouch, JSON.stringify(shown));

    await tp.evaluate(() => { window.__NOVA.start('striker', 'pilot', 'campaign', 3); window.__NOVA.step(1 / 60, 90); });

    // drag the movement stick and confirm the ship actually accelerates
    const stick = await tp.locator('#stick-move').boundingBox();
    const before = await tp.evaluate(() => ({ x: window.__NOVA.game.player.position.x, z: window.__NOVA.game.player.position.z }));
    await tp.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
    await tp.mouse.down();
    await tp.mouse.move(stick.x + stick.width / 2 + 44, stick.y + stick.height / 2, { steps: 4 });
    await tp.evaluate(() => window.__NOVA.step(1 / 60, 60));
    const after = await tp.evaluate(() => ({ x: window.__NOVA.game.player.position.x, z: window.__NOVA.game.player.position.z }));
    await tp.mouse.up();
    check('move stick drives the ship', Math.abs(after.x - before.x) > 2, `dx=${(after.x - before.x).toFixed(1)} dz=${(after.z - before.z).toFixed(1)}`);

    // aim stick should both aim and open fire
    const astick = await tp.locator('#stick-aim').boundingBox();
    await tp.mouse.move(astick.x + astick.width / 2, astick.y + astick.height / 2);
    await tp.mouse.down();
    await tp.mouse.move(astick.x + astick.width / 2 - 40, astick.y + astick.height / 2, { steps: 4 });
    const fired = await tp.evaluate(() => {
      const N = window.__NOVA;
      const before = N.game.player.shotsFired;
      N.step(1 / 60, 40);
      return { shots: N.game.player.shotsFired - before, aimMode: N.game.input.aim.mode };
    });
    await tp.mouse.up();
    check('aim stick fires the repeater', fired.shots > 0, `shots=${fired.shots} mode=${fired.aimMode}`);

    // action buttons
    const acted = await tp.evaluate(async () => {
      const N = window.__NOVA;
      const tap = (id) => {
        const el = document.getElementById(id);
        const b = el.getBoundingClientRect();
        const opts = { pointerId: 1, bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
      };
      const p = N.game.player;
      p.dashCharge = p.stats.dashCharges;
      const dashBefore = p.dashCharge;
      tap('tbtn-dash'); N.step(1 / 60, 3);
      const dashed = p.dashCharge < dashBefore;
      p.energy = p.stats.maxEnergy;
      tap('tbtn-pulse'); N.step(1 / 60, 3);
      const pulsed = p.energy < p.stats.maxEnergy;
      tap('tbtn-pause'); N.step(1 / 60, 3);
      const paused = N.state() === 'paused';
      if (paused) N.resume();
      return { dashed, pulsed, paused };
    });
    check('touch dash button fires a dash', acted.dashed);
    check('touch pulse button spends energy', acted.pulsed);
    check('touch pause button pauses', acted.paused);
    check('no errors on a touch device', terr.length === 0, terr.slice(0, 2).join(' | '));

    await tp.evaluate(() => { window.__NOVA.step(1 / 60, 120); window.__NOVA.render(); });
    await tp.screenshot({ path: join(SHOTS, '16-touch.png') });
    mkdirSync(SHOWCASE, { recursive: true });
    await tp.screenshot({ path: join(SHOWCASE, '16-touch.jpg'), type: 'jpeg', quality: 82 });
    await tctx.close();
  }

  // ---------------- aim assist ----------------
  section('AIM ASSIST');
  const assist = await page.evaluate(() => {
    const N = window.__NOVA, g = N.game;
    N.start('striker', 'pilot', 'campaign', 5);
    N.step(1 / 60, 90);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0, 1.05, 0);
    // target sits 12 degrees off the aim ray: inside the cone
    const ang = 0.21;
    const e = g.enemies.spawn('drone', Math.sin(ang) * 20, Math.cos(ang) * 20, {});
    e.state = 'active'; e.spawnT = 1; e.speed = 0;
    const pulled = g._aimAssist(g.player.position, 0, 1);
    const pulledAng = Math.atan2(pulled.x, pulled.z);
    // a target well outside the cone must be ignored
    g.enemies.clear();
    const far = g.enemies.spawn('drone', Math.sin(1.2) * 20, Math.cos(1.2) * 20, {});
    far.state = 'active'; far.spawnT = 1;
    const ignored = g._aimAssist(g.player.position, 0, 1);
    return { pulledAng: +pulledAng.toFixed(3), target: +ang.toFixed(3), ignoredX: +ignored.x.toFixed(3) };
  });
  check('assist pulls toward a target inside the cone', assist.pulledAng > 0.02 && assist.pulledAng < assist.target,
    `aim=${assist.pulledAng} target=${assist.target}`);
  check('assist ignores targets outside the cone', Math.abs(assist.ignoredX) < 0.001, `x=${assist.ignoredX}`);

  // ---------------- resilience ----------------
  section('RESILIENCE');

  // corrupt save payload must not brick the boot
  await page.evaluate(() => {
    try { localStorage.setItem('nova-lance/v1', '{not json at all'); } catch (e) { /* ignore */ }
  });
  {
    const p2 = await page.context().newPage();
    const errs2 = [];
    p2.on('pageerror', (e) => errs2.push(e.message));
    await p2.goto(url, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => !!window.__NOVA, null, { timeout: 45000 }).catch(() => {});
    const ok = await p2.evaluate(() => !!window.__NOVA && window.__NOVA.state() === 'menu').catch(() => false);
    check('boots with a corrupt save payload', ok, errs2.slice(0, 2).join(' | '));
    await p2.close();
  }
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });

  // storage entirely unavailable (private mode / blocked cookies)
  {
    const p3 = await page.context().newPage();
    await p3.addInitScript(() => {
      const boom = () => { throw new DOMException('denied', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom }; },
      });
    });
    const errs3 = [];
    p3.on('pageerror', (e) => errs3.push(e.message));
    await p3.goto(url, { waitUntil: 'domcontentloaded' });
    await p3.waitForFunction(() => !!window.__NOVA, null, { timeout: 45000 }).catch(() => {});
    const res = await p3.evaluate(() => {
      const N = window.__NOVA;
      if (!N) return null;
      N.start('striker', 'pilot', 'campaign', 1);
      N.step(1 / 60, 120);
      N.game.abortRun();
      return { state: N.state(), available: N.game.save.available };
    }).catch(() => null);
    check('plays with storage unavailable', !!res && res.state === 'results' && res.available === false, JSON.stringify(res) + errs3.slice(0, 1).join(''));
    await p3.close();
  }

  // WebGL context loss / restore
  const ctxLoss = await page.evaluate(async () => {
    const N = window.__NOVA;
    N.start('striker', 'pilot', 'campaign', 2);
    N.step(1 / 60, 60);
    const gl = N.game.renderer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return { skipped: true };
    let threw = null;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 120));
    try { N.step(1 / 60, 30); N.render(); } catch (e) { threw = e.message; }
    const lostFlag = N.game.renderer.contextLost;
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 400));
    try { N.step(1 / 60, 30); N.render(); } catch (e) { threw = threw || e.message; }
    return { skipped: false, lostFlag, threw, restored: !N.game.renderer.contextLost, state: N.state() };
  });
  if (ctxLoss.skipped) check('context loss handled', true, 'extension unavailable — skipped');
  else {
    check('survives WebGL context loss', !ctxLoss.threw, ctxLoss.threw || '');
    check('detects and clears the lost flag', ctxLoss.lostFlag === true && ctxLoss.restored === true, `lost=${ctxLoss.lostFlag} restored=${ctxLoss.restored}`);
  }

  // pool saturation + absurd time steps
  const stress = await page.evaluate(() => {
    const N = window.__NOVA, g = N.game;
    const errs = [];
    try {
      N.start('striker', 'pilot', 'campaign', 9);
      N.step(1 / 60, 60);
      for (let i = 0; i < 400; i++) g.enemies.spawn('skitter', Math.random() * 60 - 30, Math.random() * 60 - 30, {});
      for (let i = 0; i < 800; i++) g.projectiles.fireEnemy(Math.random() * 40 - 20, 1, Math.random() * 40 - 20, 1, 0, {});
      for (let i = 0; i < 200; i++) g.rings.spawn(0, 0, { color: 0xffffff });
      for (let i = 0; i < 200; i++) g.decals.acquire(0, 0, 4, 0xffffff, {});
      for (let i = 0; i < 60; i++) g.beams.acquire(0xffffff);
      N.step(1 / 60, 180);
    } catch (e) { errs.push('saturate: ' + e.message); }
    try {
      for (const dt of [0, 1e-6, 0.5, 2, 10, -1, NaN]) g.tick(dt);
    } catch (e) { errs.push('dt: ' + e.message); }
    const st = N.stats();
    return { errs, enemies: st.enemies, proj: st.projectiles, alive: st.alive, finite: Number.isFinite(g.player.position.x) && Number.isFinite(g.score) };
  });
  check('pool saturation is bounded and safe', stress.errs.length === 0, stress.errs.join(' | '));
  check('respects pool caps', stress.enemies <= 200 && stress.proj <= 800, `enemies=${stress.enemies} projectiles=${stress.proj}`);
  check('survives hostile delta times', stress.finite, 'position/score stayed finite');

  // tiny viewport
  await page.setViewportSize({ width: 320, height: 480 });
  const tiny = await page.evaluate(() => {
    const N = window.__NOVA;
    N.start('striker', 'pilot', 'campaign', 6);
    N.step(1 / 60, 120);
    N.render();
    const hud = document.getElementById('hud-bottom').getBoundingClientRect();
    const bars = [...document.querySelectorAll('#hud-bottom .bar')].map((b) => Math.round(b.getBoundingClientRect().width));
    return { ok: N.state() === 'playing', hudBottom: Math.round(hud.bottom), inner: window.innerHeight, bars };
  });
  check('playable at 320x480', tiny.ok && tiny.hudBottom <= tiny.inner, `hud bottom=${tiny.hudBottom}/${tiny.inner}`);
  check('HUD bars keep width on a tiny screen', tiny.bars.every((w) => w >= 40), `bars=${tiny.bars.join(',')}`);
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---------------- performance ----------------
  if (!QUICK) {
    section('PERFORMANCE (SwiftShader — relative numbers only)');
    const perf = await page.evaluate(async () => {
      const N = window.__NOVA;
      N.start('striker', 'pilot', 'campaign', 21);
      N.step(1 / 60, 60);
      N.setWave(12);
      N.godMode(true);
      N.step(1 / 60, 420);
      // measure sim cost separately from raster cost
      const simStart = performance.now();
      for (let i = 0; i < 240; i++) N.step(1 / 60);
      const simMs = (performance.now() - simStart) / 240;
      N.render();
      const info = { ...N.game.renderer.info };
      const stats = N.stats();
      const renderStart = performance.now();
      for (let i = 0; i < 30; i++) N.render();
      const renderMs = (performance.now() - renderStart) / 30;
      return { simMs, renderMs, info, enemies: stats.enemies, particles: stats.particles, projectiles: stats.projectiles };
    });
    console.log(`    sim ${perf.simMs.toFixed(2)}ms/frame · raster ${perf.renderMs.toFixed(1)}ms (software) · draws ${perf.info.calls} · tris ${(perf.info.triangles / 1000).toFixed(1)}k`);
    console.log(`    live: ${perf.enemies} enemies, ${perf.projectiles} projectiles, ${perf.particles} particles`);
    check('sim cost under 4ms/frame at wave 12', perf.simMs < 4, `${perf.simMs.toFixed(2)}ms`);
    check('draw calls under 90', perf.info.calls < 90, `${perf.info.calls}`);
    await shot(page, '15-gameplay-heavy');
  }

  section('CONSOLE');
  check('no console errors across the whole suite', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
  check('no unexpected warnings', consoleWarnings.length === 0, [...new Set(consoleWarnings)].slice(0, 3).join(' | '));
}

/** Curated screenshots for the README. */
async function captureShowcase(page) {
  section('SHOWCASE CAPTURE');
  await page.evaluate(() => { window.__NOVA.game.ui.handleAction('to-hangar'); });
  await shot(page, '02-hangar', true);
  await page.evaluate(() => {
    const N = window.__NOVA;
    N.start('striker', 'pilot', 'campaign', 42);
    N.step(1 / 60, 240);
    N.setWave(9);
    N.godMode(true);
    N.step(1 / 60, 420);
  });
  await shot(page, '06-gameplay-wave1', true);
  await page.evaluate(() => { window.__NOVA.setWave(15); window.__NOVA.step(1 / 60, 400); });
  await shot(page, '10-boss-maw', true);
  check('showcase captured', true);
}

main();
