/**
 * audio.js — 100% procedural audio. No sample files ship with the game:
 * every effect is synthesised from oscillators + generated noise buffers, and
 * the soundtrack is a small generative sequencer whose layers follow combat
 * intensity.
 *
 * Signal graph:
 *   [voices] -> sfxBus  -\
 *                         >-- masterBus -> limiter -> destination
 *   [sequencer] -> musBus/
 *   both buses also feed a convolution reverb (procedural impulse) -> masterBus
 */
import { clamp, clamp01, lerp } from './util.js';

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);   // MIDI -> Hz

// i - VI - III - VII in D natural minor, one bar each.
const PROGRESSION = [
  { root: 50, chord: [50, 53, 57], name: 'Dm' },
  { root: 46, chord: [46, 50, 53], name: 'Bb' },
  { root: 53, chord: [53, 57, 60], name: 'F' },
  { root: 48, chord: [48, 52, 55], name: 'C' },
];
const SCALE = [0, 2, 3, 5, 7, 8, 10];                   // natural minor degrees

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.master = 0.85; this.musicVol = 0.6; this.sfxVol = 0.9;
    this._lastPlay = new Map();
    this._voices = 0;
    this._maxVoices = 26;
    this.intensity = 0;
    this._targetIntensity = 0;
    this.musicOn = false;
    this._step = 0;
    this._nextNoteTime = 0;
    this._timer = null;
    this._bpm = 104;
    this._mode = 'menu';       // menu | combat | boss | victory | defeat
    this._duckUntil = 0;
    this.offline = false;
  }

  /**
   * Must be triggered by a user gesture; safe to call repeatedly.
   * `contextOverride` lets the test suite render the whole graph into an
   * OfflineAudioContext and measure that every effect is actually audible.
   */
  init(contextOverride) {
    if (this.ready || this.failed) return this.ready;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC && !contextOverride) { this.failed = true; return false; }
      const ctx = contextOverride || new AC({ latencyHint: 'interactive' });
      this.offline = !!contextOverride;
      this.ctx = ctx;

      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 8;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;
      this.limiter.connect(ctx.destination);

      this.masterBus = ctx.createGain();
      this.masterBus.gain.value = this.master;
      this.masterBus.connect(this.limiter);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.sfxVol;
      this.sfxBus.connect(this.masterBus);

      this.musBus = ctx.createGain();
      this.musBus.gain.value = 0;
      this.musBus.connect(this.masterBus);

      // --- procedural reverb ---
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._makeImpulse(2.1, 2.6);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.34;
      this.reverb.connect(this.reverbGain);
      this.reverbGain.connect(this.masterBus);

      this.sfxSend = ctx.createGain();
      this.sfxSend.gain.value = 0.22;
      this.sfxSend.connect(this.reverb);
      this.sfxBus.connect(this.sfxSend);

      this.musSend = ctx.createGain();
      this.musSend.gain.value = 0.3;
      this.musSend.connect(this.reverb);
      this.musBus.connect(this.musSend);

      this.noise = this._makeNoise(2.0);
      this.ready = true;
      this._nextNoteTime = ctx.currentTime + 0.08;
      return true;
    } catch (e) {
      console.warn('[audio] unavailable:', e && e.message);
      this.failed = true;
      return false;
    }
  }

  resume() {
    if (!this.ready) { this.init(); }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }

  setVolumes(master, music, sfx) {
    this.master = master; this.musicVol = music; this.sfxVol = sfx;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.masterBus.gain.setTargetAtTime(master, t, 0.02);
    this.sfxBus.gain.setTargetAtTime(sfx, t, 0.02);
    this.musBus.gain.setTargetAtTime(this.musicOn ? music : 0, t, 0.05);
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // gentle brown tilt keeps it less hissy
      d[i] = w * 0.7 + last * 2.2;
    }
    return buf;
  }

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // sparse early reflections + exponential tail reads as a big metal hall
        const early = (i < ctx.sampleRate * 0.09 && Math.random() < 0.006) ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * 0.55 + early) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  _now() { return this.ctx.currentTime; }

  _gate(name, minGap) {
    const t = this.ctx.currentTime;
    const last = this._lastPlay.get(name) || -1;
    if (t - last < minGap) return false;
    this._lastPlay.set(name, t);
    return true;
  }

  _voice(node, stopAt) {
    if (this._voices > this._maxVoices) return false;
    this._voices++;
    node.onended = () => { this._voices--; try { node.disconnect(); } catch (e) {} };
    return true;
  }

  /** Short helper: oscillator with an ADSR-ish gain, routed to a destination bus. */
  _tone(opts) {
    const ctx = this.ctx, t0 = opts.at !== undefined ? opts.at : ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    const g = ctx.createGain();
    const dest = opts.dest || this.sfxBus;
    const vol = (opts.gain !== undefined ? opts.gain : 0.3);
    osc.frequency.setValueAtTime(Math.max(20, opts.f0), t0);
    if (opts.f1 !== undefined && opts.f1 !== opts.f0) {
      if (opts.expo === false) osc.frequency.linearRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
      else osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
    }
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t0);
    const atk = opts.attack !== undefined ? opts.attack : 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    let node = osc;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.setValueAtTime(opts.cutoff0 || 1200, t0);
      if (opts.cutoff1) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.cutoff1), t0 + opts.dur);
      f.Q.value = opts.q || 1;
      node.connect(f); f.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.03);
    this._voice(osc);
    return osc;
  }

  /** Filtered noise burst — the backbone of impacts, whooshes and explosions. */
  _noiseBurst(opts) {
    const ctx = this.ctx, t0 = opts.at !== undefined ? opts.at : ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = opts.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = opts.filter || 'bandpass';
    f.frequency.setValueAtTime(Math.max(30, opts.f0), t0);
    if (opts.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.f1), t0 + opts.dur);
    f.Q.value = opts.q || 1.1;
    const g = ctx.createGain();
    const vol = opts.gain !== undefined ? opts.gain : 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (opts.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(f); f.connect(g); g.connect(opts.dest || this.sfxBus);
    src.start(t0, Math.random() * 1.4);
    src.stop(t0 + opts.dur + 0.02);
    this._voice(src);
    return src;
  }

  /** Momentarily dip music so an event punches through. */
  duck(amount = 0.5, time = 0.35) {
    if (!this.ready || !this.musicOn) return;
    const t = this.ctx.currentTime;
    const g = this.musBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.musicVol * (1 - amount), t + 0.04);
    g.linearRampToValueAtTime(this.musicVol, t + time);
  }

  /**
   * A firearm report, built the way one is actually shaped.
   *
   *   crack  the supersonic snap off the bullet. Sub-millisecond attack, mostly
   *          high frequency. This is the part that says "gun" rather than
   *          "thud", and it is the part a pitch-swept oscillator cannot fake.
   *   body   the muzzle blast — the low end you feel in your chest.
   *   tail   the report coming back off the canyon a moment later. The send to
   *          the convolution reverb does the rest.
   *
   * The old cue was a sawtooth sweeping 900Hz down to 290Hz: a textbook sci-fi
   * laser, which is exactly what it sounded like in a western.
   */
  _gunshot(o) {
    const v = o.gain !== undefined ? o.gain : 1;
    const p = o.pitch || 1;
    const t0 = this._now();
    const jitter = 0.94 + Math.random() * 0.12;   // no two rounds identical
    // The crack has to be loud as well as high: a highpass throws most of the
    // noise away, so a gain that looks large here is not one you hear.
    this._noiseBurst({
      filter: 'highpass', f0: 3000 * p * jitter, f1: 1400 * p, q: 0.5,
      dur: o.crackDur || 0.05, gain: 0.95 * v * (o.crack !== undefined ? o.crack : 1),
      attack: 0.0005, at: t0,
    });
    this._noiseBurst({
      filter: 'lowpass', f0: 1150 * p, f1: 190, q: 0.8,
      dur: o.bodyDur || 0.11, gain: 0.20 * v, attack: 0.0008, at: t0,
    });
    this._tone({
      type: 'sine', f0: (o.thump || 155) * p * jitter, f1: 46,
      dur: (o.bodyDur || 0.11) * 1.2, gain: 0.19 * v, attack: 0.0008, at: t0,
    });
    if (o.tail !== 0) {
      this._noiseBurst({
        filter: 'lowpass', f0: 1500, f1: 250, q: 0.6,
        dur: o.tailDur || 0.42, gain: 0.07 * v * (o.tail || 1),
        attack: 0.022, at: t0 + 0.012,
      });
    }
  }

  // ======================================================================
  //  SFX library
  // ======================================================================
  play(name, opts = {}) {
    if (!this.ready || (!this.offline && this.ctx.state !== 'running')) return;
    const v = opts.gain !== undefined ? opts.gain : 1;
    const p = opts.pitch !== undefined ? opts.pitch : 1;
    switch (name) {
      case 'shoot': {
        if (!this._gate('shoot', 0.028)) return;
        // Rapid fire only gets a tail every few rounds: real reports blur into
        // one another, and four voices per shot at 35 rounds a second would
        // eat the whole voice budget on its own.
        // start at 0 so a single tapped shot gets its tail — the case where
        // you most notice its absence
        this._shotN = this._shotN === undefined ? 0 : (this._shotN + 1) % 3;
        // held back a little: this fires several times a second, and at parity
        // with the explosion cue it pumps the limiter on its own
        this._gunshot({
          gain: v * 0.76, pitch: p * 1.15, crackDur: 0.042, bodyDur: 0.085,
          thump: 172, tail: this._shotN === 0 ? 1 : 0, tailDur: 0.34,
        });
        break;
      }
      case 'shootHeavy': {
        if (!this._gate('shootHeavy', 0.04)) return;
        // buffalo rifle: less crack, far more body, and a tail that rolls
        this._gunshot({
          gain: v * 1.15, pitch: p * 0.68, crack: 0.8, crackDur: 0.06,
          bodyDur: 0.19, thump: 104, tail: 1.6, tailDur: 0.7,
        });
        this.duck(0.14, 0.3);
        break;
      }
      case 'enemyShoot': {
        if (!this._gate('enemyShoot', 0.05)) return;
        // heard from across the arena: the crack thins out, the tail does not
        this._gunshot({
          gain: v * 0.72, pitch: p * 0.86, crack: 0.45, crackDur: 0.05,
          bodyDur: 0.1, thump: 132, tail: 1.3, tailDur: 0.5,
        });
        break;
      }
      case 'hit': {
        if (!this._gate('hit', 0.022)) return;
        // lead into hide and timber: a dull thwack, no ring
        this._noiseBurst({ filter: 'bandpass', f0: 1500 * p, f1: 420, dur: 0.055, gain: 0.21 * v, attack: 0.0008, q: 1.0 });
        this._tone({ type: 'triangle', f0: 300 * p, f1: 120, dur: 0.07, gain: 0.13 * v, attack: 0.001 });
        break;
      }
      case 'crit': {
        if (!this._gate('crit', 0.03)) return;
        // a spang off iron, with the ricochet whine going away from you
        this._noiseBurst({ filter: 'highpass', f0: 4600, f1: 1500, dur: 0.07, gain: 0.22 * v, attack: 0.0005, q: 0.9 });
        this._tone({ type: 'triangle', f0: 2400 * p, f1: 700, dur: 0.26, gain: 0.12 * v, attack: 0.002 });
        this._tone({ type: 'sine', f0: 1750 * p, f1: 520, dur: 0.30, gain: 0.07 * v, attack: 0.003, detune: 14 });
        break;
      }
      case 'kill': {
        if (!this._gate('kill', 0.035)) return;
        // something heavy going down, and the dust it kicks up
        this._tone({ type: 'sine', f0: 190, f1: 40, dur: 0.34, gain: 0.21 * v, attack: 0.002 });
        this._noiseBurst({ filter: 'lowpass', f0: 900, f1: 130, dur: 0.34, gain: 0.16 * v, attack: 0.004, q: 0.7 });
        break;
      }
      case 'explosion': {
        // dynamite: a blast, then the report off the walls, then falling rock
        const size = opts.size || 1;
        const t0 = this._now();
        this._noiseBurst({ filter: 'highpass', f0: 3800, f1: 900, dur: 0.06, gain: 0.20 * v, attack: 0.0006, at: t0 });
        this._tone({ type: 'sine', f0: 150 / size, f1: 28, dur: 0.6 * size, gain: 0.36 * v, attack: 0.002, at: t0 });
        this._noiseBurst({ filter: 'lowpass', f0: 900 / size, f1: 70, dur: 0.55 * size, gain: 0.30 * v, attack: 0.003, q: 0.7, at: t0 });
        this._noiseBurst({ filter: 'bandpass', f0: 2600, f1: 700, dur: 0.5 * size, gain: 0.07 * v, attack: 0.09, q: 0.9, at: t0 + 0.07 });
        this.duck(0.28, 0.45);
        break;
      }
      case 'dash': {
        // spur and a whip crack, then the surge
        this._noiseBurst({ filter: 'highpass', f0: 6000, f1: 2200, dur: 0.035, gain: 0.26 * v, attack: 0.0005, q: 0.8 });
        this._noiseBurst({ filter: 'bandpass', f0: 500, f1: 2600, dur: 0.2, gain: 0.20 * v, attack: 0.01, q: 1.0 });
        this._tone({ type: 'sine', f0: 260, f1: 80, dur: 0.28, gain: 0.18 * v, attack: 0.004 });
        break;
      }
      case 'pulse': {
        // both barrels at once
        this._gunshot({ gain: v * 1.3, pitch: 0.55, crack: 1.1, crackDur: 0.07, bodyDur: 0.26, thump: 82, tail: 2.0, tailDur: 0.9 });
        this._tone({ type: 'sine', f0: 120, f1: 30, dur: 0.5, gain: 0.30 * v, attack: 0.003 });
        this.duck(0.3, 0.45);
        break;
      }
      case 'pulseFail':
        this._tone({ type: 'square', f0: 180, f1: 90, dur: 0.1, gain: 0.07 * v, filter: 'lowpass', cutoff0: 600 });
        break;
      case 'overdrive': {
        const t0 = this._now();
        for (let i = 0; i < 4; i++) {
          this._tone({ type: 'sawtooth', f0: NOTE(38 + i * 7), f1: NOTE(50 + i * 7), dur: 0.9, gain: 0.09 * v, at: t0 + i * 0.03, filter: 'lowpass', cutoff0: 400, cutoff1: 5200, q: 3 });
        }
        this._noiseBurst({ f0: 200, f1: 8000, dur: 0.7, gain: 0.16 * v, q: 0.6 });
        this.duck(0.4, 0.8);
        break;
      }
      case 'overdriveEnd':
        this._tone({ type: 'sawtooth', f0: 900, f1: 120, dur: 0.5, gain: 0.13 * v, filter: 'lowpass', cutoff0: 3000, cutoff1: 300 });
        break;
      case 'hurt': {
        if (!this._gate('hurt', 0.09)) return;
        this._tone({ type: 'sawtooth', f0: 190, f1: 62, dur: 0.26, gain: 0.24 * v, filter: 'lowpass', cutoff0: 900, cutoff1: 190, q: 2 });
        this._noiseBurst({ f0: 900, f1: 160, dur: 0.2, gain: 0.16 * v, filter: 'lowpass' });
        break;
      }
      case 'shieldHit': {
        if (!this._gate('shieldHit', 0.06)) return;
        this._tone({ type: 'triangle', f0: 1250, f1: 480, dur: 0.17, gain: 0.12 * v });
        this._noiseBurst({ f0: 4200, f1: 1500, dur: 0.11, gain: 0.09 * v, q: 2.4 });
        break;
      }
      case 'shieldBreak': {
        const t0 = this._now();
        for (let i = 0; i < 6; i++) {
          this._tone({ type: 'triangle', f0: 900 + i * 420, f1: 300 + i * 120, dur: 0.34, gain: 0.055 * v, at: t0 + i * 0.012 });
        }
        this._noiseBurst({ f0: 6000, f1: 800, dur: 0.4, gain: 0.16 * v, q: 1.2 });
        break;
      }
      case 'shieldUp':
        this._tone({ type: 'triangle', f0: 320, f1: 1400, dur: 0.35, gain: 0.2 * v, filter: 'bandpass', cutoff0: 420, cutoff1: 1800, q: 1.2 });
        break;
      case 'pickup': {
        if (!this._gate('pickup', 0.035)) return;
        const b = 880 * p;
        this._tone({ type: 'triangle', f0: b, f1: b * 1.5, dur: 0.09, gain: 0.09 * v });
        this._tone({ type: 'sine', f0: b * 1.5, f1: b * 2.0, dur: 0.11, gain: 0.06 * v, at: this._now() + 0.05 });
        break;
      }
      case 'heal': {
        const t0 = this._now();
        [0, 4, 7, 12].forEach((s, i) => this._tone({ type: 'triangle', f0: NOTE(62 + s), dur: 0.34, gain: 0.075 * v, at: t0 + i * 0.055 }));
        break;
      }
      case 'upgrade': {
        const t0 = this._now();
        [0, 7, 12, 16, 19].forEach((s, i) => {
          this._tone({ type: 'triangle', f0: NOTE(50 + s), dur: 0.7, gain: 0.085 * v, at: t0 + i * 0.05, filter: 'lowpass', cutoff0: 5000 });
        });
        this._noiseBurst({ f0: 2000, f1: 8000, dur: 0.3, gain: 0.06 * v });
        break;
      }
      case 'uiHover':
        if (!this._gate('uiHover', 0.04)) return;
        this._tone({ type: 'square', f0: 1500, f1: 1800, dur: 0.045, gain: 0.075 * v, filter: 'bandpass', cutoff0: 1650, q: 1.4 });
        break;
      case 'uiClick':
        this._tone({ type: 'square', f0: 700, f1: 1400, dur: 0.07, gain: 0.13 * v, filter: 'bandpass', cutoff0: 1000, q: 1.3 });
        this._noiseBurst({ f0: 3000, f1: 6000, dur: 0.05, gain: 0.06 * v });
        break;
      case 'uiBack':
        this._tone({ type: 'square', f0: 900, f1: 420, dur: 0.09, gain: 0.12 * v, filter: 'bandpass', cutoff0: 640, q: 1.3 });
        break;
      case 'uiDeny':
        this._tone({ type: 'square', f0: 220, f1: 160, dur: 0.14, gain: 0.07 * v, filter: 'lowpass', cutoff0: 700 });
        break;
      case 'waveStart': {
        const t0 = this._now();
        this._tone({ type: 'sawtooth', f0: 90, f1: 620, dur: 1.0, gain: 0.12 * v, filter: 'lowpass', cutoff0: 300, cutoff1: 3000, q: 4 });
        this._tone({ type: 'sine', f0: 120, f1: 40, dur: 0.9, gain: 0.2 * v, at: t0 + 0.85 });
        this._noiseBurst({ f0: 300, f1: 5000, dur: 0.9, gain: 0.1 * v, q: 0.7 });
        break;
      }
      case 'waveClear': {
        const t0 = this._now();
        [0, 5, 7, 12].forEach((s, i) => this._tone({ type: 'triangle', f0: NOTE(53 + s), dur: 0.9, gain: 0.09 * v, at: t0 + i * 0.08 }));
        break;
      }
      case 'rift': {
        if (!this._gate('rift', 0.15)) return;
        this._noiseBurst({ f0: 180, f1: 1400, dur: 0.7, gain: 0.09 * v, q: 2.2 });
        this._tone({ type: 'sawtooth', f0: 60, f1: 150, dur: 0.8, gain: 0.07 * v, filter: 'lowpass', cutoff0: 300, cutoff1: 900 });
        break;
      }
      case 'bossSpawn': {
        const t0 = this._now();
        for (let i = 0; i < 5; i++) {
          this._tone({ type: 'sawtooth', f0: NOTE(26 + i), f1: NOTE(26 + i) * 0.985, dur: 2.6, gain: 0.085 * v, at: t0, detune: (i - 2) * 12, filter: 'lowpass', cutoff0: 220, cutoff1: 1500, q: 5, expo: false });
        }
        this._noiseBurst({ f0: 90, f1: 2600, dur: 2.2, gain: 0.14 * v, q: 0.7 });
        this.duck(0.55, 2.0);
        break;
      }
      case 'bossHurt':
        if (!this._gate('bossHurt', 0.1)) return;
        this._tone({ type: 'sawtooth', f0: 150, f1: 70, dur: 0.3, gain: 0.14 * v, filter: 'lowpass', cutoff0: 700, cutoff1: 200 });
        break;
      case 'bossPhase': {
        const t0 = this._now();
        [0, 3, 7].forEach((s, i) => this._tone({ type: 'sawtooth', f0: NOTE(38 + s), dur: 1.4, gain: 0.1 * v, at: t0 + i * 0.09, filter: 'lowpass', cutoff0: 800, cutoff1: 2600 }));
        this._noiseBurst({ f0: 4000, f1: 300, dur: 1.0, gain: 0.13 * v });
        this.duck(0.4, 1.0);
        break;
      }
      case 'charge': {
        if (!this._gate('charge', 0.2)) return;
        this._tone({ type: 'sawtooth', f0: 180, f1: 1500, dur: opts.dur || 0.9, gain: 0.17 * v, filter: 'bandpass', cutoff0: 320, cutoff1: 2000, q: 2.2 });
        break;
      }
      case 'beam':
        this._noiseBurst({ f0: 1800, f1: 900, dur: opts.dur || 0.6, gain: 0.14 * v, q: 3 });
        this._tone({ type: 'sawtooth', f0: 340, f1: 300, dur: opts.dur || 0.6, gain: 0.1 * v, filter: 'bandpass', cutoff0: 1200, q: 5, expo: false });
        break;
      case 'mortar':
        if (!this._gate('mortar', 0.06)) return;
        this._tone({ type: 'sine', f0: 300, f1: 900, dur: 0.2, gain: 0.1 * v });
        this._noiseBurst({ f0: 700, f1: 2000, dur: 0.16, gain: 0.07 * v });
        break;
      case 'zap':
        if (!this._gate('zap', 0.04)) return;
        this._noiseBurst({ f0: 6000, f1: 2000, dur: 0.09, gain: 0.09 * v, q: 3 });
        this._tone({ type: 'square', f0: 2400, f1: 700, dur: 0.07, gain: 0.05 * v });
        break;
      case 'barrier':
        if (!this._gate('barrier', 0.25)) return;
        this._tone({ type: 'sine', f0: 260, f1: 130, dur: 0.24, gain: 0.11 * v });
        this._noiseBurst({ f0: 900, f1: 2600, dur: 0.2, gain: 0.07 * v, q: 2 });
        break;
      case 'victory': {
        const t0 = this._now();
        [50, 57, 62, 65, 69, 74].forEach((n, i) => {
          this._tone({ type: 'triangle', f0: NOTE(n), dur: 2.4 - i * 0.15, gain: 0.1 * v, at: t0 + i * 0.13, filter: 'lowpass', cutoff0: 6000 });
          this._tone({ type: 'sawtooth', f0: NOTE(n) * 0.5, dur: 2.0, gain: 0.045 * v, at: t0 + i * 0.13, filter: 'lowpass', cutoff0: 1400 });
        });
        break;
      }
      case 'defeat': {
        const t0 = this._now();
        [50, 48, 46, 43].forEach((n, i) => {
          this._tone({ type: 'sawtooth', f0: NOTE(n), dur: 2.6, gain: 0.09 * v, at: t0 + i * 0.28, filter: 'lowpass', cutoff0: 1600, cutoff1: 260, q: 2 });
        });
        this._noiseBurst({ f0: 600, f1: 60, dur: 2.4, gain: 0.1 * v, filter: 'lowpass' });
        break;
      }
      default:
        break;
    }
  }

  // ======================================================================
  //  Generative soundtrack
  // ======================================================================
  /** Tempo per mode. A spaghetti-western vamp walks; it does not sprint. */
  _tempoFor(mode) {
    if (mode === 'boss') return 118;
    if (mode === 'combat') return 104;
    return 76;
  }

  startMusic(mode = 'menu') {
    if (!this.ready) return;
    this._mode = mode;
    // Set the tempo here too. setMusicMode early-returns when the mode has not
    // changed, so starting straight into a mode used to inherit whatever bpm
    // happened to be left over from the last one.
    this._bpm = this._tempoFor(mode);
    this.musicOn = true;
    this.musBus.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.4);
    if (this._timer) return;
    this._step = 0;
    this._nextNoteTime = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._scheduler(), 25);
  }

  stopMusic(fade = 0.6) {
    if (!this.ready) return;
    this.musicOn = false;
    this.musBus.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  setMusicMode(mode) {
    if (this._mode === mode) return;
    this._mode = mode;
    this._bpm = this._tempoFor(mode);
  }

  setIntensity(v) { this._targetIntensity = clamp01(v); }

  _scheduler() {
    if (!this.ready || !this.musicOn || (!this.offline && this.ctx.state !== 'running')) return;
    const spb = 60 / this._bpm;
    const stepDur = spb / 4;                      // 16th notes
    const horizon = this.ctx.currentTime + 0.16;
    let guard = 0;
    while (this._nextNoteTime < horizon && guard++ < 32) {
      this._scheduleStep(this._step, this._nextNoteTime, stepDur);
      this._nextNoteTime += stepDur;
      this._step = (this._step + 1) % 64;         // 4 bars
    }
    this.intensity = lerp(this.intensity, this._targetIntensity, 0.06);
  }

  /**
   * One 16th-note step of the score.
   *
   * The harmony was always right for this — a natural-minor vamp is where
   * spaghetti westerns live — but the voicing was a synthwave kit: four-on-the
   * floor drums, a resonant sawtooth bass and a random arpeggio. Over a desert
   * that reads as parody. Same chords, rebuilt as instruments instead:
   *
   *   guitar   plucked chord tones, hard attack and a fast decay through a
   *            closing lowpass, with a noise transient for the pick
   *   bass     upright: a short round triangle on the root, no filter sweep
   *   perc     a low hand drum and a woodblock rather than a kick and snare,
   *            with a gallop pattern when the fight gets going
   *   lead     two detuned reeds through a bandpass, held long — a harmonica
   *            phrase, sparse enough to leave room for the gunfire
   *   drone    a quiet sustained low bed, the only survivor of the old pads
   */
  _scheduleStep(step, t, stepDur) {
    const bar = Math.floor(step / 16);
    const six = step % 16;
    const prog = PROGRESSION[bar % PROGRESSION.length];
    const I = this.intensity;
    const boss = this._mode === 'boss';
    const menu = this._mode === 'menu';
    const dest = this.musBus;

    // ---- percussion ----
    if (!menu) {
      // low hand drum: steady on the half-bar, gallop when the pressure is on
      const gallop = boss || I > 0.55;
      const drumOn = six === 0 || six === 8 || (gallop && (six === 3 || six === 11)) || (boss && six === 14);
      if (drumOn) {
        const deep = six === 0 || six === 8;
        this._tone({
          type: 'sine', f0: deep ? 96 : 128, f1: deep ? 44 : 62,
          dur: deep ? 0.3 : 0.16, gain: deep ? 0.33 : 0.18, at: t, dest, attack: 0.003,
        });
        this._noiseBurst({ filter: 'lowpass', f0: 320, f1: 90, dur: 0.07, gain: 0.07, at: t, dest, q: 0.7 });
      }
      // woodblock on the backbeat — dry, wooden, no snare rattle
      if (six === 4 || six === 12) {
        this._noiseBurst({ filter: 'bandpass', f0: 2400, f1: 1500, dur: 0.045, gain: 0.11 + I * 0.05, at: t, dest, q: 3.2, attack: 0.0008 });
        this._tone({ type: 'triangle', f0: 1150, f1: 800, dur: 0.05, gain: 0.06, at: t, dest, attack: 0.001 });
      }
      // shaker, only once the fight is moving
      if (I > 0.3 && step % 2 === 1) {
        this._noiseBurst({ filter: 'highpass', f0: 7000, f1: 5200, dur: 0.03, gain: 0.022 + I * 0.02, at: t, dest, q: 0.7 });
      }
    }

    // ---- upright bass ----
    if (!menu || I > 0.1) {
      const walk = boss ? [0, 4, 8, 12] : [0, 8];
      if (walk.includes(six) || (I > 0.5 && six === 14)) {
        const fifth = six === 14 || (boss && six === 12);
        this._tone({
          type: 'triangle', f0: NOTE(prog.root - 12 + (fifth ? 7 : 0)),
          dur: stepDur * 3.2, gain: 0.20 + I * 0.06, at: t, dest, attack: 0.006,
          filter: 'lowpass', cutoff0: 520, cutoff1: 260, q: 1.1, expo: false,
        });
      }
    }

    // ---- guitar ----
    // Eighth notes through the chord, which is the figure the whole genre runs
    // on. Deterministic rather than random: a fixed arpeggio is what makes it
    // sound played rather than generated.
    if (step % 2 === 0) {
      const idx = (step / 2) % 4;
      const shape = [0, 1, 2, 1];               // root, third, fifth, third
      const note = prog.chord[shape[idx]] + 12;
      const play = menu ? (six % 8 === 0) : (I > 0.22 || six % 4 === 0);
      if (play) {
        const g = menu ? 0.085 : 0.075 + I * 0.045;
        this._noiseBurst({ filter: 'highpass', f0: 3600, f1: 2000, dur: 0.02, gain: g * 0.5, at: t, dest, q: 0.8, attack: 0.0005 });
        this._tone({
          type: 'triangle', f0: NOTE(note), dur: stepDur * 3.4, gain: g, at: t, dest,
          attack: 0.002, filter: 'lowpass', cutoff0: 2600, cutoff1: 700, q: 1.4,
        });
        // a second string an octave down on the downbeat, for body
        if (six === 0 || six === 8) {
          this._tone({
            type: 'triangle', f0: NOTE(note - 12), dur: stepDur * 3.0, gain: g * 0.6, at: t, dest,
            attack: 0.003, filter: 'lowpass', cutoff0: 1500, cutoff1: 500, q: 1.2, detune: -4,
          });
        }
      }
    }

    // ---- harmonica lead ----
    // Sparse by design: it has to sit above the mix without competing with the
    // gunfire, so it only speaks at phrase boundaries.
    const leadAt = boss ? (six === 0 || six === 10) : (six === 0 && bar % 2 === 1);
    if (leadAt && (menu ? bar % 2 === 0 : I > 0.18)) {
      const deg = SCALE[[0, 2, 4, 6][bar % 4]];
      const f = NOTE(prog.root + 12 + deg);
      const g = (menu ? 0.05 : 0.035 + I * 0.04);
      const dur = stepDur * (boss ? 6 : 11);
      // two reeds slightly apart: the beating between them is the sound
      this._tone({ type: 'square', f0: f, dur, gain: g, at: t, dest, attack: 0.09, detune: -9, filter: 'bandpass', cutoff0: 1500, q: 2.2 });
      this._tone({ type: 'square', f0: f, dur, gain: g * 0.9, at: t, dest, attack: 0.13, detune: 11, filter: 'bandpass', cutoff0: 1900, q: 2.6 });
    }

    // ---- drone ----
    if (six === 0) {
      const droneGain = menu ? 0.045 : 0.026 + I * 0.022;
      this._tone({ type: 'sawtooth', f0: NOTE(prog.root - 24), dur: stepDur * 15, gain: droneGain, at: t, dest, attack: 0.6, filter: 'lowpass', cutoff0: 240 + I * 220, q: 1.2, expo: false });
      this._tone({ type: 'sawtooth', f0: NOTE(prog.root - 12), dur: stepDur * 15, gain: droneGain * 0.7, at: t, dest, attack: 0.8, detune: 6, filter: 'lowpass', cutoff0: 300 + I * 260, q: 1.2, expo: false });
      if (boss) {
        this._tone({ type: 'sawtooth', f0: NOTE(prog.root - 24), dur: stepDur * 16, gain: 0.1, at: t, dest, attack: 0.3, filter: 'lowpass', cutoff0: 180, q: 3, expo: false });
      }
    }
  }

  dispose() {
    this.stopMusic(0.05);
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { if (this.ctx) this.ctx.close(); } catch (e) { /* ignore */ }
    this.ready = false;
  }
}

export const audio = new AudioEngine();
