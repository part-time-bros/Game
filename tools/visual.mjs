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
    g.player.position.set(0,1.05,44); g.player.velocity.set(0,0,0);
    const types = ['skitter','drone','splitter','seeder','lancer','sentinel'];
    const spots = types.map((t,i) => ({ t, x: -11.5 + i*4.6, z: 20 }));
    spots.forEach(s => {
      const e = g.enemies.spawn(s.t, s.x, s.z);
      if (e) { e.state='active'; e.spawnT=1; e.mat.uniforms.uDissolve.value=0; e.mesh.scale.setScalar(e.scale); e.pin = s; }
    });
    for (let i=0;i<60;i++){
      N.step(1/60);
      g.enemies.active.forEach(e => {
        if (!e.pin) return;
        e.x = e.pin.x; e.z = e.pin.z; e.vx = 0; e.vz = 0; e.yaw = 0.35;
        e.mesh.position.set(e.x, e.mesh.position.y, e.z);
      });
    }
    g.rings.clear(); g.fx.clear(); g.ui.el.banner.innerHTML = '';
    N.setCamera({ x: 0, y: 10, z: 40, tx: 0, ty: 1.1, tz: 19.5 });
    N.step(1/60,1);
    g.ui.el.banner.innerHTML = '';
  `,
  anim_walk: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,44);
    // let each walker actually travel so the gait plays
    const set = [['skitter',-7],['lancer',0],['sentinel',7.5]];
    set.forEach(([t,x]) => {
      const e = g.enemies.spawn(t, x, 30);
      if (e) { e.state='active'; e.spawnT=1; e.mat.uniforms.uDissolve.value=0; e.mesh.scale.setScalar(e.scale); e.walkX = x; }
    });
    for (let i=0;i<140;i++){
      // vz stays non-zero so the gait clips run, but position is held for framing
      g.enemies.active.forEach(e => { if (e.walkX !== undefined) { e.vx = 0; e.vz = -8; } });
      N.step(1/60);
      g.enemies.active.forEach(e => {
        if (e.walkX === undefined) return;
        e.x = e.walkX; e.z = 20; e.yaw = 0;
        e.mesh.position.set(e.x, e.mesh.position.y, e.z);
      });
    }
    g.rings.clear(); g.fx.clear(); g.ui.el.banner.innerHTML = '';
    N.setCamera({ x: 0, y: 7, z: 36, tx: 0, ty: 1.2, tz: 19.5 });
    N.step(1/60,1);
    g.ui.el.banner.innerHTML = '';
  `,
  anim_attack: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,60);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,34);
    const lancer = g.enemies.spawn('lancer', -7, 20);
    const sentinel = g.enemies.spawn('sentinel', 0.5, 20);
    const drone = g.enemies.spawn('drone', 8, 20);
    [lancer,sentinel,drone].forEach(e => { if(e){ e.state='active'; e.spawnT=1; e.mat.uniforms.uDissolve.value=0; } });
    N.step(1/60, 20);
    if (lancer) { lancer.state='windup'; lancer.stateTime=0; }
    if (sentinel) { sentinel.state='charging'; sentinel.stateTime=0; sentinel.aimX=0; sentinel.aimZ=34; }
    if (drone && drone.animator) drone.animator.play('fire',{fade:0.03,restart:true});
    for (let i=0;i<40;i++){
      N.step(1/60);
      const place = (e, x) => { if (!e) return; e.vx=0; e.vz=0; e.yaw=0; e.x=x; e.z=20; e.mesh.position.set(x, e.mesh.position.y, 20); };
      place(lancer,-7); place(sentinel,0.5); place(drone,8);
    }
    g.rings.clear(); g.ui.el.banner.innerHTML = '';
    N.setCamera({ x: 0, y: 8, z: 37, tx: 0, ty: 1.4, tz: 19.5 });
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
  cine_start: `
    N.setCamera(null);
    N.start('striker','pilot','campaign',5);
    N.step(1/60, 78);
  `,
  cine_boss: `
    N.setCamera(null);
    const g = N.game;
    N.start('striker','pilot','campaign',5);
    N.step(1/60, 40); N.skipCinematic(); N.step(1/60, 10);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.waves.start(5);
    // run to just past the boss reveal beat
    for (let i=0;i<200 && !g.director.running;i++) N.step(1/60);
    N.step(1/60, 55);
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
  arena: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,40);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,0);
    N.setCamera({ x: 0, y: 26, z: 62, tx: 0, ty: 6, tz: 0 });
    N.step(1/60,2);
  `,
  wall: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,40);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,0);
    N.setCamera({ x: 0, y: 5, z: 12, tx: 0, ty: 16, tz: -52 });
    N.step(1/60,2);
  `,
  rocks: `
    const g = N.game;
    N.start('striker','pilot','campaign',1); N.step(1/60,40);
    g.waves.clear(); g.enemies.clear(); g.timers.length = 0;
    g.player.position.set(0,1.05,0);
    N.setCamera({ x: 26, y: 4.2, z: 14, tx: 4, ty: 5, tz: -6 });
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
    await page.evaluate(() => window.__NOVA.freeze(false));
    await page.evaluate(new Function('N', code), await page.evaluateHandle(() => window.__NOVA));
    // Freeze before capturing: otherwise the rAF loop keeps advancing the sim
    // (and any running cinematic) between setup and the screenshot.
    await page.evaluate(() => { window.__NOVA.freeze(true); window.__NOVA.render(); });
    await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
    console.log(`  ✓ ${name}.png`);
  }

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }
}
main();
