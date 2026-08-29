/**
 * visual.mjs — art direction QA.
 * Stages deterministic scenes (roster line-up, close-ups, combat, bosses) and
 * writes screenshots so composition, readability and colour can be reviewed
 * without playing. Usage: node tools/visual.mjs [sceneName ...]
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'docs', 'shots-visual');
const PORT = 8191;

const SCENES = {
  ship: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,22); g.player.velocity.set(0,0,0);
    N.setInput({ aim: { x: 0, z: -1 } });
    N.step(1/60,45);
    N.setCamera({ x: 0, y: 6.5, z: 30, tx: 0, ty: 1.4, tz: 21.4 });
    N.step(1/60,2);
  `,
  ship_bastion: `
    const g = N.game;
    N.start('bastion','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,22); g.player.velocity.set(0,0,0);
    N.setInput({ aim: { x: 0.4, z: -1 } }); N.step(1/60,45);
    N.setCamera({ x: 0, y: 6.5, z: 30, tx: 0, ty: 1.4, tz: 21.4 });
    N.step(1/60,2);
  `,
  ship_phantom: `
    const g = N.game;
    N.start('phantom','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,22); g.player.velocity.set(0,0,0);
    N.setInput({ aim: { x: -0.4, z: -1 } }); N.step(1/60,45);
    N.setCamera({ x: 0, y: 6.5, z: 30, tx: 0, ty: 1.4, tz: 21.4 });
    N.step(1/60,2);
  `,
  roster: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(-16,1.05,30); g.player.velocity.set(0,0,0);
    const types = ['skitter','drone','splitter','seeder','lancer','sentinel'];
    types.forEach((t,i) => {
      const e = g.enemies.spawn(t, -15 + i*6, 22);
      if (e) { e.state='active'; e.spawnT=1; e.mat.uniforms.uDissolve.value=0; e.mesh.scale.setScalar(e.scale); e.speed = 0; }
    });
    N.step(1/60,6);
    g.enemies.active.forEach(e => { e.x = -15 + g.enemies.active.indexOf(e)*6; e.z = 22; e.vx=0; e.vz=0; e.yaw = 0; });
    N.step(1/60,1);
    g.rings.clear(); g.fx.clear(); g.ui.el.banner.innerHTML = '';
    N.setCamera({ x: 0, y: 10, z: 36, tx: 0, ty: 1.2, tz: 21 });
    N.step(1/60,1);
    g.ui.el.banner.innerHTML = '';
  `,
  combat: `
    N.setCamera(null);
    const g = N.game;
    N.start('striker','pilot','campaign',7); N.step(1/60,120);
    N.setWave(9); N.godMode(true);
    N.step(1/60,60);
    for (let i=0;i<240;i++){
      const a = i*0.02;
      N.setInput({ move:{x:Math.cos(a),z:Math.sin(a)}, fire:true, aim:{x:Math.cos(a*2),z:Math.sin(a*2)} });
      N.step(1/60);
    }
    N.clearInput();
  `,
  overdrive: `
    N.setCamera(null);
    const g = N.game;
    N.start('striker','pilot','campaign',7); N.step(1/60,60);
    N.setWave(6); N.step(1/60,180);
    N.fillOverdrive(); N.setInput({ overdrive:true, fire:true, aim:{x:1,z:0} }); N.step(1/60,2);
    N.setInput({ fire:true, aim:{x:1,z:0}, move:{x:0.4,z:0.2} }); N.step(1/60,90);
    N.clearInput();
  `,
  warden: `
    N.setCamera(null);
    N.start('striker','pilot','campaign',3); N.step(1/60,60);
    N.setWave(5); N.godMode(true); N.step(1/60,420);
  `,
  harrower: `
    N.setCamera(null);
    N.start('striker','pilot','campaign',3); N.step(1/60,60);
    N.setWave(10); N.godMode(true); N.step(1/60,420);
  `,
  maw: `
    N.setCamera(null);
    N.start('striker','pilot','campaign',3); N.step(1/60,60);
    N.setWave(15); N.godMode(true); N.step(1/60,500);
  `,
  sky: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,40);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    N.setCamera({ x: 0, y: 8, z: 0, tx: 90, ty: 34, tz: 20 });
    N.step(1/60,2);
  `,
  refit: `
    N.setCamera(null);
    N.start('striker','pilot','campaign',3); N.step(1/60,90);
    N.giveModule('overclock',2); N.giveModule('ricochet',1);
    N.game.openRefit(4);
  `,
  hud: `
    N.setCamera(null);
    N.start('phantom','ace','campaign',3); N.step(1/60,60);
    N.setWave(7); N.step(1/60,240);
    N.giveModule('overclock',2); N.giveModule('ricochet'); N.giveModule('vampiric'); N.giveModule('guardian');
    N.godMode(true);
    N.game.player.hull = N.game.player.stats.maxHull * 0.22;
    N.game.player.energy = N.game.player.stats.maxEnergy * 0.55;
    N.game.player.overdrive = 78;
    N.step(1/60,30);
  `,
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const list = want.length ? want : Object.keys(SCENES);
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('  ! pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });
  await page.evaluate(() => { window.__NOVA.game.setSetting('quality', 'high'); });

  for (const name of list) {
    const code = SCENES[name];
    if (!code) { console.log(`  ? unknown scene ${name}`); continue; }
    await page.evaluate(new Function('N', code), await page.evaluateHandle(() => window.__NOVA));
    await page.evaluate(() => window.__NOVA.render());
    await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
    console.log(`  ✓ ${name}.png`);
  }

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }
}
main();
