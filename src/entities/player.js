/**
 * player.js — the Nova Lance itself.
 *
 * Feel targets: instant response to stick/keys, a dash that reads as a commit,
 * a pulse that clears space, and an overdrive that changes the music of a fight.
 * Every number here is derived from chassis base stats + installed modules via
 * recompute(), so the loadout can change mid-run without special cases.
 */
import { clamp, clamp01, damp, dampAngle, lengthXZ, lerp, moveToward, TAU, wrapAngle } from '../core/util.js';
import { createNovaMaterial, createEnergyMaterial, createRingMaterial } from '../render/materials.js';
import { buildGuardian, PALETTE } from '../render/models.js';
import { buildRiggedShip } from '../render/rig-models.js';
import { Pose, Animator } from '../render/rig.js';
import { baseStats, MODULES } from '../systems/upgrades.js';
import { SHIPS } from '../systems/ships.js';

const HOVER_Y = 1.05;

export class Player {
  constructor(scene, game) {
    this.game = game;
    this.scene = scene;
    this.position = new THREE.Vector3(0, HOVER_Y, 18);
    this.velocity = new THREE.Vector3();
    this.aimPoint = new THREE.Vector3(0, HOVER_Y, 0);
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.radius = 1.0;
    this.yaw = Math.PI;
    this.alive = true;

    this.group = new THREE.Group();
    this.meshes = {};
    this._shipGeos = {};
    // Each chassis gets its own rig instance and material: the bone uniform is
    // per-material, so they cannot share one.
    for (const id of Object.keys(SHIPS)) {
      const spec = buildRiggedShip(id);
      this._shipGeos[id] = spec.geometry;
      const pose = new Pose(spec.skeleton);
      const mat = createNovaMaterial({ pose, rim: 0.85, spec: 0.6, rimColor: 0x8ff0ff });
      const m = new THREE.Mesh(spec.geometry, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes[id] = { mesh: m, glow: spec.glow, pose, mat, animator: new Animator(pose, spec.clips) };
    }
    this.body = null;
    this.hullMat = this.meshes.striker.mat;
    this.animator = this.meshes.striker.animator;

    this.shieldMat = createEnergyMaterial({ color: 0x46e6ff, opacity: 0.0, power: 3.6, pulse: 0.1 });
    this.shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(2.05, 20, 14), this.shieldMat);
    this.group.add(this.shieldMesh);

    this.auraMat = createEnergyMaterial({ color: 0xffc24a, opacity: 0, power: 1.6 });
    this.auraMesh = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 8, 26), this.auraMat);
    this.auraMesh.rotation.x = -Math.PI / 2;
    this.auraMesh.scale.setScalar(6);
    this.auraMesh.visible = false;
    this.group.add(this.auraMesh);

    // Ground ring: the single biggest readability win for a small ship on a
    // busy deck — it says "you are here" without cluttering the HUD.
    this.ringMat = createRingMaterial({ color: 0x46e6ff, thickness: 0.055 });
    this.groundRing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ringMat);
    this.groundRing.rotation.x = -Math.PI / 2;
    this.groundRing.scale.set(5.6, 5.6, 1);
    this.groundRing.renderOrder = 3;
    this.groundRing.frustumCulled = false;
    scene.add(this.groundRing);

    scene.add(this.group);

    // guardian drones (module)
    const gspec = buildGuardian();
    this._guardianGeo = gspec.geometry;
    this.guardianMat = createNovaMaterial({ rim: 0.8, spec: 0.4 });
    this.guardians = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(gspec.geometry, this.guardianMat);
      m.visible = false;
      scene.add(m);
      this.guardians.push({ mesh: m, angle: (i / 3) * TAU, fireTimer: 0.4 * i });
    }

    this.modules = new Map();
    this.reset('striker', 1);
  }

  // ------------------------------------------------------------------
  reset(shipId, hpScale = 1) {
    this.shipId = SHIPS[shipId] ? shipId : 'striker';
    this.ship = SHIPS[this.shipId];
    this.hpScale = hpScale;
    this.modules.clear();
    for (const k in this.meshes) this.meshes[k].mesh.visible = false;
    const entry = this.meshes[this.shipId];
    entry.mesh.visible = true;
    this.body = entry.mesh;
    this.glowColor = entry.glow;
    this.hullMat = entry.mat;
    this.animator = entry.animator;
    this.animator.reset();
    this.animState = '';
    this.recoil = 0;
    this.hullMat.uniforms.uRimColor.value.set(entry.glow);
    this.shieldMat.uniforms.uColor.value.set(entry.glow);
    this.ringMat.uniforms.uColor.value.set(entry.glow);

    this.recompute();
    this.hull = this.stats.maxHull;
    this.shield = this.stats.maxShield;
    this.energy = this.stats.maxEnergy;
    this.dashCharge = this.stats.dashCharges;
    this.dashRecharge = 0;

    this.position.set(0, HOVER_Y, 20);
    this.velocity.set(0, 0, 0);
    this.yaw = Math.PI;
    this.alive = true;
    this.fireTimer = 0;
    this.pulseTimer = 0;
    this.dashTimer = 0;
    this.invulnTimer = 0;
    this.hitCooldown = 0;
    this.shieldTimer = 0;
    this.overdrive = 0;
    this.overdriveActive = 0;
    this.bank = 0;
    this.pitch = 0;
    this.bob = 0;
    this.muzzleSide = 1;
    this.dashHits = new Set();
    this.god = false;
    this.kills = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.group.visible = true;
    this.groundRing.visible = true;
    this.group.position.copy(this.position);
    this.group.rotation.set(0, this.yaw, 0);
    this.shieldMat.uniforms.uOpacity.value = 0;
    this.auraMesh.visible = false;
    this._syncGuardians(0, true);
  }

  /** Rebuild derived stats from chassis + module stacks. */
  recompute() {
    const s = baseStats(this.ship);
    for (const [id, n] of this.modules) {
      const mod = MODULES[id];
      if (mod && mod.apply) mod.apply(s, n);
    }
    s.maxHull = Math.round(s.maxHull * this.hpScale);
    s.maxShield = Math.round(s.maxShield * this.hpScale);
    this.stats = s;
    if (this.hull !== undefined) {
      this.hull = Math.min(this.hull, s.maxHull);
      this.shield = Math.min(this.shield, s.maxShield);
      this.energy = Math.min(this.energy, s.maxEnergy);
      this.dashCharge = Math.min(this.dashCharge, s.dashCharges);
    }
  }

  addModule(id) {
    const mod = MODULES[id];
    if (!mod) return false;
    const n = (this.modules.get(id) || 0) + 1;
    if (n > mod.max) return false;
    this.modules.set(id, n);
    const prevMaxHull = this.stats.maxHull;
    this.recompute();
    if (this.stats.maxHull > prevMaxHull) this.hull += this.stats.maxHull - prevMaxHull;
    if (mod.onTake) mod.onTake(this);
    return true;
  }

  get speed() { return lengthXZ(this.velocity.x, this.velocity.z); }
  get invulnerable() { return this.invulnTimer > 0 || this.dashTimer > 0 || !this.alive; }
  get hullPct() { return clamp01(this.hull / this.stats.maxHull); }
  get shieldPct() { return this.stats.maxShield > 0 ? clamp01(this.shield / this.stats.maxShield) : 0; }
  get energyPct() { return clamp01(this.energy / this.stats.maxEnergy); }
  get overdrivePct() { return clamp01(this.overdrive / 100); }

  // ------------------------------------------------------------------
  update(dt, input, aimWorld) {
    const g = this.game;
    const s = this.stats;
    if (!this.alive) { this._updateVisual(dt, true); return; }

    // ---------- aim ----------
    if (aimWorld) {
      this.aimPoint.copy(aimWorld);
      const dx = this.aimPoint.x - this.position.x;
      const dz = this.aimPoint.z - this.position.z;
      const d = lengthXZ(dx, dz);
      if (d > 0.4) this.aimDir.set(dx / d, 0, dz / d);
    }
    const targetYaw = Math.atan2(this.aimDir.x, this.aimDir.z);
    this.yaw = dampAngle(this.yaw, targetYaw, 0.000004, dt);

    // ---------- movement ----------
    const mx = input.move.x, mz = input.move.z;
    const moving = mx !== 0 || mz !== 0;
    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      g.fx.dashTrail(this.position.x, this.position.y, this.position.z, this.glowColor);
      if (s.afterburn > 0) this._afterburnTick(dt);
      if (this.dashTimer <= 0) {
        this.invulnTimer = Math.max(this.invulnTimer, 0.09);
        this.velocity.multiplyScalar(0.55);
        g.screen.targetTimeScale = 1;
      }
    } else {
      const speedCap = s.moveSpeed * (this.overdriveActive > 0 ? 1.12 : 1);
      const tx = mx * speedCap, tz = mz * speedCap;
      const accel = moving ? s.accel : s.accel * 0.85;
      this.velocity.x = moveToward(this.velocity.x, tx, accel * dt);
      this.velocity.z = moveToward(this.velocity.z, tz, accel * dt);
      if (!moving) {
        const d = Math.max(0, 1 - s.drag * dt);
        this.velocity.x *= d; this.velocity.z *= d;
      }
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this._collide(dt);

    // ---------- resources ----------
    this.energy = Math.min(s.maxEnergy, this.energy + s.energyRegen * dt * (this.overdriveActive > 0 ? 3 : 1));
    if (this.dashCharge < s.dashCharges) {
      this.dashRecharge += dt;
      const cd = s.dashCooldown * (this.overdriveActive > 0 ? 0.55 : 1);
      while (this.dashRecharge >= cd && this.dashCharge < s.dashCharges) {
        this.dashRecharge -= cd;
        this.dashCharge++;
        g.audio.play('shieldUp', { gain: 0.16, pitch: 1.4 });
      }
    } else this.dashRecharge = 0;

    this.shieldTimer = Math.max(0, this.shieldTimer - dt);
    if (this.shieldTimer <= 0 && this.shield < s.maxShield) {
      const before = this.shield;
      this.shield = Math.min(s.maxShield, this.shield + s.shieldRegen * dt);
      if (before <= 0.01 && this.shield > 0.01) g.audio.play('shieldUp', { gain: 0.4 });
    }
    if (s.regen > 0 && this.hull < s.maxHull) this.hull = Math.min(s.maxHull, this.hull + s.regen * dt);

    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.pulseTimer = Math.max(0, this.pulseTimer - dt);
    this.fireTimer -= dt;

    // ---------- overdrive ----------
    if (this.overdriveActive > 0) {
      this.overdriveActive -= dt;
      this.overdrive = clamp(100 * (this.overdriveActive / s.overdriveDuration), 0, 100);
      this._overdriveAura(dt);
      if (this.overdriveActive <= 0) {
        this.overdrive = 0;
        g.audio.play('overdriveEnd');
        g.ui.setOverdrive(false);
        this.auraMesh.visible = false;
      }
    }

    // ---------- actions ----------
    if (input.dashEdge) this.dash(input);
    if (input.pulseEdge) this.pulse();
    if (input.overdriveEdge) this.tryOverdrive();
    if (input.fireHeld && this.fireTimer <= 0) this.fire();

    this._updateGuardians(dt);
    this._updateVisual(dt, false);
  }

  _collide(dt) {
    const g = this.game;
    const R = g.world.radius - this.radius - 0.6;
    const d2 = this.position.x * this.position.x + this.position.z * this.position.z;
    if (d2 > R * R) {
      const d = Math.sqrt(d2) || 1;
      const nx = this.position.x / d, nz = this.position.z / d;
      this.position.x = nx * R; this.position.z = nz * R;
      const dot = this.velocity.x * nx + this.velocity.z * nz;
      if (dot > 0) {
        this.velocity.x -= dot * nx * 1.25;
        this.velocity.z -= dot * nz * 1.25;
        if (dot > 12) {
          g.audio.play('barrier', { gain: clamp01(dot / 40) });
          g.world.addRipple(nx * g.world.radius, nz * g.world.radius, 0.7);
          g.screen.addTrauma(0.06);
        }
      }
      if (this.dashTimer > 0) this.dashTimer = Math.min(this.dashTimer, 0.03);
    }
    for (const ob of g.world.obstacles) {
      const dx = this.position.x - ob.x, dz = this.position.z - ob.z;
      const rr = ob.r + this.radius;
      const dd = dx * dx + dz * dz;
      if (dd < rr * rr && dd > 0.0001) {
        const d = Math.sqrt(dd);
        const nx = dx / d, nz = dz / d;
        this.position.x = ob.x + nx * rr;
        this.position.z = ob.z + nz * rr;
        const dot = this.velocity.x * nx + this.velocity.z * nz;
        if (dot < 0) { this.velocity.x -= dot * nx; this.velocity.z -= dot * nz; }
        if (this.dashTimer > 0) this.dashTimer = Math.min(this.dashTimer, 0.03);
      }
    }
  }

  // ------------------------------------------------------------------
  fire() {
    const g = this.game, s = this.stats;
    const od = this.overdriveActive > 0;
    const rate = s.fireRate * (od ? 1.6 : 1);
    this.fireTimer = 1 / rate;

    const speedFactor = clamp01(this.speed / s.moveSpeed);
    const dmgMult = (1 + s.momentum * speedFactor) * (od ? 1.3 : 1);
    const n = Math.max(1, Math.round(s.projectiles));
    const baseAngle = Math.atan2(this.aimDir.x, this.aimDir.z);
    const spreadTotal = s.spread * (n - 1) * 2.2;

    const nose = 1.55;
    const side = this.muzzleSide * 0.42;
    this.muzzleSide *= -1;
    const px = this.position.x + this.aimDir.x * nose + this.aimDir.z * side;
    const pz = this.position.z + this.aimDir.z * nose - this.aimDir.x * side;

    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1)) - 0.5;
      const a = baseAngle + t * spreadTotal + (Math.random() - 0.5) * s.spread;
      const dx = Math.sin(a), dz = Math.cos(a);
      const crit = Math.random() < s.critChance;
      const dmg = s.damage * dmgMult * (crit ? s.critMult : 1);
      g.projectiles.firePlayer(px, pz, dx, dz, {
        speed: s.projectileSpeed, damage: dmg, crit,
        pierce: s.pierce, bounce: s.ricochet, homing: s.homing,
        chill: s.chill, chain: s.chainCount,
        color: od ? 0xffc24a : this.glowColor,
        scale: od ? 1.25 : 1,
        y: HOVER_Y,
      });
    }
    this.shotsFired += n;

    this.recoil = 1;
    g.fx.muzzle(px, HOVER_Y, pz, this.aimDir.x, this.aimDir.z, od ? 0xffc24a : this.glowColor, od ? 1.3 : 1);
    g.audio.play('shoot', { gain: 0.85, pitch: od ? 1.18 : 1 });
    this.velocity.x -= this.aimDir.x * 1.1;
    this.velocity.z -= this.aimDir.z * 1.1;
    g.screen.addTrauma(0.012);
  }

  dash(input) {
    const g = this.game, s = this.stats;
    if (this.dashTimer > 0 || this.dashCharge <= 0) {
      if (this.dashCharge <= 0) g.audio.play('uiDeny', { gain: 0.35 });
      return;
    }
    this.dashCharge--;
    this.dashTimer = s.dashTime;
    this.dashHits.clear();
    let dx = input.move.x, dz = input.move.z;
    if (dx === 0 && dz === 0) { dx = this.aimDir.x; dz = this.aimDir.z; }
    const l = lengthXZ(dx, dz) || 1;
    this.velocity.set(dx / l * s.dashSpeed, 0, dz / l * s.dashSpeed);
    g.audio.play('dash');
    g.screen.radial = 1.0;
    g.screen.punchFov(0.5);
    g.screen.addTrauma(0.10);
    g.rings.spawn(this.position.x, this.position.z, {
      color: this.glowColor, from: 1.2, to: 5.2, duration: 0.34, thickness: 0.3,
    });
    if (s.slowmoOnDash > 0) {
      g.screen.targetTimeScale = s.slowmoOnDash;
      g.slowmoTimer = 0.34;
    }
  }

  _afterburnTick(dt) {
    const g = this.game;
    const list = g.enemies.query(this.position.x, this.position.z, 2.6);
    for (const e of list) {
      if (this.dashHits.has(e.id)) continue;
      this.dashHits.add(e.id);
      g.damageEnemy(e, this.stats.afterburn, { x: e.x, z: e.z, dx: this.velocity.x, dz: this.velocity.z, source: 'afterburn', knock: 6 });
    }
    g.fx.glow.spawn({
      x: this.position.x, y: 0.4, z: this.position.z,
      color: 0xffc24a, color2: 0xff3ea5, size: 2.4, size2: 0.2, life: 0.3, alpha: 0.7, drag: 2,
    });
  }

  pulse() {
    const g = this.game, s = this.stats;
    if (this.pulseTimer > 0) return;
    const cost = this.overdriveActive > 0 ? 0 : s.pulseCost;
    if (this.energy < cost) { g.audio.play('pulseFail'); g.ui.flashEnergy(); return; }
    this.energy -= cost;
    this.pulseTimer = s.pulseCooldown;

    const R = s.pulseRadius;
    const hits = g.enemies.query(this.position.x, this.position.z, R);
    let hitCount = 0;
    for (const e of hits) {
      const d = lengthXZ(e.x - this.position.x, e.z - this.position.z);
      const falloff = 1 - 0.45 * clamp01(d / R);
      g.damageEnemy(e, s.pulseDamage * falloff, {
        x: e.x, z: e.z, dx: e.x - this.position.x, dz: e.z - this.position.z,
        source: 'pulse', knock: 26 * falloff, chill: s.chill,
      });
      hitCount++;
    }
    // pulse also scrubs incoming fire — the panic button that actually saves you
    let cleared = 0;
    g.projectiles.enemy.each((b) => {
      if (lengthXZ(b.x - this.position.x, b.z - this.position.z) < R) {
        g.fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, 0x9fe8ff, 0.5);
        g.projectiles.enemy.release(b);
        cleared++;
      }
    });
    if (s.pulseSiphon > 0 && hitCount > 0) {
      this.shield = Math.min(s.maxShield, this.shield + s.pulseSiphon * hitCount);
      g.ui.floatText(this.position, `+${Math.round(s.pulseSiphon * hitCount)} SHIELD`, 'heal');
    }
    g.rings.spawn(this.position.x, this.position.z, { color: this.glowColor, from: 1, to: R, duration: 0.42, thickness: 0.22, fill: 0.5 });
    g.rings.spawn(this.position.x, this.position.z, { color: 0xffffff, from: 0.6, to: R * 0.7, duration: 0.26, thickness: 0.4 });
    g.fx.dust(this.position.x, this.position.z, R * 0.8, 0x8fd8ff, 14);
    g.world.addRipple(this.position.x, this.position.z, 1.2);
    g.screen.addTrauma(0.28);
    g.screen.punchFov(0.35);
    g.screen.aberration = 0.004;
    g.audio.play('pulse');
    if (hitCount + cleared > 0) g.screen.stop(0.035);
  }

  tryOverdrive() {
    const g = this.game, s = this.stats;
    if (this.overdriveActive > 0) return;
    if (this.overdrive < 100) { g.audio.play('uiDeny', { gain: 0.4 }); g.ui.flashOverdrive(); return; }
    this.overdriveActive = s.overdriveDuration;
    this.auraMesh.visible = true;
    g.audio.play('overdrive');
    g.screen.addTrauma(0.35);
    g.screen.punchFov(0.7);
    g.screen.addFlash(0xffc24a, 0.42);
    g.rings.spawn(this.position.x, this.position.z, { color: 0xffc24a, from: 1, to: 18, duration: 0.7, thickness: 0.14 });
    g.ui.setOverdrive(true);
    g.ui.banner('OVERDRIVE', '', 'danger');
    g.audio.setIntensity(1);
  }

  gainOverdrive(amount) {
    if (this.overdriveActive > 0) return;
    const was = this.overdrive;
    this.overdrive = clamp(this.overdrive + amount * this.stats.overdriveGain, 0, 100);
    if (was < 100 && this.overdrive >= 100) {
      this.game.audio.play('shieldUp', { gain: 0.7, pitch: 1.6 });
      this.game.ui.overdriveReady();
    }
  }

  _overdriveAura(dt) {
    const g = this.game;
    this._auraTick = (this._auraTick || 0) + dt;
    this.auraMesh.scale.setScalar(6 + Math.sin(g.time * 8) * 0.4);
    if (this._auraTick >= 0.2) {
      this._auraTick = 0;
      const list = g.enemies.query(this.position.x, this.position.z, 6.5);
      for (const e of list) {
        g.damageEnemy(e, 7, { x: e.x, z: e.z, dx: e.x - this.position.x, dz: e.z - this.position.z, source: 'aura', knock: 2, silent: true });
      }
    }
    g.fx.glow.spawn({
      x: this.position.x + (Math.random() - 0.5) * 5, y: 0.3 + Math.random(), z: this.position.z + (Math.random() - 0.5) * 5,
      color: 0xffc24a, color2: 0xff3ea5, size: 0.7, size2: 0, life: 0.4, alpha: 0.8, drag: 1.6, gravity: -3,
    });
  }

  // ------------------------------------------------------------------
  damage(amount, fromX, fromZ, opts = {}) {
    const g = this.game;
    if (!this.alive || this.god || this.invulnerable || this.hitCooldown > 0) return 0;
    const s = this.stats;
    let dmg = amount * (1 - s.damageReduction);
    this.damageTaken += dmg;
    this.hitCooldown = opts.pierceIframes ? 0.12 : 0.34;
    this.invulnTimer = Math.max(this.invulnTimer, opts.pierceIframes ? 0.05 : 0.22);
    this.shieldTimer = s.shieldDelay;

    let shieldBroke = false;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      if (this.shield <= 0.01) shieldBroke = true;
      g.audio.play(shieldBroke ? 'shieldBreak' : 'shieldHit');
      this.shieldMat.uniforms.uOpacity.value = 1.0;
    }
    if (dmg > 0) {
      this.hull -= dmg;
      g.audio.play('hurt');
    }

    if (fromX !== undefined) {
      const dx = this.position.x - fromX, dz = this.position.z - fromZ;
      const d = lengthXZ(dx, dz) || 1;
      const k = opts.knock === undefined ? 13 : opts.knock;
      this.velocity.x += dx / d * k;
      this.velocity.z += dz / d * k;
    }

    const severity = clamp01(amount / 30);
    g.screen.addTrauma(0.20 + severity * 0.3);
    g.screen.aberration = 0.005 + severity * 0.006;
    g.screen.stop(0.045);
    g.ui.damageFlash(severity);
    g.ui.floatText(this.position, `-${Math.round(amount)}`, 'dmg-taken');
    this.rumble(0.35 + severity * 0.5, 140);

    if (this.hull <= 0) { this.hull = 0; this.die(); }
    return amount;
  }

  heal(n) {
    const before = this.hull;
    this.hull = Math.min(this.stats.maxHull, this.hull + n);
    const gained = this.hull - before;
    if (gained > 0.5) {
      this.game.ui.floatText(this.position, `+${Math.round(gained)}`, 'heal');
      this.game.audio.play('heal');
    }
    return gained;
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    const g = this.game;
    g.fx.explode(this.position.x, this.position.y, this.position.z, 2.4, 0xffffff, this.glowColor);
    g.fx.explode(this.position.x, this.position.y + 0.6, this.position.z, 1.6, 0xffc24a, 0xff3ea5);
    for (let i = 0; i < 12; i++) g.debris.spawn(this.position.x, this.position.y, this.position.z, { speed: 14, scale: 0.9, life: 2.4 });
    g.rings.spawn(this.position.x, this.position.z, { color: this.glowColor, from: 1, to: 22, duration: 0.9, thickness: 0.1 });
    g.screen.addTrauma(1);
    g.screen.addFlash(0xffffff, 0.5);
    g.screen.stop(0.28);
    g.world.addRipple(this.position.x, this.position.z, 1.6);
    g.audio.play('explosion', { size: 1.5 });
    this.group.visible = false;
    this.groundRing.visible = false;
    for (const gu of this.guardians) gu.mesh.visible = false;
    this.rumble(1, 500);
    g.onPlayerDeath();
  }

  rumble(strength, ms) {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (p && p.vibrationActuator && p.vibrationActuator.playEffect) {
          p.vibrationActuator.playEffect('dual-rumble', {
            duration: ms, strongMagnitude: clamp01(strength), weakMagnitude: clamp01(strength * 0.6),
          }).catch(() => {});
        }
      }
    } catch (e) { /* gamepad haptics are best-effort */ }
  }

  // ------------------------------------------------------------------
  _updateGuardians(dt) {
    const g = this.game, s = this.stats;
    const n = Math.min(this.guardians.length, s.guardians);
    for (let i = 0; i < this.guardians.length; i++) {
      const gu = this.guardians[i];
      if (i >= n) { gu.mesh.visible = false; continue; }
      gu.mesh.visible = true;
      gu.angle += dt * 1.25;
      const spread = (i / n) * TAU;
      const r = 3.6;
      const x = this.position.x + Math.cos(gu.angle + spread) * r;
      const z = this.position.z + Math.sin(gu.angle + spread) * r;
      gu.mesh.position.set(x, HOVER_Y + 0.9 + Math.sin(g.time * 3 + i) * 0.2, z);
      gu.mesh.rotation.y += dt * 2.2;
      gu.fireTimer -= dt;
      if (gu.fireTimer <= 0) {
        const target = g.enemies.nearestTo(x, z, 26, null);
        if (target) {
          gu.fireTimer = 0.85;
          const dx = target.x - x, dz = target.z - z;
          const d = lengthXZ(dx, dz) || 1;
          g.projectiles.firePlayer(x, z, dx / d, dz / d, {
            speed: 62, damage: s.damage * 0.5, y: gu.mesh.position.y,
            color: 0x9fe8ff, scale: 0.75, chain: 0,
          });
          g.fx.muzzle(x, gu.mesh.position.y, z, dx / d, dz / d, 0x9fe8ff, 0.6);
          g.audio.play('shoot', { gain: 0.32, pitch: 1.45 });
        } else gu.fireTimer = 0.25;
      }
    }
  }

  _syncGuardians(dt, force) { this._updateGuardians(force ? 0 : dt); }

  /** Map flight state onto ship clips, then layer the weapon recoil. */
  _driveAnim(dt) {
    const a = this.animator;
    if (!a) return;
    const set = (name, opts) => {
      if (this.animState === name) return;
      this.animState = name;
      a.play(name, opts);
    };
    if (this.dashTimer > 0) set('dash', { fade: 0.05 });
    else if (this.overdriveActive > 0) set('overdrive', { fade: 0.2 });
    else if (this.speed > this.stats.moveSpeed * 0.25) set('cruise', { fade: 0.22 });
    else set('idle', { fade: 0.3 });

    this.recoil = Math.max(0, this.recoil - dt * 7);
    if (this.recoil > 0) {
      a.offsetPos('nose', 0, 0, this.recoil * 0.3);
      a.offsetRot('hull', -this.recoil * 0.05, 0, 0);
    }
    // bank the wings with lateral motion for a bit of extra life
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const lateral = clamp((this.velocity.x * fwdZ - this.velocity.z * fwdX) * 0.012, -0.3, 0.3);
    a.offsetRot('wingL', 0, 0, -lateral);
    a.offsetRot('wingR', 0, 0, -lateral);
    a.update(dt);
  }

  _updateVisual(dt, dead) {
    if (dead) return;
    const g = this.game;
    this._driveAnim(dt);
    this.bob += dt;
    const bobY = Math.sin(this.bob * 2.6) * 0.07;
    this.group.position.set(this.position.x, this.position.y + bobY, this.position.z);

    // bank into lateral motion, pitch with forward accel
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const rightX = fwdZ, rightZ = -fwdX;
    const lateral = this.velocity.x * rightX + this.velocity.z * rightZ;
    const forward = this.velocity.x * fwdX + this.velocity.z * fwdZ;
    this.bank = damp(this.bank, clamp(-lateral * 0.028, -0.55, 0.55), 0.0004, dt);
    this.pitch = damp(this.pitch, clamp(-forward * 0.010, -0.3, 0.3), 0.0004, dt);
    this.group.rotation.set(this.pitch, this.yaw, this.bank);

    this.groundRing.position.set(this.position.x, 0.045, this.position.z);
    const ringPulse = 5.5 + Math.sin(this.bob * 2.2) * 0.16 + (this.dashTimer > 0 ? 1.6 : 0);
    this.groundRing.scale.set(ringPulse, ringPulse, 1);
    this.ringMat.uniforms.uOpacity.value = this.overdriveActive > 0 ? 0.55 : 0.30;
    if (this.overdriveActive > 0) this.ringMat.uniforms.uColor.value.set(0xffc24a);
    else this.ringMat.uniforms.uColor.value.set(this.glowColor);

    const dashing = this.dashTimer > 0;
    const scale = dashing ? 1.14 : 1;
    this.group.scale.setScalar(damp(this.group.scale.x, scale, 0.0001, dt));

    // engine plume
    const rate = 26 + this.speed * 2.4 + (dashing ? 120 : 0);
    const ex = this.position.x - fwdX * 1.5, ez = this.position.z - fwdZ * 1.5;
    g.fx.thruster(ex, this.position.y + bobY, ez, -fwdX, 0.05, -fwdZ, this.overdriveActive > 0 ? 0xffc24a : this.glowColor, rate, dt, dashing ? 16 : 7);

    // shield bubble
    const sm = this.shieldMat.uniforms.uOpacity;
    const target = this.shield > 0.5 ? 0.05 + this.shieldPct * 0.09 : 0;
    sm.value = damp(sm.value, target, 0.0006, dt);
    this.shieldMesh.visible = sm.value > 0.005;
    this.shieldMat.uniforms.uColor.value.lerp(
      this._tmpColor || (this._tmpColor = new THREE.Color()).set(this.glowColor), 0);

    // hit flash + invulnerability shimmer
    const flashU = this.hullMat.uniforms.uFlash;
    flashU.value = damp(flashU.value, 0, 0.00005, dt);
    if (this.invulnTimer > 0 && this.dashTimer <= 0) {
      this.body.visible = Math.sin(g.time * 42) > -0.35;
    } else if (this.body) this.body.visible = true;

    this.auraMat.uniforms.uOpacity.value = this.overdriveActive > 0 ? 0.85 : 0;
  }

  dispose() {
    for (const id in this._shipGeos) this._shipGeos[id].dispose();
    for (const id in this.meshes) this.meshes[id].mat.dispose();
    this.shieldMesh.geometry.dispose();
    this.shieldMat.dispose();
    this.groundRing.geometry.dispose();
    this.ringMat.dispose();
    if (this.groundRing.parent) this.groundRing.parent.remove(this.groundRing);
    this.auraMesh.geometry.dispose();
    this.auraMat.dispose();
    this._guardianGeo.dispose();
    this.guardianMat.dispose();
    for (const gu of this.guardians) if (gu.mesh.parent) gu.mesh.parent.remove(gu.mesh);
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
