/**
 * enemies.js — the Void constructs and their behaviour.
 *
 * Six archetypes, each with a distinct threat vector so a wave composition
 * actually changes how you play:
 *   Skitter  — swarm pressure, forces movement
 *   Drone    — ranged chip damage, punishes standing still
 *   Sentinel — telegraphed line beam, punishes lazy positioning
 *   Lancer   — charge attack, punishes tunnel vision
 *   Seeder   — area denial mortars, punishes camping
 *   Splitter — splits on death, punishes greedy clears
 *
 * All of them share one steering core (seek + separation + obstacle avoidance)
 * and one lifecycle (spawn dissolve -> behaviour -> death dissolve).
 */
import { Pool, clamp, clamp01, damp, lengthXZ, lerp, TAU, wrapAngle } from '../core/util.js';
import { createNovaMaterial } from '../render/materials.js';
import { Pose, Animator } from '../render/rig.js';
import { RIGGED_ENEMIES } from '../render/rig-models.js';
import {
  buildSkitter, buildDrone, buildSentinel, buildLancer, buildSeeder, buildSplitter, PALETTE,
} from '../render/models.js';

let NEXT_ID = 1;

export const ENEMY_TYPES = {
  skitter: {
    id: 'skitter', name: 'SKITTER', build: buildSkitter, cap: 64,
    hp: 24, speed: 15.5, radius: 0.85, score: 12, shards: 1, contact: 12, tier: 1,
    color: 0xff3ea5, hover: 0, cost: 1,
    codex: 'Cheap swarm chassis. Rushes, lunges, detonates. Never fight one — fight the pattern.',
  },
  drone: {
    id: 'drone', name: 'DRONE', build: buildDrone, cap: 44,
    hp: 38, speed: 11.5, radius: 1.0, score: 20, shards: 2, contact: 8, tier: 1,
    color: 0xff6ec7, hover: 2.3, cost: 2,
    codex: 'Standoff gunnery platform. Keeps its distance and chips at you. Close or die slowly.',
  },
  splitter: {
    id: 'splitter', name: 'SPLITTER', build: buildSplitter, cap: 22,
    hp: 74, speed: 9.5, radius: 1.05, score: 30, shards: 2, contact: 14, tier: 2,
    color: 0xa06bff, hover: 1.6, cost: 3,
    codex: 'Unstable lattice. Breaks into two Skitters when killed — clear the room before it pops.',
  },
  seeder: {
    id: 'seeder', name: 'SEEDER', build: buildSeeder, cap: 14,
    hp: 88, speed: 7.5, radius: 1.25, score: 42, shards: 3, contact: 10, tier: 2,
    color: 0xffb347, hover: 0, cost: 4,
    codex: 'Artillery frame. Lobs shells at where you are going. Standing still is a decision.',
  },
  lancer: {
    id: 'lancer', name: 'LANCER', build: buildLancer, cap: 18,
    hp: 135, speed: 9.0, radius: 1.35, score: 55, shards: 3, contact: 18, tier: 3,
    color: 0xffb347, hover: 0, cost: 5,
    codex: 'Armoured ram. Winds up, then crosses the deck in a heartbeat. Dash sideways, never back.',
  },
  sentinel: {
    id: 'sentinel', name: 'SENTINEL', build: buildSentinel, cap: 14,
    hp: 165, speed: 5.6, radius: 1.4, score: 65, shards: 4, contact: 12, tier: 3,
    color: 0xff2f8f, hover: 0.0, cost: 6,
    codex: 'Siege tripod. Paints a line, then deletes it. The telegraph is your whole window.',
  },
  /** Invisible hit proxy that lets bosses reuse all normal weapon collision. */
  bossCore: {
    id: 'bossCore', name: 'BOSS', build: buildProxy, cap: 2, hidden: true,
    hp: 1, speed: 0, radius: 5, score: 0, shards: 0, contact: 20, tier: 4,
    color: 0xff3ea5, hover: 3, cost: 0, codex: '',
  },
};

function buildProxy() { return { geometry: new THREE.OctahedronGeometry(0.2, 0), radius: 0.2 }; }

export const ENEMY_LIST = Object.values(ENEMY_TYPES).filter((t) => !t.hidden);
export const ALL_ENEMY_TYPES = Object.values(ENEMY_TYPES);

const CELL = 8;

export class Enemies {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.pools = {};
    this.geos = {};
    this.active = [];
    this.grid = new Map();
    this._queryOut = [];

    this.specs = {};
    for (const t of ALL_ENEMY_TYPES) {
      // Rigged types bring a skeleton + compiled clips; the hidden boss proxy
      // stays a plain static mesh.
      const spec = RIGGED_ENEMIES[t.id] ? RIGGED_ENEMIES[t.id]() : t.build();
      this.specs[t.id] = spec;
      this.geos[t.id] = spec.geometry;
      this.pools[t.id] = new Pool(() => {
        const pose = spec.skeleton ? new Pose(spec.skeleton) : null;
        const mat = createNovaMaterial({ pose, rim: 0.95, spec: 0.4, rimColor: t.color, dissolveColor: t.color });
        const mesh = new THREE.Mesh(spec.geometry, mat);
        mesh.visible = false;
        mesh.frustumCulled = true;
        scene.add(mesh);
        return {
          mesh, mat, type: t, id: 0,
          pose, animator: pose ? new Animator(pose, spec.clips) : null,
          spin: 0, animState: '',
          torso: spec.torso || null, limbs: spec.limbs || null,
          flinch: 0, flinchX: 0, flinchZ: 0,
        };
      }, t.cap, (e) => { e.mesh.visible = false; });
    }
  }

  get count() { return this.active.length; }

  /** Number of enemies that count toward "wave cleared". */
  get threatCount() {
    let n = 0;
    for (const e of this.active) if (!e.dying) n++;
    return n;
  }

  spawn(typeId, x, z, opts = {}) {
    const t = ENEMY_TYPES[typeId];
    if (!t) return null;
    const e = this.pools[typeId].acquire();
    if (!e) return null;
    const g = this.game;
    const d = g.difficulty;
    const elite = !!opts.elite;
    const waveScale = opts.hpScale === undefined ? 1 : opts.hpScale;

    e.id = NEXT_ID++;
    e.type = t;
    e.typeId = typeId;
    e.x = x; e.z = z;
    e.y = t.hover;
    e.vx = 0; e.vz = 0;
    e.maxHp = t.hp * d.enemyHp * waveScale * (elite ? 2.1 : 1);
    e.hp = e.maxHp;
    e.speed = t.speed * d.enemySpeed * (elite ? 0.92 : 1) * (opts.speedScale || 1);
    e.damage = t.contact * (g.enemyDamageMult || d.enemyDamage);
    e.radius = t.radius * (elite ? 1.28 : 1);
    e.scale = elite ? 1.28 : 1;
    e.elite = elite;
    e.alive = true;
    e.dying = false;
    e.state = 'spawn';
    e.stateTime = 0;
    e.spawnT = 0;
    e.attackTimer = 0.6 + Math.random() * 0.8;
    e.burst = 0;
    e.strafe = Math.random() < 0.5 ? 1 : -1;
    e.strafeTimer = 1 + Math.random() * 2;
    e.chill = 0;
    e.chillTimer = 0;
    e.flash = 0;
    e.contactTimer = 0;
    e.yaw = Math.atan2(g.player.position.x - x, g.player.position.z - z);
    e.beam = null;
    e.decal = null;
    e.wobble = Math.random() * TAU;
    e.bob = Math.random() * TAU;
    e.dropChance = opts.dropChance === undefined ? 1 : opts.dropChance;
    e.scoreValue = t.score * (elite ? 2.4 : 1);
    e.fromSplit = !!opts.fromSplit;

    if (e.animator) {
      e.animator.reset();
      e.animState = '';
      e.flinch = 0;
      e.spin = Math.random() * TAU;
      this._drivePose(e, 0);
    }
    e.mesh.visible = true;
    e.mesh.position.set(x, e.y, z);
    e.mesh.rotation.set(0, e.yaw, 0);
    e.mesh.scale.setScalar(e.scale);
    e.mat.uniforms.uDissolve.value = 1;
    e.mat.uniforms.uFlash.value = 0;
    e.mat.uniforms.uTint.value.setRGB(1, 1, 1);
    if (elite) e.mat.uniforms.uEmitScale.value = 1.7;
    else e.mat.uniforms.uEmitScale.value = 1;

    this.active.push(e);
    if (t.hidden) {
      e.mesh.visible = false;
      e.state = 'active';
      e.mat.uniforms.uDissolve.value = 0;
    } else {
      g.fx.rift(x, z, 2.2, t.color, 0.35, 1.4);
      g.rings.spawn(x, z, { color: t.color, from: 0.4, to: 3.4, duration: 0.45, thickness: 0.3 });
    }
    return e;
  }

  // ------------------------------------------------------------------
  //  spatial queries
  // ------------------------------------------------------------------
  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  rebuildGrid() {
    this.grid.clear();
    for (const e of this.active) {
      if (e.dying) continue;
      const cx = Math.floor(e.x / CELL), cz = Math.floor(e.z / CELL);
      const k = this._key(cx, cz);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      list.push(e);
    }
  }

  /** All live enemies whose body overlaps a circle. Reuses one output array. */
  query(x, z, r, out) {
    const res = out || this._queryOut;
    res.length = 0;
    const min = Math.floor((x - r) / CELL), max = Math.floor((x + r) / CELL);
    const minz = Math.floor((z - r) / CELL), maxz = Math.floor((z + r) / CELL);
    for (let cx = min; cx <= max; cx++) {
      for (let cz = minz; cz <= maxz; cz++) {
        const list = this.grid.get(this._key(cx, cz));
        if (!list) continue;
        for (const e of list) {
          if (e.dying) continue;
          const dx = e.x - x, dz = e.z - z;
          const rr = r + e.radius;
          if (dx * dx + dz * dz <= rr * rr) res.push(e);
        }
      }
    }
    return res;
  }

  queryFirst(x, z, r, exclude) {
    const min = Math.floor((x - r) / CELL), max = Math.floor((x + r) / CELL);
    const minz = Math.floor((z - r) / CELL), maxz = Math.floor((z + r) / CELL);
    for (let cx = min; cx <= max; cx++) {
      for (let cz = minz; cz <= maxz; cz++) {
        const list = this.grid.get(this._key(cx, cz));
        if (!list) continue;
        for (const e of list) {
          if (e.dying || (exclude && exclude.has(e.id))) continue;
          const dx = e.x - x, dz = e.z - z;
          const rr = r + e.radius;
          if (dx * dx + dz * dz <= rr * rr) return e;
        }
      }
    }
    return null;
  }

  nearestTo(x, z, maxR, exclude) {
    let best = null, bestD = maxR * maxR;
    for (const e of this.active) {
      if (e.dying || (exclude && exclude.has(e.id))) continue;
      const dx = e.x - x, dz = e.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  //  simulation
  // ------------------------------------------------------------------
  update(dt) {
    this.rebuildGrid();
    const g = this.game;
    const p = g.player;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.stateTime += dt;
      if (e.chillTimer > 0) {
        e.chillTimer -= dt;
        if (e.chillTimer <= 0) e.chill = 0;
      }
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 7);
      e.mat.uniforms.uFlash.value = e.flash;

      if (e.dying) {
        if (e.type.hidden) { this._remove(e, i); continue; }
        e.spawnT += dt / 0.35;
        if (e.animator) this._driveDeathPose(e, dt * 0.5);
        e.mat.uniforms.uDissolve.value = clamp01(e.spawnT);
        e.mesh.position.y = e.y + e.spawnT * 0.6;
        e.mesh.rotation.y += dt * 5;
        if (e.spawnT >= 1) this._remove(e, i);
        continue;
      }

      if (e.state === 'spawn') {
        e.spawnT += dt / 0.5;
        e.mat.uniforms.uDissolve.value = clamp01(1 - e.spawnT);
        e.mesh.scale.setScalar(e.scale * (0.5 + clamp01(e.spawnT) * 0.5));
        if (e.spawnT >= 1) {
          e.state = 'active'; e.stateTime = 0;
          e.mat.uniforms.uDissolve.value = 0;
          e.mesh.scale.setScalar(e.scale);
        }
      } else if (!e.type.hidden) {
        AI[e.typeId](e, dt, g, p);
      }

      if (e.type.hidden) { this._contact(e, dt, p); continue; }
      this._integrate(e, dt);
      this._contact(e, dt, p);
      if (e.animator) { this._drivePose(e, dt); e.animator.update(dt); }
      this._sync(e, dt);
    }
  }

  /** Shared steering + collision resolution. */
  _integrate(e, dt) {
    const g = this.game;
    e.x += e.vx * dt;
    e.z += e.vz * dt;

    // separation from neighbours keeps swarms readable instead of stacked
    const near = this.query(e.x, e.z, e.radius + 2.2, this._sepOut || (this._sepOut = []));
    let sx = 0, sz = 0, n = 0;
    for (const o of near) {
      if (o === e) continue;
      const dx = e.x - o.x, dz = e.z - o.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 0.001;
      const want = e.radius + o.radius + 0.35;
      if (d < want) {
        const push = (want - d) / want;
        sx += dx / d * push; sz += dz / d * push;
        n++;
      }
    }
    if (n > 0) {
      const k = e.state === 'charge' ? 6 : 20;
      e.x += sx * k * dt;
      e.z += sz * k * dt;
    }

    // obstacles
    for (const ob of g.world.obstacles) {
      const dx = e.x - ob.x, dz = e.z - ob.z;
      const rr = ob.r + e.radius;
      const dd = dx * dx + dz * dz;
      if (dd < rr * rr && dd > 0.0001) {
        const d = Math.sqrt(dd);
        e.x = ob.x + dx / d * rr;
        e.z = ob.z + dz / d * rr;
        if (e.state === 'charge') { e.state = 'stunned'; e.stateTime = 0; this._chargeCrash(e); }
      }
    }

    // arena bounds
    const R = g.world.radius - e.radius - 0.4;
    const d2 = e.x * e.x + e.z * e.z;
    if (d2 > R * R) {
      const d = Math.sqrt(d2) || 1;
      e.x = e.x / d * R; e.z = e.z / d * R;
      const dot = e.vx * (e.x / R) + e.vz * (e.z / R);
      if (dot > 0) { e.vx -= dot * (e.x / R); e.vz -= dot * (e.z / R); }
      if (e.state === 'charge') { e.state = 'stunned'; e.stateTime = 0; this._chargeCrash(e); }
    }
  }

  /**
   * Map AI state onto animation clips. Clips are only re-played when the state
   * actually changes, so crossfades are not restarted every frame.
   */
  /** Limp collapse while the corpse dissolves — the rig keeps working. */
  _driveDeathPose(e, dt) {
    const a = e.animator;
    if (!a || !e.torso) return;
    const k = clamp01(e.spawnT);
    a.offsetRot(e.torso, 0.9 * k, 0.4 * k, 0.6 * k);
    a.offsetPos(e.torso, 0, -0.7 * k, 0);
    if (e.limbs) {
      for (let i = 0; i < e.limbs.length; i++) {
        const s = i % 2 ? 1 : -1;
        a.offsetRot(e.limbs[i], 1.5 * k * s, 0.6 * k, 1.1 * k * s);
      }
    }
    a.update(dt);
  }

  _drivePose(e, dt) {
    const a = e.animator;
    e.spin += dt;
    if (e.flinch > 0) {
      e.flinch = Math.max(0, e.flinch - dt * 5.5);
      const f = e.flinch * e.flinch * 0.34;
      // flinch is in the entity's local frame, so rotate the world hit vector in
      const c = Math.cos(-e.yaw), sn = Math.sin(-e.yaw);
      const lx = e.flinchX * c - e.flinchZ * sn;
      const lz = e.flinchX * sn + e.flinchZ * c;
      if (e.torso) {
        a.offsetRot(e.torso, lz * f, 0, -lx * f);
        a.offsetPos(e.torso, lx * f * 0.35, 0, lz * f * 0.35);
      }
    }
    const speed = Math.hypot(e.vx, e.vz);
    const moving = speed > 1.4;
    const set = (name, opts) => {
      if (e.animState === name) return;
      e.animState = name;
      a.play(name, opts);
    };

    switch (e.typeId) {
      case 'skitter': {
        if (e.state === 'lunge') set('lunge', { fade: 0.05, speed: 1.1 });
        else if (moving) {
          set('scuttle', { fade: 0.12 });
          a.speed = clamp(speed / 9, 0.65, 2.4);
        } else set('idle', { fade: 0.2 });
        break;
      }
      case 'drone': {
        if (a.playing === 'fire' && !a.finished) break;
        set('hover', { fade: 0.15 });
        a.offsetRot('ring', 0, e.spin * 2.2, 0);
        a.offsetRot('body', 0, 0, clamp(-e.vx * 0.02, -0.35, 0.35));
        break;
      }
      case 'splitter': {
        const near = this.game.player.alive
          && lengthXZ(this.game.player.position.x - e.x, this.game.player.position.z - e.z) < 13;
        set(near ? 'strain' : 'idle', { fade: 0.25 });
        a.offsetRot('core', e.spin * 0.9, e.spin * 1.3, 0);
        break;
      }
      case 'seeder': {
        if (a.playing === 'fire' && !a.finished) break;
        set('idle', { fade: 0.2 });
        break;
      }
      case 'lancer': {
        if (e.state === 'windup') set('windup', { fade: 0.12 });
        else if (e.state === 'charge') set('charge', { fade: 0.08, speed: 1.6 });
        else if (e.state === 'stunned') set('stunned', { fade: 0.14 });
        else {
          set('prowl', { fade: 0.2 });
          a.speed = clamp(0.55 + speed / 10, 0.55, 2.0);
        }
        break;
      }
      case 'sentinel': {
        if (e.state === 'charging') set('brace', { fade: 0.16 });
        else if (e.state === 'firing') set('fire', { fade: 0.05 });
        else {
          set('walk', { fade: 0.22 });
          a.speed = clamp(0.35 + speed / 6, 0.35, 1.8);
        }
        break;
      }
      default:
        break;
    }
  }

  _chargeCrash(e) {
    const g = this.game;
    g.fx.dust(e.x, e.z, 4, 0xffb347, 12);
    g.fx.hit(e.x, e.y + 0.6, e.z, -e.vx, -e.vz, 0xffb347, 1.4);
    g.screen.addTrauma(0.16);
    g.world.addRipple(e.x, e.z, 0.8);
    g.audio.play('kill', { gain: 0.5 });
    e.vx = -e.vx * 0.3; e.vz = -e.vz * 0.3;
    g.damageEnemy(e, e.maxHp * 0.08, { x: e.x, z: e.z, source: 'crash', silent: true });
  }

  _contact(e, dt, p) {
    if (!p.alive || e.type.contact <= 0) return;
    e.contactTimer = Math.max(0, e.contactTimer - dt);
    const dx = p.position.x - e.x, dz = p.position.z - e.z;
    const rr = e.radius + p.radius;
    if (dx * dx + dz * dz > rr * rr) return;
    if (e.typeId === 'skitter') { this._skitterPop(e); return; }
    if (e.contactTimer > 0) return;
    e.contactTimer = e.state === 'charge' ? 1.2 : 0.75;
    const mult = e.state === 'charge' ? 2.0 : 1;
    this.game.damagePlayer(e.damage * mult, e.x, e.z, { knock: e.state === 'charge' ? 26 : 12 });
    if (e.state === 'charge') { e.state = 'stunned'; e.stateTime = 0; e.vx *= 0.2; e.vz *= 0.2; }
  }

  _skitterPop(e) {
    const g = this.game;
    g.explosionAt(e.x, e.z, 3.0, e.damage * 1.35, 1, 0xff3ea5);
    this.kill(e, { silentScore: true, noDrop: true });
  }

  _sync(e, dt) {
    const t = this.game.time;
    e.bob += dt;
    let y = e.type.hover;
    if (e.type.hover > 0.2) y += Math.sin(e.bob * 2.2 + e.wobble) * 0.22;
    e.y = y;
    e.mesh.position.set(e.x, y, e.z);
    if (e.typeId === 'splitter') {
      e.mesh.rotation.y += dt * 0.9;
      e.mesh.rotation.x = Math.sin(e.bob * 0.8) * 0.25;
    } else {
      e.mesh.rotation.y = e.yaw;
      e.mesh.rotation.z = 0;
    }
    // charging tells: the body glows hotter as the attack lands
    if (e.state === 'windup' || e.state === 'charging') {
      const k = 1 + Math.sin(t * 26) * 0.4;
      e.mat.uniforms.uEmitScale.value = (e.elite ? 1.7 : 1) * (1 + k * 1.1);
      e.mat.uniforms.uTint.value.setRGB(1 + k * 0.4, 0.7, 0.8);
    } else if (e.state === 'active' || e.state === 'charge' || e.state === 'stunned') {
      e.mat.uniforms.uEmitScale.value = e.elite ? 1.7 : 1;
      e.mat.uniforms.uTint.value.setRGB(1, 1, 1);
    }
    this.game.shadows.push(e.x, y, e.z, e.radius * 1.25, 0.9);
  }

  // ------------------------------------------------------------------
  hurt(e, amount, opts = {}) {
    if (e.dying) return 0;
    e.hp -= amount;
    e.flash = 1;
    // a visible flinch away from the hit sells the impact more than a flash alone
    if (e.animator && e.torso) {
      const dx = opts.dx === undefined ? 0 : opts.dx;
      const dz = opts.dz === undefined ? 0 : opts.dz;
      const d = Math.hypot(dx, dz) || 1;
      e.flinch = Math.min(1, e.flinch + 0.55 + Math.min(0.45, amount / e.maxHp));
      e.flinchX = dx / d;
      e.flinchZ = dz / d;
    }
    if (opts.chill) { e.chill = Math.max(e.chill, opts.chill); e.chillTimer = 1.3; }
    if (opts.knock) {
      const dx = opts.dx === undefined ? 0 : opts.dx;
      const dz = opts.dz === undefined ? 0 : opts.dz;
      const d = lengthXZ(dx, dz) || 1;
      const mass = e.type.tier >= 3 ? 0.42 : e.type.tier === 2 ? 0.72 : 1;
      e.vx += dx / d * opts.knock * mass;
      e.vz += dz / d * opts.knock * mass;
    }
    if (e.hp <= 0) { this.kill(e, opts); return amount; }
    return amount;
  }

  kill(e, opts = {}) {
    if (e.dying) return;
    const g = this.game;
    e.dying = true;
    e.spawnT = 0;
    e.hp = 0;
    if (e.beam) { g.beams.release(e.beam); e.beam = null; }
    if (e.decal) { g.decals.release(e.decal); e.decal = null; }

    const t = e.type;
    if (t.hidden) {
      g.onEnemyKilled(e, opts);
      return;
    }
    g.fx.explode(e.x, e.y + 0.4, e.z, 0.55 + t.radius * 0.55, 0xffe9b0, t.color);
    const chunks = e.elite ? 9 : 5;
    for (let i = 0; i < chunks; i++) {
      g.debris.spawn(e.x, e.y + 0.4 + Math.random() * t.radius, e.z, {
        speed: 7 + t.radius * 3, scale: 0.45 + t.radius * 0.4, life: 1.5, tint: t.color,
      });
    }
    g.scorch(e.x, e.z, 1.2 + t.radius * 0.9, t.color);
    g.rings.spawn(e.x, e.z, { color: t.color, from: 0.5, to: 2.6 + t.radius, duration: 0.34, thickness: 0.3 });
    g.audio.play('kill', { gain: clamp(0.4 + t.radius * 0.3, 0.3, 1) });
    g.world.addRipple(e.x, e.z, 0.35 + t.radius * 0.2);
    g.screen.addTrauma(0.05 + t.radius * 0.03);

    if (!opts.noDrop && e.dropChance > 0) {
      const shards = t.shards + (e.elite ? 3 : 0);
      g.pickups.spawnShards(e.x, e.z, shards, e.elite);
      if (e.elite || Math.random() < 0.07) g.pickups.spawnOrb(e.x, e.z, 'heal');
      if (Math.random() < 0.05) g.pickups.spawnOrb(e.x, e.z, 'energy');
    }

    if (e.typeId === 'splitter' && !opts.noSplit) {
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * TAU;
        const child = this.spawn('skitter', e.x + Math.cos(a) * 1.6, e.z + Math.sin(a) * 1.6, {
          fromSplit: true, dropChance: 0.35, hpScale: opts.waveHpScale || 1,
        });
        if (child) { child.vx = Math.cos(a) * 8; child.vz = Math.sin(a) * 8; }
      }
    }

    g.onEnemyKilled(e, opts);
    if (this.game.player.stats.explodeOnKill > 0 && !opts.fromExplosion) {
      g.explosionAt(e.x, e.z, 4.4, this.game.player.stats.explodeOnKill, 0, 0xffc24a, { fromKill: true });
    }
  }

  _remove(e, index) {
    const i = index === undefined ? this.active.indexOf(e) : index;
    if (i >= 0) this.active.splice(i, 1);
    this.pools[e.typeId].release(e);
  }

  clear() {
    for (const e of this.active) {
      if (e.beam) { this.game.beams.release(e.beam); e.beam = null; }
      if (e.decal) { this.game.decals.release(e.decal); e.decal = null; }
      this.pools[e.typeId].release(e);
    }
    this.active.length = 0;
    this.grid.clear();
  }

  dispose() {
    this.clear();
    for (const id in this.pools) {
      this.pools[id].items.forEach((e) => { e.mat.dispose(); if (e.mesh.parent) e.mesh.parent.remove(e.mesh); });
    }
    for (const id in this.geos) this.geos[id].dispose();
  }
}

// ======================================================================
//  Steering helpers
// ======================================================================
function seek(e, tx, tz, dt, speedMult = 1) {
  const dx = tx - e.x, dz = tz - e.z;
  const d = lengthXZ(dx, dz) || 1;
  const sp = e.speed * speedMult * (1 - e.chill);
  const wantX = dx / d * sp, wantZ = dz / d * sp;
  const accel = 26 * dt;
  e.vx += (wantX - e.vx) * clamp01(accel);
  e.vz += (wantZ - e.vz) * clamp01(accel);
  return d;
}

function orbit(e, tx, tz, dt, radius, dir, speedMult = 1) {
  const dx = e.x - tx, dz = e.z - tz;
  const d = lengthXZ(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const tangX = -nz * dir, tangZ = nx * dir;
  const radial = (d - radius) * -0.9;
  const sp = e.speed * speedMult * (1 - e.chill);
  const wantX = (tangX + nx * clamp(radial, -1.4, 1.4)) * sp;
  const wantZ = (tangZ + nz * clamp(radial, -1.4, 1.4)) * sp;
  e.vx += (wantX - e.vx) * clamp01(22 * dt);
  e.vz += (wantZ - e.vz) * clamp01(22 * dt);
  return d;
}

function brake(e, dt, k = 6) {
  const f = Math.max(0, 1 - k * dt);
  e.vx *= f; e.vz *= f;
}

function faceTarget(e, tx, tz, dt, rate = 0.00002) {
  const want = Math.atan2(tx - e.x, tz - e.z);
  e.yaw = e.yaw + wrapAngle(want - e.yaw) * (1 - Math.pow(rate, dt));
}

// ======================================================================
//  Per-archetype behaviour
// ======================================================================
const AI = {
  skitter(e, dt, g, p) {
    faceTarget(e, p.position.x, p.position.z, dt, 0.000001);
    if (e.state === 'lunge') {
      if (e.stateTime > 0.55) { e.state = 'active'; e.stateTime = 0; }
      brake(e, dt, 1.2);
      return;
    }
    // weaving approach so a swarm doesn't collapse into a single line
    e.wobble += dt * 3.4;
    const weave = Math.sin(e.wobble) * 0.35;
    const dx = p.position.x - e.x, dz = p.position.z - e.z;
    const d = lengthXZ(dx, dz) || 1;
    const px = -dz / d, pz = dx / d;
    const tx = p.position.x + px * weave * 6;
    const tz = p.position.z + pz * weave * 6;
    const dist = seek(e, tx, tz, dt, 1);
    if (dist < 5.5 && e.stateTime > 0.4) {
      e.state = 'lunge';
      e.stateTime = 0;
      const l = lengthXZ(dx, dz) || 1;
      e.vx = dx / l * e.speed * 2.5;
      e.vz = dz / l * e.speed * 2.5;
      g.audio.play('enemyShoot', { gain: 0.25, pitch: 1.8 });
    }
  },

  drone(e, dt, g, p) {
    faceTarget(e, p.position.x, p.position.z, dt);
    e.strafeTimer -= dt;
    if (e.strafeTimer <= 0) { e.strafeTimer = 1.8 + Math.random() * 2.4; e.strafe *= -1; }
    const d = orbit(e, p.position.x, p.position.z, dt, 15, e.strafe, 1);
    e.attackTimer -= dt;
    if (e.attackTimer <= 0 && d < 26 && g.hasLOS(e.x, e.z, p.position.x, p.position.z)) {
      if (e.burst <= 0) e.burst = 2 + (e.elite ? 2 : 0);
      e.attackTimer = e.burst > 1 ? 0.16 : 2.1 + Math.random() * 0.7;
      e.burst--;
      const dx = p.position.x - e.x, dz = p.position.z - e.z;
      const l = lengthXZ(dx, dz) || 1;
      const spread = 0.06;
      const a = Math.atan2(dx / l, dz / l) + (Math.random() - 0.5) * spread;
      g.projectiles.fireEnemy(e.x, e.y - 0.1, e.z, Math.sin(a), Math.cos(a), {
        speed: 32, damage: 9 * (g.enemyDamageMult || 1), color: e.type.color, radius: 0.5,
      });
      g.fx.muzzle(e.x, e.y - 0.1, e.z, dx / l, dz / l, e.type.color, 0.7);
      g.audio.play('enemyShoot', { gain: 0.5 });
      if (e.animator) { e.animator.play('fire', { fade: 0.04, restart: true }); e.animState = 'fire'; }
    }
  },

  splitter(e, dt, g, p) {
    seek(e, p.position.x, p.position.z, dt, 1);
    e.yaw += dt;
  },

  seeder(e, dt, g, p) {
    faceTarget(e, p.position.x, p.position.z, dt);
    const dx = p.position.x - e.x, dz = p.position.z - e.z;
    const d = lengthXZ(dx, dz);
    if (d < 20) { seek(e, e.x - dx, e.z - dz, dt, 0.9); }
    else if (d > 32) { seek(e, p.position.x, p.position.z, dt, 1); }
    else { brake(e, dt, 3); orbit(e, p.position.x, p.position.z, dt, 26, e.strafe, 0.45); }

    e.attackTimer -= dt;
    if (e.attackTimer <= 0) {
      e.attackTimer = 2.9 + Math.random() * 0.9;
      const flight = 1.5;
      const lead = 0.65;
      const tx = clamp(p.position.x + p.velocity.x * flight * lead, -g.world.radius + 3, g.world.radius - 3);
      const tz = clamp(p.position.z + p.velocity.z * flight * lead, -g.world.radius + 3, g.world.radius - 3);
      g.projectiles.fireMortar(e.x, e.y + 1.4, e.z, tx, tz, {
        time: flight, height: 13, damage: 20 * (g.enemyDamageMult || 1), aoe: 5.4,
      });
      g.audio.play('mortar', { gain: 0.6 });
      g.fx.muzzle(e.x, e.y + 1.6, e.z, 0, 0, 0xffb347, 1);
      if (e.animator) { e.animator.play('fire', { fade: 0.04, restart: true }); e.animState = 'fire'; }
      if (e.elite) {
        const a2 = Math.random() * TAU;
        g.projectiles.fireMortar(e.x, e.y + 1.4, e.z, tx + Math.cos(a2) * 6, tz + Math.sin(a2) * 6, {
          time: flight * 1.1, height: 13, damage: 20 * (g.enemyDamageMult || 1), aoe: 5.4,
        });
      }
    }
  },

  lancer(e, dt, g, p) {
    const dx = p.position.x - e.x, dz = p.position.z - e.z;
    const d = lengthXZ(dx, dz) || 1;
    switch (e.state) {
      case 'active': {
        faceTarget(e, p.position.x, p.position.z, dt);
        seek(e, p.position.x, p.position.z, dt, 1);
        if (d < 22 && e.stateTime > 1.1) { e.state = 'windup'; e.stateTime = 0; g.audio.play('charge', { dur: 0.8, gain: 0.7 }); }
        break;
      }
      case 'windup': {
        brake(e, dt, 5);
        faceTarget(e, p.position.x, p.position.z, dt, 0.0008);
        if (!e.decal) e.decal = g.decals.acquire(e.x, e.z, 3.2, 0xffb347, { fill: 0.6, thickness: 0.2, opacity: 0.9 });
        g.decals.set(e.decal, e.x, e.z, 3.2, clamp01(e.stateTime / 0.85), 0.9);
        if (e.stateTime > 0.85) {
          e.state = 'charge'; e.stateTime = 0;
          if (e.decal) { g.decals.release(e.decal); e.decal = null; }
          const sx = Math.sin(e.yaw), sz = Math.cos(e.yaw);
          e.vx = sx * 46; e.vz = sz * 46;
          g.fx.dust(e.x, e.z, 3, 0xffb347, 10);
          g.audio.play('dash', { gain: 0.8 });
        }
        break;
      }
      case 'charge': {
        e.vx *= Math.max(0, 1 - 0.55 * dt);
        e.vz *= Math.max(0, 1 - 0.55 * dt);
        g.fx.glow.spawn({
          x: e.x, y: e.y + 0.6, z: e.z, color: 0xffc24a, color2: 0xff3ea5,
          size: 1.6, size2: 0.1, life: 0.26, alpha: 0.7, drag: 2.6,
        });
        if (e.stateTime > 1.15) { e.state = 'recover'; e.stateTime = 0; }
        break;
      }
      case 'stunned': {
        brake(e, dt, 4);
        e.mesh.rotation.z = Math.sin(e.stateTime * 30) * 0.12;
        if (e.stateTime > 1.4) { e.state = 'active'; e.stateTime = 0; e.mesh.rotation.z = 0; }
        break;
      }
      default: {
        brake(e, dt, 4);
        if (e.stateTime > 0.9) { e.state = 'active'; e.stateTime = 0; }
      }
    }
  },

  sentinel(e, dt, g, p) {
    const dx = p.position.x - e.x, dz = p.position.z - e.z;
    const d = lengthXZ(dx, dz) || 1;
    switch (e.state) {
      case 'active': {
        faceTarget(e, p.position.x, p.position.z, dt, 0.001);
        if (d > 26) seek(e, p.position.x, p.position.z, dt, 1);
        else if (d < 12) seek(e, e.x - dx, e.z - dz, dt, 0.8);
        else brake(e, dt, 3);
        e.attackTimer -= dt;
        if (e.attackTimer <= 0 && d < 30 && g.hasLOS(e.x, e.z, p.position.x, p.position.z)) {
          e.state = 'charging'; e.stateTime = 0;
          e.aimX = p.position.x; e.aimZ = p.position.z;
          g.audio.play('charge', { dur: 1.05, gain: 0.8 });
        }
        break;
      }
      case 'charging': {
        brake(e, dt, 6);
        // tracks slowly during the wind-up: dodgeable, but only if you move
        const trackRate = e.elite ? 2.4 : 1.4;
        e.aimX = lerp(e.aimX, p.position.x, clamp01(trackRate * dt));
        e.aimZ = lerp(e.aimZ, p.position.z, clamp01(trackRate * dt));
        faceTarget(e, e.aimX, e.aimZ, dt, 0.0001);
        const dirX = Math.sin(e.yaw), dirZ = Math.cos(e.yaw);
        if (!e.beam) e.beam = g.beams.acquire(0xff2f8f);
        const k = clamp01(e.stateTime / 1.05);
        const len = 60;
        g.beams.set(e.beam, e.x, 1.45, e.z, e.x + dirX * len, 1.45, e.z + dirZ * len, 0.12 + k * 0.22, 0.25 + k * 0.5);
        if (e.stateTime > 1.05) { e.state = 'firing'; e.stateTime = 0; g.audio.play('beam', { dur: 0.5, gain: 0.9 }); }
        break;
      }
      case 'firing': {
        brake(e, dt, 8);
        const dirX = Math.sin(e.yaw), dirZ = Math.cos(e.yaw);
        const len = 60;
        const k = 1 - clamp01(e.stateTime / 0.42);
        if (e.beam) g.beams.set(e.beam, e.x, 1.45, e.z, e.x + dirX * len, 1.45, e.z + dirZ * len, 1.5 * k + 0.25, k);
        if (e.stateTime < 0.12 && !e.beamHit) {
          e.beamHit = true;
          const dist = g.pointSegmentDistance(p.position.x, p.position.z, e.x, e.z, e.x + dirX * len, e.z + dirZ * len);
          if (dist < 1.7 + p.radius) g.damagePlayer(24 * (g.enemyDamageMult || 1), e.x, e.z, { knock: 8 });
          g.fx.hit(e.x + dirX * 3, 1.45, e.z + dirZ * 3, dirX, dirZ, 0xff2f8f, 1.4);
          g.screen.addTrauma(0.12);
        }
        if (e.stateTime > 0.42) {
          e.state = 'active'; e.stateTime = 0; e.beamHit = false;
          e.attackTimer = 2.6 + Math.random() * 1.2;
          if (e.beam) { g.beams.release(e.beam); e.beam = null; }
        }
        break;
      }
      default:
        e.state = 'active';
    }
  },
};

export { AI as ENEMY_AI };
