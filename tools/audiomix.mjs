/**
 * audiomix.mjs — render every effect through an OfflineAudioContext and print
 * peak / RMS / audible duration. This is how the mix gets balanced without
 * being able to listen: the numbers show which cues are buried and which
 * dominate. Run: node tools/audiomix.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8203;
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
await new Promise(r => setTimeout(r, 500));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
await ctx.route('**/fonts.g*/**', r => r.abort());
const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });
const rows = await page.evaluate(async () => {
  const Engine = window.__NOVA.game.audio.constructor;
  const names = ['shoot','shootHeavy','enemyShoot','hit','crit','kill','explosion','dash','pulse','pulseFail','overdrive','overdriveEnd','hurt','shieldHit','shieldBreak','shieldUp','pickup','heal','upgrade','uiHover','uiClick','uiBack','uiDeny','waveStart','waveClear','rift','bossSpawn','bossHurt','bossPhase','charge','beam','mortar','zap','barrier','victory','defeat'];
  const out = [];
  const rate = 22050;
  for (const n of names) {
    const off = new OfflineAudioContext(2, rate * 2, rate);
    const eng = new Engine(); eng.init(off); eng.setVolumes(1,1,1);
    eng.play(n, { gain: 1 });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0, n2 = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += v*v; if (v > 0.001) n2++; }
    out.push({ n, peak: +peak.toFixed(4), rms: +Math.sqrt(sum/d.length).toFixed(5), ms: Math.round(n2/rate*1000) });
  }
  return out;
});
// Ambience is a continuous bed, not a cue, so it never appears above. Render
// it on its own and check the two things that can go wrong: inaudible (the
// silence it exists to fill comes straight back) or loud enough to sit on top
// of the gunfire it is supposed to sit under.
const amb = await page.evaluate(async () => {
  const Engine = window.__NOVA.game.audio.constructor;
  const rate = 22050, secs = 12;
  const out = [];
  for (const [label, I] of [['idle', 0], ['combat', 0.8]]) {
    const off = new OfflineAudioContext(1, rate * secs, rate);
    const eng = new Engine(); eng.init(off); eng.setVolumes(1, 1, 1);
    eng.startAmbience();
    eng.setIntensity(I);
    // the once-a-second tick does not run in an offline render; drive it
    for (let i = 0; i < secs; i++) eng._ambTick();
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0, zc = 0;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i] * d[i];
      if (i && ((d[i] < 0) !== (d[i - 1] < 0))) zc++;
    }
    // how much the level moves across the render: a bed that never swells
    // reads as hiss and stops being heard within a minute
    const win = Math.floor(rate * 0.5);
    const lv = [];
    for (let i = 0; i + win < d.length; i += win) {
      let e = 0; for (let j = i; j < i + win; j++) e += d[j] * d[j];
      lv.push(Math.sqrt(e / win));
    }
    const lo = Math.min(...lv), hi = Math.max(...lv);
    out.push({ label, peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(5),
               brightHz: Math.round(zc / secs / 2), swing: +(hi / Math.max(1e-6, lo)).toFixed(2) });
  }
  return out;
});

rows.sort((a,b) => b.peak - a.peak);
console.log('ambience        peak     rms      brightness  level swing');
for (const a of amb) {
  console.log(`${a.label.padEnd(14)} ${String(a.peak).padStart(6)}  ${String(a.rms).padStart(7)}  ${String(a.brightHz).padStart(8)} Hz  ${String(a.swing).padStart(6)}x`);
}
console.log('');
console.log('effect          peak     rms      dur(ms)');
for (const r of rows) console.log(r.n.padEnd(15), String(r.peak).padStart(7), String(r.rms).padStart(8), String(r.ms).padStart(6));
await browser.close();
try { process.kill(-server.pid); } catch (e) { /* gone */ }
