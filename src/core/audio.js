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
    this._bpm = 124;
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
        const f = 900 * p * (0.94 + Math.random() * 0.12);
        this._tone({ type: 'sawtooth', f0: f, f1: f * 0.32, dur: 0.12, gain: 0.30 * v, filter: 'bandpass', cutoff0: f * 1.5, cutoff1: f * 0.7, q: 1.5 });
        this._noiseBurst({ f0: 2600, f1: 800, dur: 0.06, gain: 0.14 * v, q: 0.8 });
        break;
      }
      case 'shootHeavy': {
        if (!this._gate('shootHeavy', 0.04)) return;
        this._tone({ type: 'square', f0: 420 * p, f1: 120, dur: 0.16, gain: 0.2 * v, filter: 'lowpass', cutoff0: 2200, cutoff1: 500, q: 3 });
        this._noiseBurst({ f0: 1800, f1: 300, dur: 0.13, gain: 0.13 * v });
        break;
      }
      case 'enemyShoot': {
        if (!this._gate('enemyShoot', 0.05)) return;
        this._tone({ type: 'square', f0: 320 * p, f1: 140 * p, dur: 0.15, gain: 0.19 * v, filter: 'bandpass', cutoff0: 520, cutoff1: 220, q: 1.2 });
        break;
      }
      case 'hit': {
        if (!this._gate('hit', 0.022)) return;
        this._noiseBurst({ f0: 2200 * p, f1: 620, dur: 0.06, gain: 0.20 * v, q: 1.1 });
        this._tone({ type: 'triangle', f0: 560 * p, f1: 200, dur: 0.06, gain: 0.13 * v });
        break;
      }
      case 'crit': {
        if (!this._gate('crit', 0.03)) return;
        this._noiseBurst({ f0: 4200, f1: 1200, dur: 0.10, gain: 0.22 * v, q: 1.4 });
        this._tone({ type: 'triangle', f0: 1500, f1: 620, dur: 0.14, gain: 0.17 * v });
        this._tone({ type: 'triangle', f0: 2260, f1: 940, dur: 0.11, gain: 0.10 * v, detune: 9 });
        break;
      }
      case 'kill': {
        if (!this._gate('kill', 0.035)) return;
        this._noiseBurst({ f0: 1500, f1: 180, dur: 0.28, gain: 0.17 * v, filter: 'lowpass', q: 0.8 });
        this._tone({ type: 'sine', f0: 240, f1: 48, dur: 0.3, gain: 0.2 * v });
        break;
      }
      case 'explosion': {
        const size = opts.size || 1;
        this._noiseBurst({ f0: 1100 * (1 / size), f1: 90, dur: 0.5 * size, gain: 0.3 * v, filter: 'lowpass', q: 0.7 });
        this._tone({ type: 'sine', f0: 180 / size, f1: 32, dur: 0.6 * size, gain: 0.34 * v });
        this._noiseBurst({ f0: 5000, f1: 1200, dur: 0.1, gain: 0.14 * v });
        this.duck(0.28, 0.4);
        break;
      }
      case 'dash': {
        this._noiseBurst({ f0: 400, f1: 3600, dur: 0.18, gain: 0.30 * v, q: 1.0 });
        this._tone({ type: 'sine', f0: 420, f1: 90, dur: 0.26, gain: 0.22 * v });
        break;
      }
      case 'pulse': {
        this._tone({ type: 'sine', f0: 150, f1: 34, dur: 0.55, gain: 0.42 * v });
        this._noiseBurst({ f0: 260, f1: 3400, dur: 0.3, gain: 0.2 * v, q: 0.8 });
        this._tone({ type: 'sawtooth', f0: 220, f1: 880, dur: 0.22, gain: 0.11 * v, filter: 'lowpass', cutoff0: 500, cutoff1: 3000 });
        this.duck(0.3, 0.4);
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
  startMusic(mode = 'menu') {
    if (!this.ready) return;
    this._mode = mode;
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
    if (mode === 'boss') this._bpm = 138;
    else if (mode === 'combat') this._bpm = 124;
    else this._bpm = 96;
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

  _scheduleStep(step, t, stepDur) {
    const bar = Math.floor(step / 16);
    const beat = Math.floor((step % 16) / 4);
    const six = step % 16;
    const prog = PROGRESSION[bar % PROGRESSION.length];
    const I = this.intensity;
    const boss = this._mode === 'boss';
    const menu = this._mode === 'menu';
    const dest = this.musBus;

    // ---- drums ----
    if (!menu) {
      const kickOn = six === 0 || six === 6 || (I > 0.45 && six === 10) || (boss && six === 14);
      if (kickOn) {
        this._tone({ type: 'sine', f0: 150, f1: 42, dur: 0.24, gain: 0.5, at: t, dest, attack: 0.002 });
        this._noiseBurst({ f0: 120, f1: 60, dur: 0.06, gain: 0.12, at: t, dest, filter: 'lowpass' });
      }
      if (six === 4 || six === 12) {
        this._noiseBurst({ f0: 1900, f1: 700, dur: 0.16, gain: 0.16 + I * 0.1, at: t, dest, q: 0.9 });
        this._tone({ type: 'triangle', f0: 320, f1: 180, dur: 0.1, gain: 0.1, at: t, dest });
      }
      if (I > 0.28 && step % 2 === 0) {
        this._noiseBurst({ f0: 8200, f1: 6000, dur: 0.035, gain: 0.035 + I * 0.03, at: t, dest, filter: 'highpass', q: 0.7 });
      }
      if (I > 0.7 && six === 15 && Math.random() < 0.5) {
        this._noiseBurst({ f0: 3000, f1: 9000, dur: 0.22, gain: 0.07, at: t, dest, q: 0.6 });
      }
    }

    // ---- bass ----
    if (!menu || I > 0.1) {
      const pattern = boss ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
      if (pattern.includes(six)) {
        const oct = six === 0 ? 0 : (Math.random() < 0.22 ? 12 : 0);
        this._tone({
          type: 'sawtooth', f0: NOTE(prog.root - 12 + oct), dur: stepDur * (six === 0 ? 3.4 : 1.8),
          gain: 0.16 + I * 0.1, at: t, dest, filter: 'lowpass',
          cutoff0: 220 + I * 900, cutoff1: 160 + I * 400, q: 6, expo: false,
        });
      }
    }

    // ---- arp / lead ----
    const arpDensity = menu ? 0.16 : 0.3 + I * 0.5;
    if (step % 2 === 0 && Math.random() < arpDensity) {
      const deg = SCALE[Math.floor(Math.random() * SCALE.length)];
      const oct = Math.random() < 0.35 ? 12 : 0;
      this._tone({
        type: boss ? 'square' : 'triangle', f0: NOTE(prog.root + 12 + deg + oct),
        dur: stepDur * 1.6, gain: (menu ? 0.055 : 0.05 + I * 0.05), at: t, dest,
        filter: 'bandpass', cutoff0: 1400 + I * 2200, q: 2.6,
      });
    }

    // ---- pad (bar changes) ----
    if (six === 0) {
      const padGain = menu ? 0.05 : 0.028 + I * 0.03;
      for (const n of prog.chord) {
        this._tone({ type: 'sawtooth', f0: NOTE(n), dur: stepDur * 15, gain: padGain, at: t, dest, attack: 0.5, detune: -6, filter: 'lowpass', cutoff0: 420 + I * 700, q: 1.5, expo: false });
        this._tone({ type: 'sawtooth', f0: NOTE(n), dur: stepDur * 15, gain: padGain, at: t, dest, attack: 0.6, detune: 7, filter: 'lowpass', cutoff0: 380 + I * 600, q: 1.5, expo: false });
      }
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
