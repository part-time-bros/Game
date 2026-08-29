/**
 * endurance.mjs — long-running stability checks that are too slow for the
 * default suite: a heavy-load soak looking for drift, and a deep Endless run.
 *
 *   node tools/endurance.mjs [soakMinutes] [endlessWaveTarget]
 */
import { spawn, execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8199;
const SOAK_MIN = Number(process.argv[2] || 10);
const ENDLESS_TARGET = Number(process.argv[3] || 30);

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route('**/fonts.g*/**', (r) => r.abort());
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/net::/.test(m.text())) errs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });

  console.log(`\n\x1b[1mSOAK — ${SOAK_MIN} simulated minutes at heavy load\x1b[0m`);
  const soak = await page.evaluate(async (minutes) => {
    const N = window.__NOVA, g = N.game;
    N.start('striker', 'ace', 'campaign', 777);
    N.godMode(true);
    N.setWave(13);
    const dt = 1 / 60;
    const total = Math.round(minutes * 60 * 60);
    const samples = [];
    let lastReset = -600;
    for (let i = 0; i < total; i++) {
      const t = i * dt;
      const a = t * 0.8;
      const p = g.player.position;
      let target = null, bd = 1e9;
      for (const e of g.enemies.active) {
        if (e.dying || e.type.hidden) continue;
        const d = (e.x - p.x) ** 2 + (e.z - p.z) ** 2;
        if (d < bd) { bd = d; target = e; }
      }
      const inp = { fire: true, move: { x: Math.cos(a), z: Math.sin(a * 1.7) } };
      if (target) {
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz) || 1;
        inp.aim = { x: dx / d, z: dz / d };
      } else inp.aim = { x: Math.cos(a), z: Math.sin(a) };
      if (i % 70 === 0) inp.dash = true;
      if (i % 190 === 0) inp.pulse = true;
      if (g.player.overdrive >= 100) inp.overdrive = true;
      N.setInput(inp);
      // Keep the pressure on: this is a load test, not a playthrough. Only
      // restart a wave once the deck is actually clear, and never so often that
      // the director stays stuck in its intro beat.
      if (g.enemies.threatCount === 0 && i - (lastReset || -600) > 600) {
        lastReset = i;
        N.setWave(12 + ((i / 3600) | 0) % 5);
      }
      const t0 = performance.now();
      N.step(dt);
      const cost = performance.now() - t0;
      if (i % 900 === 0) {
        N.render();
        samples.push({
          min: +(i / 3600).toFixed(1), sim: +cost.toFixed(3),
          enemies: g.enemies.count, proj: g.projectiles.count, parts: g.fx.count,
          pickups: g.pickups.count, timers: g.timers.length,
          dom: document.querySelectorAll('#floaters *, #indicators *, #toast-stack *').length,
          geo: g.renderer.info.geometries, tex: g.renderer.info.textures,
          rings: g.rings.pool.count, decals: g.decals.pool.count, beams: g.beams.pool.count,
          debris: g.debris.pool.count, scene: g.scene.children.length,
          heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    N.clearInput();
    return { samples, state: N.state() };
  }, SOAK_MIN);

  console.log('  min   sim(ms) enemies proj parts pick timers dom  geo tex rings decal beam debris scene heapMB');
  for (const s of soak.samples) {
    console.log(`  ${String(s.min).padStart(4)}  ${String(s.sim).padStart(7)} ${String(s.enemies).padStart(7)} ${String(s.proj).padStart(4)} ${String(s.parts).padStart(5)} ${String(s.pickups).padStart(4)} ${String(s.timers).padStart(6)} ${String(s.dom).padStart(3)} ${String(s.geo).padStart(4)} ${String(s.tex).padStart(3)} ${String(s.rings).padStart(5)} ${String(s.decals).padStart(5)} ${String(s.beams).padStart(4)} ${String(s.debris).padStart(6)} ${String(s.scene).padStart(5)} ${String(s.heap).padStart(6)}`);
  }
  const first = soak.samples[1] || soak.samples[0];
  const last = soak.samples[soak.samples.length - 1];
  const drift = (k) => `${first[k]} → ${last[k]}`;
  console.log(`  drift: geometries ${drift('geo')} · textures ${drift('tex')} · scene ${drift('scene')} · dom ${drift('dom')} · heap ${drift('heap')}MB`);

  console.log(`\n\x1b[1mENDLESS — bot run to wave ${ENDLESS_TARGET}\x1b[0m`);
  const endless = await page.evaluate(async (target) => {
    const N = window.__NOVA, g = N.game;
    g.save.record.endless = true;
    N.start('bastion', 'pilot', 'endless', 31337);
    N.godMode(true);
    const dt = 1 / 60;
    const log = [];
    let frames = 0, lastWave = 0, waveStart = 0, picks = 0;
    while (g.waves.wave < target && frames < 60 * 60 * 45) {
      if (N.state() === 'refit') { g.ui.pickCardByIndex(Math.floor(Math.random() * 3)); picks++; continue; }
      if (N.state() === 'results') break;
      const p = g.player.position;
      let target2 = g.boss.active ? { x: g.boss.x, z: g.boss.z } : null, bd = 1e9;
      if (!target2) for (const e of g.enemies.active) {
        if (e.dying || e.type.hidden) continue;
        const d = (e.x - p.x) ** 2 + (e.z - p.z) ** 2;
        if (d < bd) { bd = d; target2 = e; }
      }
      const a = frames * dt * 0.9;
      const inp = { fire: true, move: { x: Math.cos(a), z: Math.sin(a * 1.2) } };
      if (target2) {
        const dx = target2.x - p.x, dz = target2.z - p.z, d = Math.hypot(dx, dz) || 1;
        inp.aim = { x: dx / d, z: dz / d };
      } else inp.aim = { x: Math.cos(a), z: Math.sin(a) };
      if (frames % 80 === 0) inp.dash = true;
      if (g.player.overdrive >= 100) inp.overdrive = true;
      N.setInput(inp);
      N.step(dt);
      frames++;
      if (g.waves.wave !== lastWave) {
        if (lastWave) log.push({ wave: lastWave, sec: +((frames - waveStart) * dt).toFixed(1), enemies: g.enemies.count, hpScale: +g.waves.hpScale(lastWave).toFixed(2), budget: g.waves.waveBudget(lastWave), score: Math.round(g.score) });
        lastWave = g.waves.wave; waveStart = frames;
        if (log.length % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    N.clearInput();
    return { log, picks, frames, reached: g.waves.wave, state: N.state(), modules: g.player.modules.size };
  }, ENDLESS_TARGET);

  console.log('  wave  sec  budget hpScale enemies score');
  for (const w of endless.log) {
    console.log(`  ${String(w.wave).padStart(4)} ${String(w.sec).padStart(5)} ${String(w.budget).padStart(6)} ${String(w.hpScale).padStart(6)} ${String(w.enemies).padStart(7)} ${String(w.score).padStart(6)}`);
  }
  console.log(`  reached wave ${endless.reached} in ${(endless.frames / 3600).toFixed(1)} sim-minutes, ${endless.modules} modules, ${endless.picks} drafts, state=${endless.state}`);

  console.log(`\nerrors: ${errs.length}`);
  for (const e of errs.slice(0, 8)) console.log('  ! ' + e);

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }
  process.exit(errs.length ? 1 : 0);
}
main();
