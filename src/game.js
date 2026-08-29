/**
 * game.js — orchestrator and rules engine.
 *
 * Owns the state machine (boot / menu / playing / refit / paused / results),
 * the frame loop, and every cross-system rule: damage resolution, scoring,
 * explosions, line-of-sight, run lifecycle and progression.
 */
import { clamp, clamp01, damp, formatScore, lerp, lengthXZ, RNG, RollingStat, TAU } from './core/util.js';
import { Input } from './core/input.js';
import { audio } from './core/audio.js';
import { save } from './core/save.js';
import { Renderer } from './render/renderer.js';
import { GameCamera } from './render/camera.js';
import { World } from './render/world.js';
import { ParticleFX } from './render/particles.js';
import { RingFX, DecalFX, BeamFX, DebrisFX, ShadowFX, ScreenFX, ScorchFX } from './render/vfx.js';
import { globalUniforms, setLightDirection } from './render/materials.js';
import { Player } from './entities/player.js';
import { Enemies } from './entities/enemies.js';
import { Projectiles } from './entities/projectiles.js';
import { Pickups } from './entities/pickups.js';
import { BossManager } from './entities/bosses.js';
import { WaveDirector } from './systems/waves.js';
import { draftModules, MODULES } from './systems/upgrades.js';
import { SHIPS, DIFFICULTIES, MODES } from './systems/ships.js';
import { UI } from './ui/ui.js';
import { Director, runStartSequence, bossIntroSequence, victorySequence, defeatSequence } from './systems/director.js';

const MAX_DT = 1 / 20;

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'boot';
    this.time = 0;
    this.runTime = 0;
    this.frame = 0;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.rng = new RNG();
    this.save = save;
    this.audio = audio;
    this.timers = [];
    this.paused = false;
    this.slowmoTimer = 0;

    this.score = 0;
    this.displayScore = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.comboWindow = 3.2;
    this.bestCombo = 1;
    this.runStats = { kills: 0, shards: 0, damageDealt: 0, damageTaken: 0 };

    this.difficulty = DIFFICULTIES.pilot;
    this.mode = MODES.campaign;
    this.enemyDamageMult = 1;
    this.rerolls = 1;

    this.tutorial = null;
    this.frameStat = new RollingStat(120);
    this.simStat = new RollingStat(120);
    this._perfText = '';
    this._perfTimer = 0;
    this._aimWorld = new THREE.Vector3(0, 1.05, 0);
    this.aimScreen = { x: 0, y: 0 };
    this._sunDir = new THREE.Vector3(0.45, 0.85, 0.35).normalize();
  }

  // ==================================================================
  //  boot
  // ==================================================================
  async boot(onProgress) {
    const step = async (p, label, fn) => {
      if (onProgress) onProgress(p, label);
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (fn) fn();
    };

    this.input = new Input(this.canvas);
    this.ui = new UI(this);

    await step(0.05, 'initialising renderer', () => {
      this.renderer = new Renderer(this.canvas, save.settings.quality);
      this.renderer.resize(this.width, this.height, true);
      this.scene = new THREE.Scene();
      this.camera = new GameCamera(this.width / this.height);
    });

    await step(0.18, 'painting the void', () => {
      this.world = new World(this.scene, this.rng);
    });

    await step(0.38, 'forging hulls', () => {
      this.player = new Player(this.scene, this);
    });

    await step(0.55, 'waking the swarm', () => {
      this.enemies = new Enemies(this.scene, this);
      this.boss = new BossManager(this.scene, this);
    });

    await step(0.70, 'loading ordnance', () => {
      this.projectiles = new Projectiles(this.scene, this);
      this.pickups = new Pickups(this.scene, this);
    });

    await step(0.82, 'calibrating effects', () => {
      this.fx = new ParticleFX(this.scene, this.rng);
      this.rings = new RingFX(this.scene, 30);
      this.decals = new DecalFX(this.scene, 44);
      this.beams = new BeamFX(this.scene, 14);
      this.debris = new DebrisFX(this.scene, 54);
      this.scorches = new ScorchFX(this.scene, 34);
      this.shadows = new ShadowFX(this.scene, 140);
      this.screen = new ScreenFX();
      this.screen.shakeScale = save.settings.shake;
    });

    await step(0.92, 'tuning the arrays', () => {
      this.waves = new WaveDirector(this, this.scene);
      this.director = new Director(this);
      this.applySettings();
      this._bindWindow();
      this.ui.setLoadout(save.record.lastShip, save.record.lastDifficulty, save.record.lastMode);
      this.ui.setTouch(this.input.hasTouch);
      this.input.bindTouch({
        move: this.ui.el['stick-move'], aim: this.ui.el['stick-aim'],
        dash: this.ui.el['tbtn-dash'], pulse: this.ui.el['tbtn-pulse'],
        over: this.ui.el['tbtn-over'], pause: this.ui.el['tbtn-pause'],
      });
    });

    await step(1.0, 'ready');
    this.toMenu(true);
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    return this;
  }

  _bindWindow() {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'playing') this.pause();
        this.audio.suspend();
      } else if (!this.audio.failed) {
        this.audio.resume();
      }
    });
    window.addEventListener('blur', () => { if (this.state === 'playing') this.pause(); });
    const unlock = () => {
      this.audio.init();
      this.audio.resume();
      this.audio.setVolumes(save.settings.master, save.settings.music, save.settings.sfx);
      if (this.state === 'menu' && !this.audio.musicOn) this.audio.startMusic('menu');
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('error', (e) => this._onRuntimeError(e.message));
    this._checkOrientation();
  }

  _onRuntimeError(msg) {
    if (this._errored) return;
    this._errored = true;
    console.error('[nova-lance] runtime error:', msg);
    try { this.ui.toast('SYSTEM FAULT — see console', 'bad'); } catch (e) { /* ignore */ }
  }

  _checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    document.body.classList.toggle('portrait', portrait && this.input.hasTouch);
  }

  resize() {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.renderer.resize(this.width, this.height);
    this.camera.setAspect(this.width / this.height);
    this.world.setMoteScale(this.height * 0.9);
    const fx = this.fx;
    if (fx) {
      const scale = this.height * 0.55;
      for (const s of fx.systems) s.material.uniforms.uScale.value = scale;
    }
    this._checkOrientation();
  }

  applySettings() {
    const s = save.settings;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.audio.setVolumes(s.master, s.music, s.sfx);
    this.renderer.setQuality(s.quality);
    if (this.fx) this.fx.setBudget(this.renderer.settings.particleScale);
    if (this.world) this.world.setMistEnabled(this.renderer.quality !== 'low');
    if (this.screen) this.screen.shakeScale = reduce ? Math.min(s.shake, 0.25) : s.shake;
    document.body.classList.toggle('no-scanlines', !s.scanlines);
    document.body.classList.toggle('no-flash', !s.flashes);
    if (this.camera) this.camera.enableLead = s.cameraRotate;
    this.resize();
  }

  setSetting(key, value) {
    save.set(key, value);
    this.applySettings();
  }

  wipeSave() {
    save.wipe();
    this.applySettings();
    this.ui.buildOptions();
    this.ui.toast('SERVICE RECORD WIPED', 'warn');
  }

  // ==================================================================
  //  run lifecycle
  // ==================================================================
  toMenu(initial = false) {
    this.state = 'menu';
    this.paused = false;
    this._teardownRun();
    this.ui.showMenu();
    this.ui.clearTransient();
    this.world.reset();
    this.world.setThreat(0);
    this.camera.orbit(0);
    this.audio.setMusicMode('menu');
    this.audio.setIntensity(0.1);
    if (!initial && this.audio.ready) this.audio.startMusic('menu');
  }

  _teardownRun() {
    if (this.director) this.director.cancel();
    if (!this.enemies) return;
    this.enemies.clear();
    this.projectiles.clear();
    this.pickups.clear();
    this.boss.despawn(true);
    this.waves.clear();
    this.rings.clear();
    this.decals.clear();
    this.beams.clear();
    this.debris.clear();
    this.scorches.clear();
    this.fx.clear();
    this.timers.length = 0;
    this.screen.reset();
    this.ui.setHudVisible(false);
  }

  startRun(shipId, difficultyId, modeId, seed) {
    this._teardownRun();
    this.difficulty = DIFFICULTIES[difficultyId] || DIFFICULTIES.pilot;
    this.mode = MODES[modeId] || MODES.campaign;
    if (this.mode.id === 'endless' && !save.record.endless) this.mode = MODES.campaign;
    this.runSeed = seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : seed;
    this.rng.seed(this.runSeed);

    this.score = 0;
    this.displayScore = 0;
    this.combo = 1;
    this.bestCombo = 1;
    this.comboTimer = 0;
    this.runTime = 0;
    this.rerolls = 1;
    this.runStats = { kills: 0, shards: 0, damageDealt: 0, damageTaken: 0 };
    this.enemyDamageMult = this.difficulty.enemyDamage;

    this.player.reset(shipId, this.difficulty.playerHp);
    this.camera.snapTo(this.player.position.x, this.player.position.z);
    this.world.reset();
    this.waves.reset();

    save.record.lastShip = shipId;
    save.record.lastDifficulty = difficultyId;
    save.record.lastMode = this.mode.id;
    save.save();

    this.ui.setLoadout(shipId, difficultyId, this.mode.id);
    this.ui.clearTransient();
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.ui.setWave(1, this.mode.waves);
    this.state = 'playing';
    this.paused = false;
    this.audio.resume();
    this.audio.startMusic('combat');
    this.audio.setMusicMode('combat');
    this.input.lock(0.3);

    this.director.cancel();
    this.director.play(runStartSequence(this.player.position.x, this.player.position.z), () => {
      // Guard: a wave may already have been forced to start (debug tooling, or
      // a skip that raced the callback). Never rewind it to wave 1.
      if (this.state === 'playing' && this.waves.wave === 0) this.waves.start(1);
    });
    this._startTutorial();
  }

  /**
   * First-run onboarding: a handful of contextual prompts, worded for whatever
   * device the player is actually holding, shown once per career.
   */
  _startTutorial() {
    if (save.record.seenIntro) { this.tutorial = null; return; }
    const touch = this.input.hasTouch;
    const pad = this.input.scheme === 'gamepad';
    const move = touch ? 'LEFT STICK' : pad ? 'LEFT STICK' : 'W A S D';
    const aim = touch ? 'RIGHT STICK' : pad ? 'RIGHT STICK' : 'MOUSE';
    const fire = touch ? 'AIM TO FIRE' : pad ? 'RIGHT TRIGGER' : 'HOLD LEFT MOUSE';
    const dash = touch ? 'DASH BUTTON' : pad ? 'RB' : 'SPACE';
    const pulse = touch ? 'PULSE BUTTON' : pad ? 'LEFT TRIGGER' : 'RIGHT MOUSE';
    this.tutorial = {
      steps: [
        { at: 1.5, text: `${move} — THRUST` },
        { at: 5.0, text: `${aim} — AIM · ${fire}` },
        { at: 11.0, text: `${dash} — PHASE DASH, INVULNERABLE` },
        { at: 20.0, text: `${pulse} — NOVA PULSE CLEARS BULLETS` },
        { at: 34.0, text: 'SHIELD RECHARGES WHEN YOU STOP TAKING HITS' },
      ],
      i: 0,
      t: 0,
    };
  }

  _updateTutorial(dt) {
    const tut = this.tutorial;
    if (!tut) return;
    tut.t += dt;
    const step = tut.steps[tut.i];
    if (step && tut.t >= step.at) {
      tut.i++;
      this.ui.toast(step.text, 'warn');
    }
    if (tut.i >= tut.steps.length) {
      this.tutorial = null;
      save.record.seenIntro = true;
      save.save();
    }
  }

  restartRun() {
    this.startRun(this.player.shipId, this.difficulty.id, this.mode.id);
  }

  abortRun() {
    this.endRun(false, true);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.paused = true;
    this.director.cancel();
    this.ui.showPauseStats();
    this.ui.show('pause');
    this.audio.duck(0.5, 0.3);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.paused = false;
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.input.lock(0.2);
    this.audio.resume();
  }

  onPlayerDeath() {
    if (this.state === 'results') return;
    this.state = 'dying';
    this.audio.setIntensity(0);
    this.audio.play('defeat');
    this.screen.desaturate = 0.85;
    this.director.play(defeatSequence(this.player.position.x, this.player.position.z), () => this.endRun(false));
  }

  onBossDefeated(boss) {
    this.addScore(boss.def.score * 1.0, boss.x, boss.z);
    this.rerolls++;
    this.ui.banner('THREAT NEUTRALISED', boss.def.name, '');
    this.ui.toast('+1 REROLL', 'good');
    this.audio.play('victory', { gain: 0.6 });
    this.screen.addFlash(0xffffff, 0.5);
    this.screen.addTrauma(0.7);
    this.world.setThreat(0.2);
    this.pickups.spawnOrb(boss.x + 2, boss.z, 'heal');
    this.pickups.spawnOrb(boss.x - 2, boss.z, 'energy');
    this.pickups.spawnShards(boss.x, boss.z, 12, true);
    this.audio.setMusicMode('combat');
  }

  onWaveCleared(wave) {
    const isFinal = Number.isFinite(this.mode.waves) && wave >= this.mode.waves;
    const bonus = 120 * wave * this.difficulty.scoreMult;
    this.addScore(bonus);
    this.ui.toast(`WAVE ${wave} CLEARED  +${formatScore(bonus)}`, 'good');
    this.player.shield = this.player.stats.maxShield;
    this.player.heal(this.player.stats.maxHull * 0.06);

    if (isFinal) {
      this.after(0.8, () => {
        if (this.state !== 'playing') return;
        this.director.play(victorySequence(this.player.position.x, this.player.position.z), () => this.endRun(true));
      });
      return;
    }
    this.after(1.7, () => this.openRefit(wave));
  }

  openRefit(wave) {
    if (this.state !== 'playing') return;
    this.state = 'refit';
    const offers = draftModules(this.rng, this.player.modules, 3, wave);
    if (!offers.length) { this.startNextWave(wave); return; }
    this._refitWave = wave;
    this.ui.showRefit(wave, offers, this.rerolls, this.difficulty.refitTime);
    this.audio.setIntensity(0.15);
  }

  rerollDraft() {
    if (this.state !== 'refit' || this.rerolls <= 0) { this.audio.play('uiDeny'); return; }
    this.rerolls--;
    const offers = draftModules(this.rng, this.player.modules, 3, this._refitWave);
    this.ui.showRefit(this._refitWave, offers, this.rerolls, this.difficulty.refitTime);
  }

  pickModule(id) {
    if (this.state !== 'refit') return;
    const mod = MODULES[id];
    if (!mod) return;
    this.player.addModule(id);
    this.audio.play('upgrade');
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.ui.toast(`${mod.name} INSTALLED`, 'good');
    this.fx.column(this.player.position.x, this.player.position.z, 0x7dff9e, 10, 26);
    this.rings.spawn(this.player.position.x, this.player.position.z, { color: 0x7dff9e, from: 1, to: 8, duration: 0.6, thickness: 0.2 });
    this.state = 'playing';
    this.input.lock(0.25);
    this.startNextWave(this._refitWave);
  }

  startNextWave(prevWave) {
    this.after(0.9, () => {
      if (this.state !== 'playing') return;
      this.waves.start(prevWave + 1);
    });
  }

  endRun(victory, aborted = false) {
    if (this.state === 'results') return;
    this.state = 'results';
    const wave = Math.max(1, this.waves.wave);
    const p = this.player;
    const summary = {
      victory, aborted, wave, score: this.score,
      kills: this.runStats.kills, time: this.runTime,
      damageDealt: Math.round(this.runStats.damageDealt),
      damageTaken: Math.round(this.runStats.damageTaken),
      shotsFired: p.shotsFired, shotsHit: p.shotsHit,
      bestCombo: this.bestCombo,
      modules: new Map(p.modules),
      ship: p.shipId, difficulty: this.difficulty.id, mode: this.mode.id,
      seed: this.runSeed,
    };
    summary.rank = this._rank(summary);
    summary.unlocked = aborted ? [] : save.commitRun(summary);
    this._teardownRun();
    this.audio.setMusicMode('menu');
    this.audio.setIntensity(0.1);
    if (victory) { this.audio.play('victory'); this.screen.addFlash(0xffffff, 0.6); }
    this.ui.showResults(summary);
    this.lastSummary = summary;
  }

  _rank(s) {
    const par = (this.mode.id === 'endless' ? 18000 : 32000) * this.difficulty.scoreMult;
    const v = s.score / par + (s.victory ? 0.6 : 0);
    if (v >= 1.85) return 'S';
    if (v >= 1.30) return 'A';
    if (v >= 0.85) return 'B';
    if (v >= 0.45) return 'C';
    return 'D';
  }

  // ==================================================================
  //  rules
  // ==================================================================
  addScore(amount, x, z) {
    const v = amount * this.difficulty.scoreMult;
    this.score += v;
    if (x !== undefined && Math.random() < 0.25) {
      this.ui.floatText({ x, y: 1.6, z }, `+${Math.round(v)}`, 'xp');
    }
  }

  bumpCombo() {
    this.combo = Math.min(5, this.combo + 0.1);
    this.comboTimer = this.comboWindow;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
  }

  damageEnemy(target, amount, opts = {}) {
    if (!target || target.dying) return 0;
    const p = this.player;
    let dealt = 0;
    if (target.isBoss && this.boss.active) {
      dealt = this.boss.hurt(amount);
      if (dealt > 0) {
        this.audio.play(opts.crit ? 'crit' : 'bossHurt', { gain: 0.5 });
        if (opts.x !== undefined) this.ui.damageNumber({ x: opts.x, y: this.boss.y, z: opts.z }, dealt, opts.crit);
      }
    } else {
      dealt = this.enemies.hurt(target, amount, opts);
      if (dealt > 0 && opts.x !== undefined && !opts.silent) {
        this.ui.damageNumber({ x: opts.x, y: target.y + 0.6, z: opts.z }, dealt, opts.crit);
      }
      if (!opts.silent) this.audio.play(opts.crit ? 'crit' : 'hit', { gain: opts.crit ? 0.8 : 0.55 });
    }

    if (dealt > 0) {
      this.runStats.damageDealt += dealt;
      p.damageDealt += dealt;
      if (opts.source === 'bolt') p.shotsHit++;
      p.gainOverdrive(dealt * 0.055);
      if (!opts.silent) this.ui.hitMarker(target.dying);
      if (opts.crit) this.screen.stop(0.012);
    }

    // chain arc
    if (opts.chain > 0 && opts.x !== undefined) {
      const seen = new Set([target.id]);
      let sx = opts.x, sz = opts.z;
      for (let i = 0; i < opts.chain; i++) {
        const next = this.enemies.nearestTo(sx, sz, 11, seen);
        if (!next) break;
        seen.add(next.id);
        this._arc(sx, sz, next.x, next.z);
        this.damageEnemy(next, amount * 0.45, {
          x: next.x, z: next.z, dx: next.x - sx, dz: next.z - sz,
          knock: 1.5, chill: opts.chill, source: 'chain', silent: true,
        });
        sx = next.x; sz = next.z;
      }
      this.audio.play('zap', { gain: 0.5 });
    }
    return dealt;
  }

  _arc(x0, z0, x1, z1) {
    const steps = 7;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.fx.glow.spawn({
        x: lerp(x0, x1, t) + (Math.random() - 0.5) * 1.1,
        y: 1.1 + (Math.random() - 0.5) * 0.7,
        z: lerp(z0, z1, t) + (Math.random() - 0.5) * 1.1,
        color: 0xffffff, color2: 0x46e6ff, size: 0.5, size2: 0, life: 0.16, alpha: 1, drag: 1,
      });
    }
  }

  damagePlayer(amount, x, z, opts = {}) {
    if (this.state !== 'playing' && this.state !== 'refit') return 0;
    const dealt = this.player.damage(amount, x, z, opts);
    if (dealt > 0) {
      this.runStats.damageTaken += dealt;
      this.combo = Math.max(1, this.combo * 0.55);
      this.comboTimer = Math.min(this.comboTimer, 1.2);
    }
    return dealt;
  }

  onEnemyKilled(e, opts = {}) {
    const p = this.player;
    if (!opts.silentScore) {
      this.bumpCombo();
      this.addScore((e.scoreValue || e.type.score) * this.combo, e.x, e.z);
    }
    if (!e.type.hidden) {
      this.runStats.kills++;
      p.kills++;
      this.waves.waveKills++;
      if (p.stats.lifesteal > 0) p.heal(p.stats.lifesteal);
      p.gainOverdrive(4);
      // A frame of hitch on heavy kills only — on swarm chaff it would read as
      // stutter rather than impact.
      if ((e.type.tier >= 2 || e.elite) && this.time - (this._lastKillStop || -9) > 0.22) {
        this._lastKillStop = this.time;
        this.screen.stop(e.elite ? 0.05 : 0.032);
        this.screen.addTrauma(0.05);
      }
    }
    if (opts.isBossKill) this.runStats.kills++;
  }

  explosionAt(x, z, radius, damage, team, color = 0xffb347, opts = {}) {
    this.fx.explode(x, 0.8, z, clamp(radius * 0.22, 0.7, 2.6), 0xffffff, color);
    this.rings.spawn(x, z, { color, from: radius * 0.25, to: radius, duration: 0.42, thickness: 0.2 });
    if (opts.rings) {
      for (let i = 1; i < opts.rings; i++) {
        this.after(i * 0.12, () => this.rings.spawn(x, z, { color, from: radius * 0.3, to: radius * (1 + i * 0.1), duration: 0.4, thickness: 0.14 }));
      }
    }
    this.world.addRipple(x, z, clamp(radius / 10, 0.4, 2));
    this.scorch(x, z, clamp(radius * 0.55, 1.5, 9), color);
    this.screen.addTrauma(clamp(radius * 0.02, 0.05, 0.5));
    this.audio.play('explosion', { size: clamp(radius / 8, 0.5, 1.6), gain: 0.8 });
    for (let i = 0; i < Math.min(6, radius * 0.6); i++) this.debris.spawn(x, 0.6, z, { speed: radius, scale: 0.6, life: 1.2 });

    if (team === 1) {
      const p = this.player;
      if (p.alive) {
        const d = lengthXZ(p.position.x - x, p.position.z - z);
        if (d < radius + p.radius) {
          const falloff = 1 - 0.5 * clamp01(d / radius);
          this.damagePlayer(damage * falloff, x, z, { knock: 16 });
        }
      }
    } else {
      const list = this.enemies.query(x, z, radius);
      for (const e of list) {
        const d = lengthXZ(e.x - x, e.z - z);
        const falloff = 1 - 0.5 * clamp01(d / radius);
        this.damageEnemy(e, damage * falloff, {
          x: e.x, z: e.z, dx: e.x - x, dz: e.z - z, knock: 14 * falloff,
          source: 'explosion', silent: true, fromExplosion: true,
        });
      }
    }
  }

  /** Leave a burn mark on the deck. */
  scorch(x, z, radius, color) {
    if (this.scorches) this.scorches.add(x, z, radius, color);
  }

  spawnEnemyAt(typeId, x, z) {
    const R = this.world.radius - 4;
    const d = lengthXZ(x, z);
    if (d > R) { x = x / d * R; z = z / d * R; }
    return this.enemies.spawn(typeId, x, z, {
      hpScale: this.waves.hpScale(this.waves.wave),
      speedScale: this.waves.speedScale(this.waves.wave),
    });
  }

  obstacleAt(x, z, r) {
    for (const ob of this.world.obstacles) {
      const dx = x - ob.x, dz = z - ob.z;
      const rr = ob.r + r;
      if (dx * dx + dz * dz < rr * rr) return ob;
    }
    return null;
  }

  hasLOS(x0, z0, x1, z1) {
    for (const ob of this.world.obstacles) {
      if (this.pointSegmentDistance(ob.x, ob.z, x0, z0, x1, z1) < ob.r * 0.9) return false;
    }
    return true;
  }

  pointSegmentDistance(px, pz, ax, az, bx, bz) {
    const abx = bx - ax, abz = bz - az;
    const apx = px - ax, apz = pz - az;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? (apx * abx + apz * abz) / len2 : 0;
    t = clamp01(t);
    const cx = ax + abx * t, cz = az + abz * t;
    return Math.hypot(px - cx, pz - cz);
  }

  /** Schedule a callback in game-time seconds (respects pause). */
  after(seconds, fn) { this.timers.push({ t: seconds, fn }); }

  _runTimers(dt) {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) {
        this.timers.splice(i, 1);
        try { t.fn(); } catch (e) { this._onRuntimeError(e && e.message); }
      }
    }
  }

  // ==================================================================
  //  frame
  // ==================================================================
  _loop(now) {
    requestAnimationFrame(this._loop);
    // Debug/tooling hook: hands the canvas to an external renderer (the model
    // viewer) without the game loop overwriting the frame.
    if (this.debugFreeze) { this._last = now; return; }
    const t0 = performance.now();
    let dtReal = (now - this._last) / 1000;
    this._last = now;
    if (!Number.isFinite(dtReal) || dtReal < 0) dtReal = 0.016;
    dtReal = Math.min(dtReal, MAX_DT);

    this.tick(dtReal);

    const simMs = performance.now() - t0;
    this.simStat.push(simMs);
    this.render();
    const total = performance.now() - t0;
    this.frameStat.push(total);
    const drop = this.renderer.autoTune(total);
    if (drop) {
      this.fx.setBudget(this.renderer.settings.particleScale);
      this.ui.toast(`QUALITY → ${drop.toUpperCase()}`, 'warn');
    }
    this._updatePerf(dtReal);
  }

  /** One simulation + presentation step. Split out so tests can drive it. */
  tick(dtReal) {
    // Guard here rather than only in the rAF loop: debug/test callers and a
    // clock that jumps backwards must never be able to inject NaN into the sim.
    if (!Number.isFinite(dtReal) || dtReal < 0) dtReal = 0;
    if (dtReal > MAX_DT) dtReal = MAX_DT;
    this.frame++;
    this.screen.update(dtReal);
    if (this.director) {
      this.director.update(dtReal);
      this.input.enabled = !this.director.lockInput;
    }
    this.input.sample(dtReal);
    if (this.director && this.director.running) {
      // any deliberate input skips an intro — unskippable cutscenes age badly
      const wants = this.input.anyEdge || this.input.fireHeld
        || this.input.move.x !== 0 || this.input.move.z !== 0;
      if (wants) this.director.trySkip();
    }
    this._handleGlobalKeys();

    const dt = dtReal * this.screen.timeScale;
    this.time += dt;

    if (this.slowmoTimer > 0) {
      this.slowmoTimer -= dtReal;
      if (this.slowmoTimer <= 0) this.screen.targetTimeScale = 1;
    }

    if (this.state === 'playing') {
      this.runTime += dt;
      this._updatePlay(dt, dtReal);
    } else if (this.state === 'dying') {
      this._updatePlay(dt * 0.55, dtReal);
    } else if (this.state === 'refit') {
      this._updateAmbient(dt);
      this.ui.updateRefitTimer(dtReal);
    } else if (this.state === 'menu' || this.state === 'results') {
      this.camera.orbit(dtReal);
      this._updateAmbient(dt);
    } else if (this.state === 'paused') {
      this.world.update(dt * 0.1, this.player.position, 0);
    }

    this.displayScore = damp(this.displayScore, this.score, 0.0005, dtReal);
    globalUniforms.uTime.value = this.time;
    setLightDirection(this._sunDir, this.camera.camera);
    this.input.endFrame();
  }

  _handleGlobalKeys() {
    const input = this.input;
    if (input.keyPressed('F1')) {
      this.setSetting('showPerf', !save.settings.showPerf);
    }
    if (this.state === 'refit') {
      if (input.keyPressed('Digit1')) this.ui.pickCardByIndex(0);
      if (input.keyPressed('Digit2')) this.ui.pickCardByIndex(1);
      if (input.keyPressed('Digit3')) this.ui.pickCardByIndex(2);
      if (input.keyPressed('KeyR')) this.rerollDraft();
      return;
    }
    if (input.pauseEdge) {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.ui.screen && this.ui.screen !== 'menu' && this.ui.screen !== 'results') this.ui.back();
    }
  }

  _updateAmbient(dt) {
    this.world.update(dt, this.player ? this.player.position : null, 0);
    this.fx.update(dt);
    this.rings.update(dt);
    this.debris.update(dt);
    this.scorches.update(dt);
    this.shadows.begin();
    this.shadows.end();
    this._syncComposite();
  }

  _updatePlay(dt, dtReal) {
    const p = this.player;

    // ---- aim ----
    if (this.input.aim.mode === 'stick') {
      const d = this.input.aim;
      // Stick and touch aiming get a modest magnetic assist toward whatever is
      // closest to the aim ray. Mouse aiming gets none — it does not need it,
      // and stealing precision from a mouse player feels awful.
      const a = this._aimAssist(p.position, d.dirX, d.dirZ);
      this._aimWorld.set(p.position.x + a.x * 22, 1.05, p.position.z + a.z * 22);
      const s = this.camera.worldToScreen(this._aimWorld.x, this._aimWorld.y, this._aimWorld.z, this.width, this.height);
      this.aimScreen.x = s.x; this.aimScreen.y = s.y;
    } else if (this.input.aim.active) {
      this.camera.screenToGround(this.input.aim.screenX, this.input.aim.screenY, this.width, this.height, this._aimWorld);
      this.aimScreen.x = this.input.aim.screenX;
      this.aimScreen.y = this.input.aim.screenY;
    } else {
      this._aimWorld.set(p.position.x, 1.05, p.position.z - 20);
      const s = this.camera.worldToScreen(this._aimWorld.x, this._aimWorld.y, this._aimWorld.z, this.width, this.height);
      this.aimScreen.x = s.x; this.aimScreen.y = s.y;
    }

    this.shadows.begin();
    this._runTimers(dt);
    this._updateTutorial(dt);
    p.update(dt, this.input, this._aimWorld);
    if (p.alive) this.shadows.push(p.position.x, p.position.y, p.position.z, 1.7, 1);
    this.enemies.update(dt);
    if (this.boss.state === 'dying' || this.boss.active) this.boss.update(dt);
    this.projectiles.update(dt);
    this.pickups.update(dt);
    this.waves.update(dt);
    this.fx.update(dt);
    this.rings.update(dt);
    this.debris.update(dt);
    this.scorches.update(dt);
    this.shadows.end();

    // combo decay
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }

    // camera + world
    const threat = this.boss.active ? 1 : clamp01(this.enemies.threatCount / 26);
    if (this.debugCamera) {
      const c = this.camera.camera;
      c.position.set(this.debugCamera.x, this.debugCamera.y, this.debugCamera.z);
      c.lookAt(this.debugCamera.tx, this.debugCamera.ty, this.debugCamera.tz);
    } else if (this.director.running) {
      // park the rig first, then apply — parking must not move the camera
      this.camera.parkTarget(p.position.x, p.position.z);
      this.director.applyTo(this.camera.camera);
    } else {
      this.camera.follow(p, this._aimWorld, dtReal, this.screen, this.boss.active ? 0.7 : 0,
        this.boss.active ? this.boss : null);
    }
    this.world.update(dt, p.position, p.overdriveActive > 0 ? 0.4 : 0);
    this.audio.setIntensity(clamp01(0.25 + threat * 0.6 + (p.overdriveActive > 0 ? 0.3 : 0)));

    // low-hull warning state
    const critical = p.alive && p.hullPct < 0.25;
    if (critical !== this._critical) {
      this._critical = critical;
      this.ui.setCritical(critical);
      if (critical) this.ui.toast('HULL CRITICAL', 'bad');
    }

    this.ui.update(dtReal, p, this);
    this._syncComposite();
  }

  /** Blend an aim direction toward the best target inside a narrow cone. */
  _aimAssist(origin, dx, dz) {
    const out = this._assistOut || (this._assistOut = { x: 0, z: 0 });
    out.x = dx; out.z = dz;
    const MAX_ANGLE = 0.30;          // ~17 degrees
    const MAX_RANGE = 34;
    let best = null, bestScore = Infinity;
    const list = this.enemies.active;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dying || e.type.hidden) continue;
      const ex = e.x - origin.x, ez = e.z - origin.z;
      const d = Math.hypot(ex, ez);
      if (d < 2 || d > MAX_RANGE) continue;
      const dot = clamp((ex * dx + ez * dz) / d, -1, 1);
      const ang = Math.acos(dot);
      if (ang > MAX_ANGLE) continue;
      const score = ang * 3 + d * 0.01;
      if (score < bestScore) { bestScore = score; best = { x: ex / d, z: ez / d, ang }; }
    }
    if (this.boss.active) {
      const ex = this.boss.x - origin.x, ez = this.boss.z - origin.z;
      const d = Math.hypot(ex, ez) || 1;
      const ang = Math.acos(clamp((ex * dx + ez * dz) / d, -1, 1));
      if (ang < MAX_ANGLE && d < 60) {
        const score = ang * 3 + d * 0.01;
        if (score < bestScore) best = { x: ex / d, z: ez / d, ang };
      }
    }
    if (!best) return out;
    // Strongest near the centre (settles the reticle) but still useful at the
    // cone edge — a hard taper to zero there is where the assist is needed most.
    const w = 0.42 * (1 - 0.55 * (best.ang / MAX_ANGLE));
    out.x = dx + (best.x - dx) * w;
    out.z = dz + (best.z - dz) * w;
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l; out.z /= l;
    return out;
  }

  _syncComposite() {
    const u = this.renderer.compositeMat.uniforms;
    const s = this.screen;
    const flashes = save.settings.flashes;
    u.uTime.value = this.time;
    u.uAberration.value = flashes ? s.aberration : 0;
    u.uRadial.value = flashes ? s.radial : 0;
    u.uFlash.value = flashes ? s.flash * 0.5 : 0;
    u.uFlashColor.value.copy(s.flashColor);
    u.uDesaturate.value = s.desaturate;
    u.uSaturation.value = 1.06 + (this.player && this.player.overdriveActive > 0 ? 0.22 : 0);
    u.uExposure.value = 1.0 + (this.player && this.player.overdriveActive > 0 ? 0.12 : 0);
  }

  render() {
    if (!this.renderer) return;
    // Tells the render watchdog when a black frame would actually be a bug.
    this.renderer.expectContent = this.state === 'playing' || this.state === 'paused' || this.state === 'refit';
    this.renderer.render(this.scene, this.camera.camera, this.screen);
  }

  _updatePerf(dtReal) {
    this._perfTimer += dtReal;
    const show = save.settings.showPerf;
    if (!show) { if (this._perfShown) { this.ui.setPerf('', false); this._perfShown = false; } return; }
    this._perfShown = true;
    if (this._perfTimer < 0.25) return;
    this._perfTimer = 0;
    const info = this.renderer.info;
    const fps = 1000 / Math.max(0.001, this.frameStat.avg);
    this._perfText = [
      `fps ${fps.toFixed(0)}  frame ${this.frameStat.avg.toFixed(1)}ms  p90 ${this.frameStat.percentile(0.9).toFixed(1)}`,
      `sim ${this.simStat.avg.toFixed(2)}ms  quality ${this.renderer.quality}`,
      `draws ${info.calls}  tris ${(info.triangles / 1000).toFixed(1)}k  pts ${info.points}`,
      `enemies ${this.enemies.count}  shots ${this.projectiles.count}  parts ${this.fx.count}`,
      `geo ${info.geometries}  tex ${info.textures}  prog ${info.programs}`,
    ].join('\n');
    this.ui.setPerf(this._perfText, true);
  }

  // ==================================================================
  //  test / debug surface
  // ==================================================================
  debugAPI() {
    const g = this;
    return {
      game: g,
      version: '1.0.0',
      state: () => g.state,
      stats: () => ({
        state: g.state, wave: g.waves.wave, waveState: g.waves.state,
        enemies: g.enemies.count, threats: g.enemies.threatCount,
        projectiles: g.projectiles.count, particles: g.fx.count,
        pickups: g.pickups.count, score: Math.round(g.score), combo: g.combo,
        hull: Math.round(g.player.hull), shield: Math.round(g.player.shield),
        energy: Math.round(g.player.energy), overdrive: Math.round(g.player.overdrive),
        alive: g.player.alive, boss: g.boss.active ? g.boss.kind : null,
        bossHp: g.boss.active ? g.boss.healthPct : 0,
        fps: 1000 / Math.max(0.001, g.frameStat.avg),
        frameAvg: g.frameStat.avg, framep90: g.frameStat.percentile(0.9),
        simAvg: g.simStat.avg,
        render: g.renderer.info, quality: g.renderer.quality,
        px: g.player.position.x, pz: g.player.position.z,
        timers: g.timers.length,
        modules: [...g.player.modules.entries()],
      }),
      start: (ship = 'striker', diff = 'pilot', mode = 'campaign', seed) => g.startRun(ship, diff, mode, seed),
      menu: () => g.toMenu(),
      pause: () => g.pause(),
      resume: () => g.resume(),
      step: (dt = 1 / 60, times = 1) => { for (let i = 0; i < times; i++) g.tick(dt); },
      render: () => g.render(),
      forceHDR: () => g.renderer.forceHDR(),
      degradeRender: (n = 1) => { for (let i = 0; i < n; i++) g.renderer.degrade('forced by test'); return g.renderer.pipelineStage; },
      setWave: (n) => {
        g.waves.clear(); g.enemies.clear(); g.projectiles.clear(); g.boss.despawn(true);
        g.director.cancel();
        g.input.enabled = true;
        g.timers.length = 0;
        g.state = 'playing';
        g.ui.hideAll();
        g.ui.setHudVisible(true);
        g.waves.start(n);
      },
      killAll: () => { for (const e of [...g.enemies.active]) if (!e.type.hidden) g.enemies.kill(e, { noDrop: true }); },
      hurtPlayer: (n) => g.damagePlayer(n, g.player.position.x + 3, g.player.position.z),
      heal: (n) => g.player.heal(n),
      godMode: (on = true) => { g.player.god = !!on; },
      giveModule: (id, n = 1) => { for (let i = 0; i < n; i++) g.player.addModule(id); },
      giveAllModules: () => { for (const id of Object.keys(MODULES)) g.player.addModule(id); },
      fillOverdrive: () => { g.player.overdrive = 100; },
      input: g.input,
      setInput: (o) => { g.input.override = o; },
      setCamera: (c) => { g.debugCamera = c; },
      freeze: (on = true) => { g.debugFreeze = !!on; },
      skipCinematic: () => {
        // finish the sequence rather than abandoning it, so whatever it was
        // going to start (the first wave) still starts
        const cb = g.director.onComplete;
        g.director.cancel();
        if (cb) cb();
        g.input.enabled = true;
      },
      clearInput: () => { g.input.override = null; },
      errors: [],
    };
  }

  dispose() {
    this._teardownRun();
    this.input.dispose();
    this.waves.dispose();
    this.player.dispose();
    this.enemies.dispose();
    this.projectiles.dispose();
    this.pickups.dispose();
    this.boss.dispose();
    this.fx.dispose();
    this.rings.dispose();
    this.decals.dispose();
    this.beams.dispose();
    this.debris.dispose();
    this.scorches.dispose();
    this.shadows.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.audio.dispose();
  }
}
