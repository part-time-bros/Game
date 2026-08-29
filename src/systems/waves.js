/**
 * waves.js — the encounter director.
 *
 * Waves are budget-driven rather than hand-authored: each wave gets a spend
 * budget and a menu of unlocked archetypes, so compositions stay varied while
 * the pressure curve stays predictable. Enemies arrive through telegraphed
 * rifts in groups instead of all at once, and a concurrency cap keeps the
 * screen readable no matter how deep the run goes.
 */
import { clamp, clamp01, lerp, TAU } from '../core/util.js';
import { ENEMY_TYPES } from '../entities/enemies.js';
import { createNovaMaterial, createRingMaterial } from '../render/materials.js';
import { buildRiftFrame } from '../render/models.js';
import { riftTexture } from '../render/textures.js';
import { Pool } from '../core/util.js';

const UNLOCKS = [
  { wave: 1, types: ['skitter'] },
  { wave: 2, types: ['skitter', 'drone'] },
  { wave: 3, types: ['skitter', 'drone', 'splitter'] },
  { wave: 4, types: ['skitter', 'drone', 'splitter', 'seeder'] },
  { wave: 6, types: ['skitter', 'drone', 'splitter', 'seeder', 'lancer'] },
  { wave: 7, types: ['skitter', 'drone', 'splitter', 'seeder', 'lancer', 'sentinel'] },
];

const WEIGHTS = {
  skitter: (w) => clamp(46 - w * 1.6, 14, 46),
  drone: (w) => clamp(10 + w * 1.5, 10, 30),
  splitter: (w) => clamp(4 + w * 1.1, 4, 20),
  seeder: (w) => clamp(3 + w * 0.9, 3, 16),
  lancer: (w) => clamp(2 + w * 1.0, 2, 18),
  sentinel: (w) => clamp(2 + w * 0.85, 2, 15),
};

const BOSS_ORDER = ['warden', 'harrower', 'maw'];

/** Visual rift portals that open before a group arrives. */
class Rifts {
  constructor(scene, game) {
    this.game = game;
    const frame = buildRiftFrame();
    this.geo = frame.geometry;
    this.discGeo = new THREE.PlaneGeometry(1, 1);
    this.pool = new Pool(() => {
      const mat = createNovaMaterial({ rim: 1.2, spec: 0.2, rimColor: 0xa06bff, transparent: true });
      const mesh = new THREE.Mesh(frame.geometry, mat);
      const discMat = new THREE.MeshBasicMaterial({
        map: riftTexture(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
      });
      const disc = new THREE.Mesh(this.discGeo, discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.12;
      const g = new THREE.Group();
      g.add(mesh, disc);
      g.visible = false;
      scene.add(g);
      return { group: g, mesh, mat, disc, discMat, t: 0, dur: 1, radius: 3 };
    }, 6, (r) => { r.group.visible = false; });
  }

  open(x, z, radius, duration) {
    const r = this.pool.acquire();
    if (!r) return null;
    r.t = 0;
    r.dur = duration;
    r.radius = radius;
    r.group.position.set(x, 0.2, z);
    r.group.visible = true;
    r.group.scale.setScalar(0.1);
    this.game.audio.play('rift');
    return r;
  }

  update(dt) {
    this.pool.each((r) => {
      r.t += dt;
      const k = r.t / r.dur;
      const open = clamp01(k * 3.2);
      const close = clamp01((k - 0.75) / 0.25);
      const s = r.radius * (0.2 + open * 0.8) * (1 - close * 0.9);
      r.group.scale.setScalar(s);
      r.group.rotation.y += dt * 1.6;
      r.disc.rotation.z -= dt * 2.4;
      r.discMat.opacity = (0.35 + Math.sin(r.t * 9) * 0.1) * (1 - close);
      r.mat.uniforms.uOpacity.value = 1 - close;
      this.game.fx.rift(r.group.position.x, r.group.position.z, s * 1.1, 0xa06bff, dt, 0.7 * (1 - close));
      if (k >= 1) this.pool.release(r);
    });
  }

  clear() { this.pool.releaseAll(); }
  dispose() {
    this.pool.items.forEach((r) => {
      r.mat.dispose(); r.discMat.dispose();
      if (r.group.parent) r.group.parent.remove(r.group);
    });
    this.geo.dispose();
    this.discGeo.dispose();
  }
}

export class WaveDirector {
  constructor(game, scene) {
    this.game = game;
    this.rifts = new Rifts(scene, game);
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.state = 'idle';     // idle | intro | spawning | fighting | cleared
    this.stateTime = 0;
    this.queue = [];
    this.spawnTimer = 0;
    this.pendingGroups = [];
    this.totalSpawned = 0;
    this.waveKills = 0;
    this.bossWave = false;
    this.bossIndex = 0;
    this.rifts.clear();
  }

  get isBossWave() { return this.bossWave; }

  waveBudget(w) {
    // Wave length is spawn-rate bound, not kill-rate bound, so the budget curve
    // is deliberately flatter than the enemy-strength curve.
    const base = 6 + w * 3.0 + Math.pow(w, 1.5) * 0.5;
    return Math.round(base * this.game.difficulty.spawnRate);
  }

  unlockedTypes(w) {
    let types = UNLOCKS[0].types;
    for (const u of UNLOCKS) if (w >= u.wave) types = u.types;
    return types;
  }

  hpScale(w) { return 1 + Math.max(0, w - 1) * 0.078; }
  speedScale(w) { return 1 + Math.min(0.35, Math.max(0, w - 1) * 0.014); }
  maxAlive(w) { return Math.round(clamp(12 + w * 1.8, 12, 40)); }

  isBossFor(w) {
    if (this.game.mode.id === 'endless') return w % 5 === 0;
    return w === 5 || w === 10 || w === 15;
  }

  bossKindFor(w) {
    const i = Math.max(0, Math.floor(w / 5) - 1);
    return BOSS_ORDER[i % BOSS_ORDER.length];
  }

  /** Build the shopping list of enemies for a wave. */
  planWave(w) {
    const rng = this.game.rng;
    const types = this.unlockedTypes(w);
    let budget = this.waveBudget(w);
    const list = [];
    const eliteChance = w < 4 ? 0 : clamp(0.04 + (w - 4) * 0.018, 0, 0.24);
    let guard = 0;
    while (budget > 0 && guard++ < 400) {
      const options = types
        .map((id) => ({ id, weight: WEIGHTS[id](w) }))
        .filter((o) => ENEMY_TYPES[o.id].cost <= budget + 1);
      if (!options.length) break;
      const pick = rng.weighted(options, (o) => o.weight);
      const t = ENEMY_TYPES[pick.id];
      const elite = rng.chance(eliteChance) && t.tier >= 2;
      budget -= t.cost * (elite ? 2 : 1);
      list.push({ id: pick.id, elite });
    }
    rng.shuffle(list);
    // pack into arrival groups of 2-5
    const groups = [];
    let i = 0;
    while (i < list.length) {
      const n = Math.min(list.length - i, 2 + Math.floor(rng.next() * 4));
      groups.push(list.slice(i, i + n));
      i += n;
    }
    return groups;
  }

  start(wave) {
    const g = this.game;
    this.wave = wave;
    this.state = 'intro';
    this.stateTime = 0;
    this.waveKills = 0;
    this.totalSpawned = 0;
    this.bossWave = this.isBossFor(wave);
    this.pendingGroups = this.bossWave ? [] : this.planWave(wave);
    this.spawnTimer = 0.6;

    // hostiles get meaningfully more dangerous, not just more numerous
    g.enemyDamageMult = g.difficulty.enemyDamage * (1 + Math.max(0, wave - 1) * 0.032);
    const threats = this.bossWave ? 'BOSS SIGNATURE DETECTED' : this._threatLine(wave);
    g.ui.banner(`WAVE ${wave}`, threats, this.bossWave ? 'danger' : '');
    g.audio.play('waveStart');
    g.audio.setMusicMode(this.bossWave ? 'boss' : 'combat');
    g.audio.setIntensity(clamp01(0.25 + wave * 0.05));
    g.world.setThreat(clamp01(wave / 18) * 0.45 + (this.bossWave ? 0.3 : 0));
    g.ui.setWave(wave, g.mode.waves);
  }

  _threatLine(w) {
    const types = this.unlockedTypes(w);
    const newest = types[types.length - 1];
    if (w === 2) return 'NEW CONTACT — DRONE';
    if (w === 3) return 'NEW CONTACT — SPLITTER';
    if (w === 4) return 'NEW CONTACT — SEEDER';
    if (w === 6) return 'NEW CONTACT — LANCER';
    if (w === 7) return 'NEW CONTACT — SENTINEL';
    const names = { skitter: 'SWARM', drone: 'GUNNERY', splitter: 'UNSTABLE', seeder: 'ARTILLERY', lancer: 'ARMOUR', sentinel: 'SIEGE' };
    return `${names[newest] || 'VOID'} ELEMENTS INBOUND`;
  }

  /** Pick a spawn point away from the player, inside the deck. */
  _spawnPoint() {
    const g = this.game;
    const rng = g.rng;
    const p = g.player.position;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      const a = rng.next() * TAU;
      const r = lerp(18, g.world.radius - 6, rng.next());
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const dp = Math.hypot(x - p.x, z - p.z);
      if (dp < 13) continue;
      let clear = true;
      for (const ob of g.world.obstacles) {
        if (Math.hypot(x - ob.x, z - ob.z) < ob.r + 3.5) { clear = false; break; }
      }
      if (!clear) continue;
      const score = dp - Math.abs(dp - 26) * 0.7;
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    if (best) return best;
    const a = rng.next() * TAU;
    return { x: Math.cos(a) * 30, z: Math.sin(a) * 30 };
  }

  update(dt) {
    const g = this.game;
    this.stateTime += dt;
    this.rifts.update(dt);

    switch (this.state) {
      case 'intro':
        if (this.stateTime > 1.5) { this.state = this.bossWave ? 'boss' : 'spawning'; this.stateTime = 0; if (this.bossWave) this._spawnBoss(); }
        break;

      case 'spawning': {
        this.spawnTimer -= dt;
        const alive = g.enemies.threatCount;
        if (this.spawnTimer <= 0 && this.pendingGroups.length) {
          if (alive < this.maxAlive(this.wave)) {
            const group = this.pendingGroups.shift();
            this._spawnGroup(group);
            this.spawnTimer = clamp(2.0 - this.wave * 0.06, 0.85, 2.0) + g.rng.range(0, 0.4);
          } else {
            this.spawnTimer = 0.5;
          }
        }
        if (!this.pendingGroups.length) { this.state = 'fighting'; this.stateTime = 0; }
        break;
      }

      case 'fighting':
        if (g.enemies.threatCount === 0 && g.projectiles.shells.count === 0) {
          this._clear();
        }
        break;

      case 'boss':
        if (!g.boss.active && g.boss.state !== 'dying' && this.stateTime > 1) this._clear();
        break;

      default:
        break;
    }
    g.ui.setWaveProgress(this.progress());
  }

  progress() {
    if (this.state === 'boss') return this.game.boss.active ? this.game.boss.healthPct : 0;
    const total = this.totalSpawned + this._pendingCount();
    if (total <= 0) return 1;
    const remaining = this.game.enemies.threatCount + this._pendingCount();
    return clamp01(1 - remaining / total);
  }

  _pendingCount() {
    let n = 0;
    for (const g of this.pendingGroups) n += g.length;
    return n;
  }

  _spawnGroup(group) {
    const g = this.game;
    const pt = this._spawnPoint();
    const rift = this.rifts.open(pt.x, pt.z, 3.4, 1.6);
    const hpScale = this.hpScale(this.wave);
    const speedScale = this.speedScale(this.wave);
    // stagger arrivals inside the rift's open window
    group.forEach((entry, i) => {
      g.after(0.55 + i * 0.13, () => {
        const a = g.rng.next() * TAU;
        const r = g.rng.range(0, 2.2);
        const e = g.enemies.spawn(entry.id, pt.x + Math.cos(a) * r, pt.z + Math.sin(a) * r, {
          elite: entry.elite, hpScale, speedScale,
        });
        if (e) this.totalSpawned++;
      });
    });
  }

  _spawnBoss() {
    const g = this.game;
    const kind = this.bossKindFor(this.wave);
    const cycle = Math.max(0, Math.floor((this.wave - 1) / 15));
    g.boss.spawn(kind, 1 + cycle * 0.7 + (this.wave > 15 ? (this.wave - 15) * 0.035 : 0));
  }

  _clear() {
    const g = this.game;
    this.state = 'cleared';
    this.stateTime = 0;
    g.audio.play('waveClear');
    g.audio.setIntensity(0.2);
    g.world.setThreat(0.1);
    g.onWaveCleared(this.wave);
  }

  clear() {
    this.pendingGroups.length = 0;
    this.rifts.clear();
    this.state = 'idle';
  }

  dispose() { this.rifts.dispose(); }
}
