/**
 * gunshape.mjs — is a weapon cue actually shaped like a gunshot?
 *
 * The mix tool says how loud a cue is; it cannot say what kind of sound it is.
 * A laser and a gunshot can measure identically on peak and RMS while sounding
 * nothing alike, because the difference is in the envelope and the spectrum:
 *
 *   attack     a firearm peaks within a couple of milliseconds. A pitch-swept
 *              oscillator ramps in over tens of milliseconds.
 *   transient  most of the energy lands in the first tenth of a second, and
 *              what follows is a decaying tail, not a sustained tone.
 *   spread     the crack is broadband. A laser is one narrow sweeping partial,
 *              so its spectrum is concentrated and its centroid glides.
 *
 * Run: node tools/gunshape.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require_ = createRequire(import.meta.url);
const { chromium } = require_(execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8207;
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js'), String(PORT)], { stdio: 'ignore', detached: true });
await new Promise(r => setTimeout(r, 600));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__NOVA, null, { timeout: 60000 });

const rows = await page.evaluate(async () => {
  const Engine = window.__NOVA.game.audio.constructor;
  const names = ['shoot', 'shootHeavy', 'enemyShoot', 'pulse', 'explosion', 'crit', 'hit'];
  const rate = 44100;
  const out = [];
  for (const n of names) {
    const off = new OfflineAudioContext(1, rate * 2, rate);
    const eng = new Engine(); eng.init(off); eng.setVolumes(1, 1, 1);
    eng.play(n, { gain: 1 });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, peakAt = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) { peak = v; peakAt = i; } }
    const band = (a, b) => {
      let s = 0;
      for (let i = Math.floor(a * rate); i < Math.min(d.length, Math.floor(b * rate)); i++) s += d[i] * d[i];
      return s;
    };
    const total = band(0, 2) || 1e-12;
    // crude spectral centroid over the first 60ms, via zero-crossing density
    let zc = 0;
    const win = Math.floor(0.06 * rate);
    for (let i = 1; i < win; i++) if ((d[i] < 0) !== (d[i - 1] < 0)) zc++;
    out.push({
      n,
      peakMs: +(peakAt / rate * 1000).toFixed(1),
      e10: +(band(0, 0.01) / total * 100).toFixed(1),
      e100: +(band(0, 0.1) / total * 100).toFixed(1),
      tail: +(band(0.1, 2) / total * 100).toFixed(1),
      zcHz: Math.round(zc / 0.06 / 2),
    });
  }
  return out;
});

console.log('cue           peak@ms   energy<10ms  energy<100ms   tail>100ms   crack pitch');
for (const r of rows) {
  console.log(`${r.n.padEnd(12)} ${String(r.peakMs).padStart(6)}   ${String(r.e10).padStart(9)}%  ${String(r.e100).padStart(10)}%  ${String(r.tail).padStart(9)}%   ${String(r.zcHz).padStart(7)} Hz`);
}
console.log('\nA firearm: peak within ~3ms, most energy inside 100ms, a real tail after it,');
console.log('and a crack up in the kilohertz. A laser peaks late and sits under ~1kHz.');
await browser.close();
try { process.kill(-server.pid); } catch {}
