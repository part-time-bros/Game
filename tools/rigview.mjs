/**
 * rigview.mjs — isolated model/animation viewer.
 *
 * Builds each rigged model into a bare scene (no gameplay, no AI, no chase
 * camera) and renders a contact sheet of frames across a clip, so poses can be
 * judged without fighting the simulation for control of the camera.
 *
 *   node tools/rigview.mjs              every model, its default clip
 *   node tools/rigview.mjs skitter scuttle
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'docs', 'shots-visual');
const PORT = 8211;

const SHEETS = [
  { model: 'skitter', clip: 'scuttle', dist: 5.5, height: 2.4 },
  { model: 'skitter', clip: 'lunge', dist: 5.5, height: 2.4 },
  { model: 'drone', clip: 'hover', dist: 6.5, height: 2.8 },
  { model: 'splitter', clip: 'idle', dist: 7.5, height: 2.6 },
  { model: 'seeder', clip: 'fire', dist: 8.5, height: 3.4 },
  { model: 'lancer', clip: 'prowl', dist: 9.5, height: 3.4 },
  { model: 'lancer', clip: 'windup', dist: 9.5, height: 3.4 },
  { model: 'sentinel', clip: 'walk', dist: 10.5, height: 4.2 },
  { model: 'sentinel', clip: 'brace', dist: 10.5, height: 4.2 },
  { model: 'ship:striker', clip: 'cruise', dist: 7.5, height: 2.4 },
  { model: 'ship:striker', clip: 'dash', dist: 7.5, height: 2.4 },
  { model: 'ship:bastion', clip: 'idle', dist: 7.5, height: 2.4 },
  { model: 'ship:phantom', clip: 'idle', dist: 7.5, height: 2.4 },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 500));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 320 }, deviceScaleFactor: 1 });
  await ctx.route('**/fonts.g*/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  ! pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  ! console', m.text().slice(0, 200)); });
  await page.goto(`http://localhost:${PORT}/index.html?capture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });

  // hide the game overlay entirely; this viewer owns the canvas
  await page.evaluate(() => {
    window.__NOVA.freeze(true);
    document.getElementById('hud').hidden = true;
    for (const el of document.querySelectorAll('.screen')) el.removeAttribute('data-active');
    document.getElementById('scanlines').style.display = 'none';
    document.getElementById('vignette').style.display = 'none';
  });

  await page.evaluate(async () => {
    const rig = await import('/src/render/rig.js');
    const rm = await import('/src/render/rig-models.js');
    const mats = await import('/src/render/materials.js');
    window.__RV = { rig, rm, mats, cache: new Map() };
  });

  const wanted = process.argv.slice(2);
  const sheets = wanted.length
    ? SHEETS.filter((s) => wanted.includes(s.model) || wanted.includes(s.clip) || wanted.includes(s.model.replace('ship:', '')))
    : SHEETS;

  for (const sheet of sheets) {
    await page.evaluate((s) => {
      const { rig, rm, mats, cache } = window.__RV;
      const g = window.__NOVA.game;
      const key = s.model;
      if (!cache.has(key)) {
        cache.set(key, key.startsWith('ship:')
          ? rm.buildRiggedShip(key.slice(5))
          : rm.RIGGED_ENEMIES[key]());
      }
      const spec = cache.get(key);

      // one throwaway scene per sheet: four instances frozen at four phases
      const scene = new THREE.Scene();
      // Orthographic: a contact sheet must show four copies at identical scale,
      // and a 4:1 perspective frame distorts badly at the edges.
      const halfH = s.height * 1.15;
      const halfW = halfH * 4;
      const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 200);
      const poses = [];
      const spacing = halfW / 2.15;
      for (let i = 0; i < 4; i++) {
        const pose = new rig.Pose(spec.skeleton);
        const mat = mats.createNovaMaterial({ pose, rim: 0.9, spec: 0.4, rimColor: 0x8ff0ff });
        const mesh = new THREE.Mesh(spec.geometry, mat);
        mesh.position.set((i - 1.5) * spacing, 0, 0);
        mesh.rotation.y = 0.55;
        mesh.frustumCulled = false;
        scene.add(mesh);
        const anim = new rig.Animator(pose, spec.clips);
        anim.play(s.clip, { fade: 0 });
        poses.push({ anim, mesh });
      }
      // ground plane so the silhouette has something to sit on
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshBasicMaterial({ color: 0x11182e, toneMapped: false }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.02;
      scene.add(floor);

      camera.position.set(0, s.height * 1.05, 30);
      camera.lookAt(0, s.height * 0.42, 0);
      camera.updateProjectionMatrix();
      mats.setLightDirection(new THREE.Vector3(0.45, 0.8, 0.55), camera);
      // brighter key + fill than the arena: this sheet is for judging form
      const gu = mats.globalUniforms;
      const keepLight = gu.uLightColor.value.clone();
      const keepSky = gu.uSkyColor.value.clone();
      const keepGround = gu.uGroundColor.value.clone();
      gu.uLightColor.value.setRGB(1.5, 1.42, 1.35);
      gu.uSkyColor.value.setRGB(0.34, 0.42, 0.66);
      gu.uGroundColor.value.setRGB(0.12, 0.10, 0.20);
      window.__RV.restoreLights = () => {
        gu.uLightColor.value.copy(keepLight);
        gu.uSkyColor.value.copy(keepSky);
        gu.uGroundColor.value.copy(keepGround);
      };

      const clip = spec.clips[s.clip];
      const dur = clip ? clip.duration : 1;
      poses.forEach((p, i) => {
        // advance each copy to a different phase of the clip
        const target = (i / 4) * dur + 0.001;
        const steps = Math.max(1, Math.round(target * 60));
        for (let k = 0; k < steps; k++) p.anim.update(1 / 60);
      });
      window.__RV.current = { scene, camera, poses, dispose: () => {
        floor.geometry.dispose(); floor.material.dispose();
        poses.forEach((p) => p.mesh.material.dispose());
      } };
      g.renderer.render(scene, camera);
    }, sheet);

    const name = `rig-${sheet.model.replace(':', '-')}-${sheet.clip}`;
    await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
    await page.evaluate(() => { if (window.__RV.current) window.__RV.current.dispose(); });
    console.log(`  ✓ ${name}.png`);
  }

  await browser.close();
  try { process.kill(-server.pid); } catch (e) { /* gone */ }
}
main();
