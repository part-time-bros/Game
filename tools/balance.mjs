/**
 * balance.mjs — headless bot campaigns for tuning.
 *
 * Runs scripted playthroughs at each difficulty and reports wave-by-wave
 * duration, kill counts, score curve and where the bot dies. The bot is
 * deliberately mediocre (circle-strafe + track nearest target), so treat its
 * clear times as a slow-player upper bound.
 *
 *   node tools/balance.mjs [runs] [difficulty]
 */
import { spawn, execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8193;
const RUNS = Number(process.argv[2] || 1);
const ONLY = process.argv[3];

const BOT = `
  (opts) => {
    const N = window.__NOVA, g = N.game;
    N.start(opts.ship, opts.difficulty, opts.mode, opts.seed);
    if (opts.god) N.godMode(true);
    const dt = 1 / 60;
    let frames = 0, picks = 0, lastWave = 0, waveStart = 0;
    const waves = [], killsAt = [];
    let lastKills = 0;
    while (N.state() !== 'results' && frames < 60 * 60 * 25) {
      if (N.state() === 'refit') {
        // bot drafts greedily: first offer
        g.ui.pickCardByIndex(0); picks++; continue;
      }
      const t = frames * dt;
      const p = g.player.position;
      let target = null, bestD = 1e9;
      if (g.boss.active) target = { x: g.boss.x, z: g.boss.z };
      else {
        for (const e of g.enemies.active) {
          if (e.dying || e.type.hidden) continue;
          const d = (e.x - p.x) ** 2 + (e.z - p.z) ** 2;
          if (d < bestD) { bestD = d; target = e; }
        }
      }
      const inp = { fire: true };
      // keep a mid distance from the nearest threat, orbit it
      if (target) {
        const dx = target.x - p.x, dz = target.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        inp.aim = { x: dx / d, z: dz / d };
        const want = 12;
        const radial = (d - want) / want;
        inp.move = {
          x: (-dz / d) * 0.85 + (dx / d) * radial,
          z: (dx / d) * 0.85 + (dz / d) * radial,
        };
        const m = Math.hypot(inp.move.x, inp.move.z) || 1;
        inp.move.x /= m; inp.move.z /= m;
      } else {
        const a = t * 0.7;
        inp.move = { x: Math.cos(a), z: Math.sin(a) };
        inp.aim = { x: Math.cos(a), z: Math.sin(a) };
      }
      // dodge: dash when hurt recently or on a timer
      if (frames % 80 === 0) inp.dash = true;
      if (g.enemies.query(p.x, p.z, 7).length > 2 && g.player.energy > g.player.stats.pulseCost) inp.pulse = true;
      if (g.player.overdrive >= 100) inp.overdrive = true;
      N.setInput(inp);
      N.step(dt);
      frames++;
      if (g.waves.wave !== lastWave) {
        if (lastWave) waves.push({
          wave: lastWave,
          sec: +((frames - waveStart) * dt).toFixed(1),
          kills: g.runStats.kills - lastKills,
          hull: Math.round(g.player.hull),
          score: Math.round(g.score),
          mods: g.player.modules.size,
        });
        lastWave = g.waves.wave;
        waveStart = frames;
        lastKills = g.runStats.kills;
      }
    }
    N.clearInput();
    const s = g.lastSummary;
    return {
      waves, picks, frames,
      result: s ? { victory: s.victory, wave: s.wave, score: Math.round(s.score), rank: s.rank, kills: s.kills, time: Math.round(s.time), dealt: s.damageDealt, taken: s.damageTaken, modules: [...s.modules.entries()] } : null,
    };
  }
`;

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await context.route('**/fonts.gstatic.com/**', (r) => r.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  ! pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });

  const difficulties = ONLY ? [ONLY] : ['recruit', 'pilot', 'ace'];
  for (const difficulty of difficulties) {
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      const out = await page.evaluate(new Function('return (' + BOT + ')')(), {
        ship: 'striker', difficulty, mode: 'campaign', seed: 1000 + i * 37, god: false,
      });
      const r = out.result;
      console.log(`\n\x1b[1m${difficulty.toUpperCase()} run ${i + 1}\x1b[0m  (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);
      console.log(`  ${r ? (r.victory ? 'VICTORY' : `died on wave ${r.wave}`) : 'unresolved'} · rank ${r ? r.rank : '-'} · ${r ? r.score : 0} pts · ${r ? r.kills : 0} kills · ${r ? r.time : 0}s`);
      console.log('  wave  sec   kills  hull  mods');
      for (const w of out.waves) {
        console.log(`   ${String(w.wave).padStart(2)}   ${String(w.sec).padStart(5)}  ${String(w.kills).padStart(4)}   ${String(w.hull).padStart(4)}   ${w.mods}`);
      }
      const total = out.waves.reduce((a, w) => a + w.sec, 0);
      console.log(`  total ${total.toFixed(0)}s across ${out.waves.length} waves (avg ${(total / Math.max(1, out.waves.length)).toFixed(1)}s)`);
      if (r && r.modules) console.log('  build:', r.modules.map(([id, n]) => `${id}${n > 1 ? '×' + n : ''}`).join(', '));
    }
  }

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }
}
main();
