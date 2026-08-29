/**
 * bosses.js — three set-piece encounters sharing one framework.
 *
 * A boss is: a part-animated model, a hit proxy registered with the enemy
 * system (so all existing weapon/pulse code just works), a phase ladder, and a
 * weighted attack scheduler. Every attack telegraphs on the deck before it
 * hurts, which is what makes the fights readable rather than random.
 */
import { clamp, clamp01, damp, lengthXZ, lerp, TAU, wrapAngle } from '../core/util.js';
import { createNovaMaterial, createEnergyMaterial } from '../render/materials.js';
import { PALETTE } from '../render/models.js';
import { RIGGED_BOSSES } from '../render/rig-models.js';
import { Pose, Animator } from '../render/rig.js';

export const BOSS_DEFS = {
  warden: {
    id: 'warden', name: 'THE WARDEN', hp: 1800, radius: 6.4, scale: 1.3, contact: 20,
    score: 1400, phases: [0.66, 0.33],
    title: 'GATE-KEEPER OF THE FIFTH RIFT',
  },
  harrower: {
    id: 'harrower', name: 'THE HARROWER', hp: 3300, radius: 5.4, scale: 1.18, contact: 24,
    score: 2600, phases: [0.70, 0.35],
    title: 'BLADE OF THE TENTH RIFT',
  },
  maw: {
    id: 'maw', name: 'THE VOID MAW', hp: 5200, radius: 7.8, scale: 1.06, contact: 30,
    score: 5000, phases: [0.72, 0.40],
    title: 'THAT WHICH EATS STABILIZERS',
  },
};

export class BossManager {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.active = false;
    this.kind = null;
    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);
    this.coreMat = createEnergyMaterial({ color: 0xff3ea5, opacity: 0.5, power: 1.8, pulse: 0.3 });
    this._built = {};
    this.mat = null;
    this.anim = null;
    this.pose = null;
    this.mesh = null;
    this.proxy = null;
    this.hazards = [];
    this.beams = [];
    this.telegraph = null;
    this._tmp = new THREE.Vector3();
  }

  _ensureBuilt(kind) {
    if (this._built[kind]) return this._built[kind];
    const spec = RIGGED_BOSSES[kind]();
    const pose = new Pose(spec.skeleton);
    const mat = createNovaMaterial({
      pose, rim: 0.9, spec: 0.5, rimColor: 0xff6ec7, dissolveColor: 0xff3ea5,
    });
    const mesh = new THREE.Mesh(spec.geometry, mat);
    mesh.frustumCulled = false;
    const built = { spec, pose, mat, mesh, anim: new Animator(pose, spec.clips) };
    this._built[kind] = built;
    return built;
  }

  spawn(kind, hpScale = 1) {
    const def = BOSS_DEFS[kind];
    if (!def) return null;
    const g = this.game;
    this.despawn(true);

    const built = this._ensureBuilt(kind);
    this.mesh = built.mesh;
    this.mat = built.mat;
    this.pose = built.pose;
    this.anim = built.anim;
    this.anim.reset();
    this.animState = '';
    this.root.add(this.mesh);
    this.root.visible = true;
    this.kind = kind;
    this.def = def;
    this.active = true;

    this.maxHp = def.hp * hpScale * g.difficulty.enemyHp;
    this.hp = this.maxHp;
    this.phase = 1;
    this.x = 0; this.z = -26;
    this.y = kind === 'maw' ? 9.5 : 6.0;
    this.vx = 0; this.vz = 0;
    this.yaw = 0;
    this.time = 0;
    this.state = 'entry';
    this.stateTime = 0;
    this.attackTimer = 3.0;
    this.currentAttack = null;
    this.attackTime = 0;
    this.attackStep = 0;
    this.damageMult = 1;
    this.invuln = 2.2;
    this.spin = 0;
    this.jaw = 0;
    this.mouthOpen = false;
    this.armAngle = 0;
    this.hazards.length = 0;

    // hit proxy so ordinary weapons collide with the boss for free
    this.proxy = g.enemies.spawn('bossCore', this.x, this.z, { hpScale: 999999 });
    if (this.proxy) {
      this.proxy.maxHp = this.maxHp;
      this.proxy.hp = this.maxHp;
      this.proxy.radius = def.radius;
      this.proxy.isBoss = true;
      this.proxy.damage = def.contact * g.difficulty.enemyDamage;
      this.proxy.scoreValue = def.score;
      this.proxy.state = 'active';
    }

    this.root.position.set(this.x, this.y, this.z);
    this.root.scale.setScalar(def.scale || 1);
    this.mat.uniforms.uDissolve.value = 1;
    g.audio.play('bossSpawn');
    g.audio.setMusicMode('boss');
    g.screen.addTrauma(0.7);
    g.ui.banner(def.name, def.title, 'danger');
    g.ui.showBoss(def.name, 1, 'PHASE I');
    g.fx.rift(this.x, this.z, 8, 0xff3ea5, 0.9, 4);
    g.rings.spawn(this.x, this.z, { color: 0xff3ea5, from: 2, to: 26, duration: 1.2, thickness: 0.1 });
    g.world.setThreat(1);
    return this;
  }

  despawn(quiet = false) {
    if (this.mesh) { this.root.remove(this.mesh); this.mesh = null; }
    this.root.visible = false;
    this.active = false;
    this.state = 'gone';        // lets the wave director know the fight is over
    for (const b of this.beams) this.game.beams.release(b);
    this.beams.length = 0;
    if (this.telegraph) { this.game.decals.release(this.telegraph); this.telegraph = null; }
    for (const h of this.hazards) if (h.decal) this.game.decals.release(h.decal);
    this.hazards.length = 0;
    if (this.proxy && !this.proxy.dying) {
      this.game.enemies.kill(this.proxy, { noDrop: true, silentScore: true });
    }
    this.proxy = null;
    if (!quiet) this.game.ui.hideBoss();
  }

  get healthPct() { return clamp01(this.hp / this.maxHp); }

  // ------------------------------------------------------------------
  hurt(amount) {
    if (!this.active || this.invuln > 0) return 0;
    const dmg = amount * this.damageMult;
    this.hp -= dmg;
    this.mat.uniforms.uFlash.value = Math.min(1, this.mat.uniforms.uFlash.value + 0.35);
    const pct = this.healthPct;
    this.game.ui.setBossHealth(pct);
    const thresholds = this.def.phases;
    const wantPhase = pct <= thresholds[1] ? 3 : pct <= thresholds[0] ? 2 : 1;
    if (wantPhase > this.phase) this._enterPhase(wantPhase);
    if (this.hp <= 0) { this.hp = 0; this._die(); }
    return dmg;
  }

  _enterPhase(n) {
    const g = this.game;
    this.phase = n;
    this.state = 'phase';
    this.stateTime = 0;
    this.invuln = 1.4;
    this.currentAttack = null;
    for (const b of this.beams) g.beams.release(b);
    this.beams.length = 0;
    g.audio.play('bossPhase');
    g.screen.addTrauma(0.6);
    g.screen.addFlash(0xff3ea5, 0.45);
    g.ui.setBossPhase(n === 2 ? 'PHASE II' : 'PHASE III');
    g.ui.banner(n === 3 ? 'FINAL PHASE' : 'PHASE ' + (n === 2 ? 'II' : 'III'), '', 'danger');
    g.rings.spawn(this.x, this.z, { color: 0xff3ea5, from: 2, to: 30, duration: 0.9, thickness: 0.09 });
    g.fx.explode(this.x, this.y, this.z, 2.4, 0xffffff, 0xff3ea5);
    // phase change clears the field of incoming fire — a breather beat
    g.projectiles.enemy.releaseAll();
  }

  _die() {
    const g = this.game;
    this.state = 'dying';
    this.stateTime = 0;
    this.active = false;
    for (const b of this.beams) g.beams.release(b);
    this.beams.length = 0;
    for (const h of this.hazards) if (h.decal) g.decals.release(h.decal);
    this.hazards.length = 0;
    if (this.telegraph) { g.decals.release(this.telegraph); this.telegraph = null; }
    if (this.proxy && !this.proxy.dying) g.enemies.kill(this.proxy, { noDrop: true, silentScore: true, isBossKill: true });
    this.proxy = null;
    g.onBossDefeated(this);
  }

  // ------------------------------------------------------------------
  update(dt) {
    if (!this.mesh) return;
    const g = this.game;
    const p = g.player;
    this.time += dt;
    this.stateTime += dt;
    this.invuln = Math.max(0, this.invuln - dt);
    const fu = this.mat.uniforms.uFlash;
    fu.value = damp(fu.value, 0, 0.00002, dt);

    if (this.state === 'entry') {
      this.mat.uniforms.uDissolve.value = clamp01(1 - this.stateTime / 0.9);
      this.z = lerp(-26, -14, clamp01(this.stateTime / 2.2));
      if (this.stateTime > 2.2) { this.state = 'idle'; this.stateTime = 0; this.mat.uniforms.uDissolve.value = 0; }
    } else if (this.state === 'dying') {
      this.mat.uniforms.uDissolve.value = clamp01(this.stateTime / 2.4);
      this.y += dt * 0.6;
      this.spin += dt * (1 + this.stateTime);
      if (Math.random() < 0.5) {
        const a = Math.random() * TAU, r = Math.random() * this.def.radius;
        g.fx.explode(this.x + Math.cos(a) * r, this.y + (Math.random() - 0.5) * 4, this.z + Math.sin(a) * r, 1.1, 0xffffff, 0xff3ea5);
        g.screen.addTrauma(0.12);
      }
      if (this.stateTime > 2.6) { this.despawn(); return; }
    } else if (this.state === 'phase') {
      this._drift(dt, p, 0.3);
      if (this.stateTime > 1.5) { this.state = 'idle'; this.stateTime = 0; this.attackTimer = 0.5; }
    } else if (this.state === 'idle') {
      this._drift(dt, p, 1);
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) this._chooseAttack(p);
    } else if (this.state === 'attack') {
      this._runAttack(dt, p);
    }

    this._updateHazards(dt, p);
    this._animate(dt, p);

    if (this.proxy) {
      this.proxy.x = this.x;
      this.proxy.z = this.z;
      this.proxy.hp = Math.max(1, this.hp);
      this.proxy.maxHp = this.maxHp;
      this.proxy.radius = this.def.radius;
      this.proxy.y = this.y;
    }
    g.shadows.push(this.x, Math.max(0, this.y - 3), this.z, this.def.radius * 1.4, 1);
  }

  _drift(dt, p, speedScale = 1) {
    const g = this.game;
    const desired = this.kind === 'maw' ? 20 : 16;
    const dx = p.position.x - this.x, dz = p.position.z - this.z;
    const d = lengthXZ(dx, dz) || 1;
    const sp = (this.kind === 'maw' ? 5.5 : 7.5) * speedScale * (this.phase >= 3 ? 1.3 : 1);
    const push = (d - desired) * 0.12;
    const wantX = dx / d * sp * clamp(push, -1, 1);
    const wantZ = dz / d * sp * clamp(push, -1, 1);
    this.vx = damp(this.vx, wantX, 0.02, dt);
    this.vz = damp(this.vz, wantZ, 0.02, dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const R = g.world.radius - this.def.radius - 3;
    const dd = lengthXZ(this.x, this.z) || 0.001;
    if (dd > R) { this.x = this.x / dd * R; this.z = this.z / dd * R; }
    // Stay clear of the central stabilizer: sitting on it would let the prop
    // body absorb every incoming shot and stall the fight.
    const inner = 9 + this.def.radius;
    if (dd < inner) {
      const nx = this.x / dd, nz = this.z / dd;
      this.x = nx * inner;
      this.z = nz * inner;
      this.vx += nx * 6 * dt;
      this.vz += nz * 6 * dt;
    }
    const want = Math.atan2(dx, dz);
    this.yaw += wrapAngle(want - this.yaw) * clamp01(dt * 2.2);
  }

  _chooseAttack(p) {
    const list = ATTACKS[this.kind].filter((a) => a.phase <= this.phase);
    const rng = this.game.rng;
    const pick = rng.weighted(list, (a) => (a.id === this._lastAttack ? a.weight * 0.35 : a.weight));
    this._lastAttack = pick.id;
    this.currentAttack = pick;
    this.state = 'attack';
    this.stateTime = 0;
    this.attackTime = 0;
    this.attackStep = 0;
    this._atkData = {};
    if (pick.start) pick.start(this, this.game, p);
  }

  _runAttack(dt, p) {
    const a = this.currentAttack;
    this.attackTime += dt;
    const done = a.run(this, this.game, p, dt);
    if (done || this.attackTime > a.maxTime) {
      if (a.end) a.end(this, this.game);
      this.currentAttack = null;
      this.state = 'idle';
      this.stateTime = 0;
      const speed = this.phase === 3 ? 0.55 : this.phase === 2 ? 0.78 : 1;
      this.attackTimer = (a.cooldown || 1.8) * speed;
    }
  }

  // ------------------------------------------------------------------
  fireRadial(g, count, speed, damage, offset = 0, opts = {}) {
    for (let i = 0; i < count; i++) {
      const a = offset + (i / count) * TAU;
      g.projectiles.fireEnemy(
        this.x + Math.sin(a) * this.def.radius * 0.8, this.y - 1.2, this.z + Math.cos(a) * this.def.radius * 0.8,
        Math.sin(a), Math.cos(a),
        { speed, damage: damage * g.difficulty.enemyDamage, color: opts.color || 0xff3ea5, radius: opts.radius || 0.55, scale: opts.scale || 1.1, homing: opts.homing || 0, life: 5 },
      );
    }
    g.audio.play('enemyShoot', { gain: 0.55, pitch: 0.7 });
  }

  fireAimed(g, p, count, spread, speed, damage, opts = {}) {
    const base = Math.atan2(p.position.x - this.x, p.position.z - this.z);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1)) - 0.5;
      const a = base + t * spread;
      g.projectiles.fireEnemy(this.x, this.y - 1.0, this.z, Math.sin(a), Math.cos(a), {
        speed, damage: damage * g.difficulty.enemyDamage, color: opts.color || 0xff6ec7,
        radius: 0.55, scale: 1.0, homing: opts.homing || 0, life: 5,
      });
    }
    g.audio.play('enemyShoot', { gain: 0.6, pitch: 0.85 });
  }

  addHazard(x, z, radius, dps, life, color = 0xa06bff) {
    const g = this.game;
    const decal = g.decals.acquire(x, z, radius, color, { fill: 1, thickness: 0.14, opacity: 0.75, dashes: 12 });
    this.hazards.push({ x, z, r: radius, dps, life, maxLife: life, decal, tick: 0 });
  }

  _updateHazards(dt, p) {
    const g = this.game;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      if (h.decal) g.decals.set(h.decal, h.x, h.z, h.r, undefined, clamp01(h.life / 1.2) * 0.75);
      if (Math.random() < dt * 12) {
        const a = Math.random() * TAU, rr = Math.random() * h.r;
        g.fx.glow.spawn({
          x: h.x + Math.cos(a) * rr, y: 0.2, z: h.z + Math.sin(a) * rr,
          vy: 1 + Math.random() * 3, color: 0xa06bff, color2: 0x2a0f4a,
          size: 0.6, size2: 0, life: 0.6, alpha: 0.7, drag: 1,
        });
      }
      h.tick -= dt;
      if (h.tick <= 0 && p.alive && lengthXZ(p.position.x - h.x, p.position.z - h.z) < h.r) {
        h.tick = 0.5;
        g.damagePlayer(h.dps * g.difficulty.enemyDamage, h.x, h.z, { knock: 0, pierceIframes: true });
      }
      if (h.life <= 0) {
        if (h.decal) g.decals.release(h.decal);
        this.hazards.splice(i, 1);
      }
    }
  }

  /** Ask the rig to play a clip, ignoring redundant re-triggers. */
  playClip(name, opts = {}) {
    if (!this.anim) return;
    if (this.animState === name && !opts.restart) return;
    this.animState = name;
    this.anim.play(name, opts);
  }

  _animate(dt, p) {
    const t = this.time;
    this.root.position.set(this.x, this.y + Math.sin(t * 0.9) * 0.35, this.z);
    this.root.rotation.y = this.yaw;
    const a = this.anim;
    if (!a) return;

    // continuous spins read better as overlays than as clip keys, which would
    // need a key every few degrees to avoid easing artefacts
    this.spin += dt * (0.5 + this.phase * 0.2);
    if (this.kind === 'warden') {
      a.offsetRot('ring', 0, this.spin * 1.15, 0);
      a.offsetRot('halo', this.spin * 0.4, this.spin * -0.7, 0);
      a.offsetRot('core', 0, -this.spin * 0.8, 0);
      // turrets track the pilot
      if (p && p.alive) {
        const aim = Math.atan2(p.position.x - this.x, p.position.z - this.z) - this.yaw;
        a.offsetRot('turretL', 0, aim - Math.PI / 2, 0);
        a.offsetRot('turretR', 0, aim + Math.PI / 2, 0);
      }
    } else if (this.kind === 'harrower') {
      a.offsetRot('core', 0, 0, Math.sin(t * 0.8) * 0.05);
    } else {
      a.offsetRot('ring', this.spin * 0.25, this.spin * 0.6, 0);
      a.offsetRot('core', 0, this.spin * 0.35, 0);
      // the eye is only exposed while the jaws are wide: that is the weak point
      const open = this.animState === 'open' || this.animState === 'devour';
      this.mouthOpen = open && a.time > 0.55;
      this.damageMult = this.mouthOpen ? 1.9 : 1;
    }

    if (this.state === 'idle' || this.state === 'phase' || this.state === 'entry') {
      this.playClip('idle', { fade: 0.3 });
    }
    a.update(dt);
  }

  dispose() {
    this.despawn(true);
    for (const k in this._built) {
      const b = this._built[k];
      b.spec.geometry.dispose();
      b.mat.dispose();
    }
    this.coreMat.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

// ======================================================================
//  Attack scripts
// ======================================================================
const ATTACKS = {
  warden: [
    {
      id: 'radial', phase: 1, weight: 30, cooldown: 1.9, maxTime: 3.4,
      start: (b) => { b._atkData.fired = 0; b._atkData.offset = Math.random() * TAU; b.playClip('barrage', { fade: 0.12, restart: true }); },
      run: (b, g, p, dt) => {
        const volleys = b.phase >= 3 ? 5 : 3;
        const gap = 0.42;
        if (b.attackTime >= b._atkData.fired * gap && b._atkData.fired < volleys) {
          const n = 10 + b.phase * 3;
          b.fireRadial(g, n, 22, 11, b._atkData.offset + b._atkData.fired * 0.22);
          b._atkData.fired++;
          g.screen.addTrauma(0.06);
        }
        return b._atkData.fired >= volleys && b.attackTime > volleys * gap + 0.3;
      },
    },
    {
      id: 'spiral', phase: 1, weight: 24, cooldown: 2.2, maxTime: 4.6,
      start: (b) => { b._atkData.a = 0; b._atkData.next = 0; b.playClip('barrage', { fade: 0.2, restart: true }); },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        d.a += dt * (b.phase >= 3 ? 3.4 : 2.4);
        d.next -= dt;
        if (d.next <= 0) {
          d.next = 0.07;
          const arms = b.phase >= 2 ? 3 : 2;
          for (let i = 0; i < arms; i++) {
            const a = d.a + (i / arms) * TAU;
            g.projectiles.fireEnemy(b.x + Math.sin(a) * 4, b.y - 1.2, b.z + Math.cos(a) * 4, Math.sin(a), Math.cos(a), {
              speed: 19, damage: 9 * g.difficulty.enemyDamage, color: 0xff6ec7, radius: 0.5, life: 5,
            });
          }
          if (Math.random() < 0.3) g.audio.play('enemyShoot', { gain: 0.3, pitch: 1.2 });
        }
        return b.attackTime > (b.phase >= 3 ? 3.6 : 2.6);
      },
    },
    {
      id: 'slam', phase: 1, weight: 20, cooldown: 2.0, maxTime: 4.0,
      start: (b, g) => {
        b._atkData.telegraph = g.decals.acquire(b.x, b.z, 15, 0xff3ea5, { fill: 0.7, thickness: 0.12, opacity: 0.9 });
        b.playClip('slam', { fade: 0.08, restart: true });
        g.audio.play('charge', { dur: 1.1 });
      },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const k = clamp01(b.attackTime / 1.1);
        if (d.telegraph) g.decals.set(d.telegraph, b.x, b.z, 15, k, 0.9);
        if (b.attackTime < 1.1) { b.y = lerp(6.0, 9.5, k); return false; }
        if (!d.hit) {
          d.hit = true;
          b.y = 4.2;
          if (d.telegraph) { g.decals.release(d.telegraph); d.telegraph = null; }
          g.explosionAt(b.x, b.z, 15, 26, 1, 0xff3ea5, { rings: 3 });
          g.screen.addTrauma(0.8);
          g.screen.stop(0.06);
          g.world.addRipple(b.x, b.z, 2);
          b.fireRadial(g, 16, 26, 10, Math.random());
        }
        b.y = damp(b.y, 6.0, 0.02, dt);
        return b.attackTime > 1.9;
      },
      end: (b, g) => { if (b._atkData.telegraph) { g.decals.release(b._atkData.telegraph); b._atkData.telegraph = null; } },
    },
    {
      id: 'summon', phase: 1, weight: 16, cooldown: 2.6, maxTime: 2.6,
      start: (b, g) => {
        const n = b.phase >= 2 ? 4 : 3;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + Math.random();
          const r = 16 + Math.random() * 10;
          g.spawnEnemyAt(b.phase >= 2 && i % 2 === 0 ? 'drone' : 'skitter', Math.cos(a) * r, Math.sin(a) * r);
        }
        b.playClip('summon', { fade: 0.1, restart: true });
        g.audio.play('rift');
      },
      run: (b) => b.attackTime > 0.8,
    },
    {
      id: 'turretBeam', phase: 2, weight: 26, cooldown: 2.2, maxTime: 4.4,
      start: (b, g) => {
        b._atkData.sweep = 0;
        b._atkData.dir = Math.random() < 0.5 ? 1 : -1;
        for (let i = 0; i < 2; i++) b.beams.push(g.beams.acquire(0xff2f8f));
        g.audio.play('charge', { dur: 0.9 });
      },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const charge = clamp01(b.attackTime / 0.9);
        d.sweep += dt * 0.85 * d.dir * (b.phase >= 3 ? 1.5 : 1);
        const live = b.attackTime > 0.9;
        if (live && !d.sounded) { d.sounded = true; g.audio.play('beam', { dur: 2.2, gain: 0.8 }); }
        for (let i = 0; i < b.beams.length; i++) {
          const a = b.yaw + d.sweep + i * Math.PI;
          const sx = b.x + Math.sin(a) * 4.6, sz = b.z + Math.cos(a) * 4.6;
          const ex = b.x + Math.sin(a) * 60, ez = b.z + Math.cos(a) * 60;
          g.beams.set(b.beams[i], sx, 1.5, sz, ex, 1.5, ez, live ? 1.2 : 0.18 + charge * 0.3, live ? 1 : 0.3 + charge * 0.4);
          if (live && p.alive) {
            const dist = g.pointSegmentDistance(p.position.x, p.position.z, sx, sz, ex, ez);
            if (dist < 1.5 + p.radius) g.damagePlayer(16 * g.difficulty.enemyDamage, sx, sz, { knock: 6, pierceIframes: true });
          }
        }
        return b.attackTime > (b.phase >= 3 ? 3.8 : 3.0);
      },
      end: (b, g) => { for (const bm of b.beams) g.beams.release(bm); b.beams.length = 0; },
    },
  ],

  harrower: [
    {
      id: 'sweep', phase: 1, weight: 30, cooldown: 1.9, maxTime: 5.0,
      start: (b, g) => {
        b._atkData.dir = Math.random() < 0.5 ? 1 : -1;
        b._atkData.angle = -1.1 * b._atkData.dir;
        for (let i = 0; i < 2; i++) b.beams.push(g.beams.acquire(0xff3ea5));
        b.playClip('sweep', { fade: 0.12, restart: true });
        g.audio.play('charge', { dur: 1.0 });
      },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const charge = clamp01(b.attackTime / 1.0);
        const live = b.attackTime > 1.0;
        if (live) d.angle += dt * 0.95 * d.dir * (b.phase >= 3 ? 1.4 : 1);
        d.armAngle = d.angle * 0.5;
        if (live && !d.sounded) { d.sounded = true; g.audio.play('beam', { dur: 2.4, gain: 0.85 }); }
        for (let i = 0; i < b.beams.length; i++) {
          const side = i === 0 ? -1 : 1;
          const a = b.yaw + d.angle + side * 0.55;
          const sx = b.x + Math.sin(b.yaw) * -1 + side * Math.cos(b.yaw) * 3.4;
          const sz = b.z + Math.cos(b.yaw) * -1 - side * Math.sin(b.yaw) * 3.4;
          const ex = sx + Math.sin(a) * 60, ez = sz + Math.cos(a) * 60;
          g.beams.set(b.beams[i], sx, 1.5, sz, ex, 1.5, ez, live ? 1.3 : 0.2 + charge * 0.3, live ? 1 : 0.3 + charge * 0.5);
          if (live && p.alive) {
            const dist = g.pointSegmentDistance(p.position.x, p.position.z, sx, sz, ex, ez);
            if (dist < 1.6 + p.radius) g.damagePlayer(18 * g.difficulty.enemyDamage, sx, sz, { knock: 7, pierceIframes: true });
          }
        }
        return b.attackTime > (b.phase >= 3 ? 4.2 : 3.4);
      },
      end: (b, g) => { for (const bm of b.beams) g.beams.release(bm); b.beams.length = 0; b._atkData.armAngle = undefined; },
    },
    {
      id: 'chargeRun', phase: 1, weight: 26, cooldown: 2.0, maxTime: 4.6,
      start: (b, g, p) => {
        const dx = p.position.x - b.x, dz = p.position.z - b.z;
        const d = lengthXZ(dx, dz) || 1;
        b._atkData.dx = dx / d; b._atkData.dz = dz / d;
        b._atkData.telegraph = g.decals.acquire(b.x + dx / d * 22, b.z + dz / d * 22, 4.5, 0xffb347, { fill: 0.5, thickness: 0.16, opacity: 0.85 });
        b.playClip('charge', { fade: 0.14, restart: true });
        g.audio.play('charge', { dur: 0.9 });
      },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        if (b.attackTime < 0.95) {
          const k = clamp01(b.attackTime / 0.95);
          b.yaw += wrapAngle(Math.atan2(d.dx, d.dz) - b.yaw) * clamp01(dt * 6);
          if (d.telegraph) g.decals.set(d.telegraph, b.x + d.dx * 22, b.z + d.dz * 22, 4.5, k, 0.85);
          return false;
        }
        if (d.telegraph) { g.decals.release(d.telegraph); d.telegraph = null; }
        if (!d.launched) { d.launched = true; g.audio.play('dash', { gain: 1 }); g.screen.addTrauma(0.2); }
        const sp = 44;
        b.x += d.dx * sp * dt;
        b.z += d.dz * sp * dt;
        const R = g.world.radius - b.def.radius - 2;
        const dd = lengthXZ(b.x, b.z);
        if (dd > R) {
          b.x = b.x / dd * R; b.z = b.z / dd * R;
          if (!d.bounced) {
            d.bounced = true;
            g.screen.addTrauma(0.5);
            g.world.addRipple(b.x, b.z, 1.5);
            g.explosionAt(b.x, b.z, 9, 16, 1, 0xffb347);
          }
          return true;
        }
        if (p.alive && lengthXZ(p.position.x - b.x, p.position.z - b.z) < b.def.radius + p.radius) {
          g.damagePlayer(26 * g.difficulty.enemyDamage, b.x, b.z, { knock: 30 });
        }
        d.mine = (d.mine || 0) - dt;
        if (b.phase >= 2 && d.mine <= 0) {
          d.mine = 0.22;
          g.projectiles.dropMine(b.x - d.dx * 3, b.z - d.dz * 3, { damage: 20, aoe: 5, life: 9 });
        }
        g.fx.dust(b.x, b.z, 5, 0xffb347, 4);
        return b.attackTime > 2.6;
      },
      end: (b, g) => { if (b._atkData.telegraph) { g.decals.release(b._atkData.telegraph); b._atkData.telegraph = null; } },
    },
    {
      id: 'volley', phase: 1, weight: 22, cooldown: 1.7, maxTime: 3.2,
      start: (b) => { b._atkData.n = 0; b.playClip('volley', { fade: 0.08, restart: true }); },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const shots = b.phase >= 3 ? 5 : 3;
        if (b.attackTime >= d.n * 0.34 && d.n < shots) {
          d.n++;
          b.fireAimed(g, p, 5 + b.phase, 0.85, 27, 10, { homing: b.phase >= 3 ? 0.6 : 0 });
        }
        return d.n >= shots && b.attackTime > shots * 0.34 + 0.25;
      },
    },
    {
      id: 'mines', phase: 2, weight: 18, cooldown: 2.2, maxTime: 2.6,
      start: (b, g, p) => {
        const n = 8;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + Math.random() * 0.3;
          const r = 8 + Math.random() * 16;
          g.projectiles.dropMine(clamp(p.position.x + Math.cos(a) * r, -40, 40), clamp(p.position.z + Math.sin(a) * r, -40, 40), { damage: 22, aoe: 5.4, life: 11 });
        }
        g.audio.play('mortar', { gain: 0.8, pitch: 0.6 });
      },
      run: (b) => b.attackTime > 0.7,
    },
    {
      id: 'summonLancer', phase: 2, weight: 14, cooldown: 2.8, maxTime: 2.0,
      start: (b, g) => {
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * TAU, r = 20 + Math.random() * 12;
          g.spawnEnemyAt(i === 0 ? 'lancer' : 'drone', Math.cos(a) * r, Math.sin(a) * r);
        }
        g.audio.play('rift');
      },
      run: (b) => b.attackTime > 0.6,
    },
  ],

  maw: [
    {
      id: 'slamWave', phase: 1, weight: 28, cooldown: 1.8, maxTime: 4.4,
      start: (b, g) => { b._atkData.rings = 0; b.playClip('open', { fade: 0.1, restart: true }); g.audio.play('charge', { dur: 1.0 }); },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        if (b.attackTime < 0.95) return false;
        if (!d.slammed) {
          d.slammed = true;
          b.playClip('slam', { fade: 0.04, restart: true });
          g.screen.addTrauma(0.85);
          g.screen.stop(0.07);
          g.audio.play('explosion', { size: 1.6 });
          g.world.addRipple(b.x, b.z, 2.4);
        }
        const waves = b.phase >= 3 ? 4 : 3;
        const t = b.attackTime - 0.95;
        if (d.rings < waves && t >= d.rings * 0.38) {
          const r = 9 + d.rings * 8;
          g.rings.spawn(b.x, b.z, { color: 0xff3ea5, from: r * 0.55, to: r, duration: 0.45, thickness: 0.2 });
          const dist = lengthXZ(p.position.x - b.x, p.position.z - b.z);
          if (p.alive && Math.abs(dist - r * 0.8) < 3.4) g.damagePlayer(20 * g.difficulty.enemyDamage, b.x, b.z, { knock: 20 });
          d.rings++;
        }
        return t > waves * 0.38 + 0.4;
      },
      end: (b) => { b.playClip('idle', { fade: 0.25 }); },
    },
    {
      id: 'spikeVolley', phase: 1, weight: 26, cooldown: 1.6, maxTime: 4.0,
      start: (b) => { b._atkData.n = 0; b._atkData.offset = Math.random() * TAU; },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const volleys = b.phase >= 3 ? 6 : 4;
        if (b.attackTime >= d.n * 0.4 && d.n < volleys) {
          d.n++;
          b.fireAimed(g, p, 7, 1.15, 26, 11);
          if (b.phase >= 2) b.fireRadial(g, 8, 17, 9, d.offset + d.n * 0.4, { color: 0xa06bff });
        }
        return d.n >= volleys && b.attackTime > volleys * 0.4 + 0.3;
      },
    },
    {
      id: 'voidZones', phase: 1, weight: 20, cooldown: 2.4, maxTime: 3.0,
      start: (b, g, p) => {
        const n = b.phase >= 3 ? 7 : 5;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * TAU;
          const r = Math.random() * 32;
          b.addHazard(Math.cos(a) * r, Math.sin(a) * r, 6.5, 16, 9);
        }
        g.audio.play('rift', { gain: 0.9 });
        g.screen.addTrauma(0.2);
      },
      run: (b) => b.attackTime > 1.0,
    },
    {
      id: 'devour', phase: 2, weight: 24, cooldown: 2.4, maxTime: 5.0,
      start: (b, g) => { g.audio.play('charge', { dur: 1.4 }); b.playClip('open', { fade: 0.12, restart: true }); },
      run: (b, g, p, dt) => {
        if (b.attackTime > 1.15) b.playClip('devour', { fade: 0.18 });
        if (b.attackTime > 1.2 && p.alive) {
          // vacuum: pulls the player in while the eye is exposed
          const dx = b.x - p.position.x, dz = b.z - p.position.z;
          const d = lengthXZ(dx, dz) || 1;
          const pull = 26 * dt;
          p.velocity.x += dx / d * pull;
          p.velocity.z += dz / d * pull;
          g.fx.glow.spawn({
            x: p.position.x + (Math.random() - 0.5) * 8, y: 1 + Math.random() * 2, z: p.position.z + (Math.random() - 0.5) * 8,
            vx: dx / d * 16, vz: dz / d * 16, color: 0xa06bff, color2: 0xff3ea5,
            size: 0.5, size2: 0, life: 0.5, alpha: 0.8, drag: 0.4,
          });
          if (Math.random() < dt * 6) b.fireAimed(g, p, 3, 0.5, 24, 8, { color: 0xa06bff });
        }
        if (b.attackTime > 3.4) b.playClip('idle', { fade: 0.3 });
        return b.attackTime > 4.0;
      },
      end: (b) => { b.playClip('idle', { fade: 0.25 }); },
    },
    {
      id: 'spawnBrood', phase: 1, weight: 16, cooldown: 2.6, maxTime: 2.4,
      start: (b, g) => {
        const n = b.phase >= 2 ? 5 : 3;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + Math.random();
          const r = 14 + Math.random() * 14;
          g.spawnEnemyAt(i % 3 === 0 ? 'splitter' : 'skitter', Math.cos(a) * r, Math.sin(a) * r);
        }
        g.audio.play('rift');
      },
      run: (b) => b.attackTime > 0.7,
    },
    {
      id: 'eyeSweep', phase: 3, weight: 30, cooldown: 2.2, maxTime: 6.0,
      start: (b, g) => {
        b._atkData.a = b.yaw - 1.4;
        b.beams.push(g.beams.acquire(0xffe36e));
        b.playClip('open', { fade: 0.1, restart: true });
        g.audio.play('charge', { dur: 1.2 });
      },
      run: (b, g, p, dt) => {
        const d = b._atkData;
        const live = b.attackTime > 1.2;
        if (live) d.a += dt * 0.75;
        if (live && !d.sounded) { d.sounded = true; g.audio.play('beam', { dur: 3.0, gain: 0.9 }); }
        const sx = b.x, sz = b.z;
        const ex = b.x + Math.sin(d.a) * 70, ez = b.z + Math.cos(d.a) * 70;
        g.beams.set(b.beams[0], sx, 1.6, sz, ex, 1.6, ez, live ? 2.0 : 0.3, live ? 1 : 0.5);
        if (live && p.alive) {
          const dist = g.pointSegmentDistance(p.position.x, p.position.z, sx, sz, ex, ez);
          if (dist < 2.2 + p.radius) g.damagePlayer(22 * g.difficulty.enemyDamage, sx, sz, { knock: 10, pierceIframes: true });
        }
        return b.attackTime > 4.6;
      },
      end: (b, g) => { for (const bm of b.beams) g.beams.release(bm); b.beams.length = 0; b.playClip('idle', { fade: 0.3 }); },
    },
  ],
};

export { ATTACKS as BOSS_ATTACKS };
