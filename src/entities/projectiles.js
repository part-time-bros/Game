/**
 * projectiles.js — every bullet, shell and mine in the game.
 *
 * Projectiles are plain objects in typed pools; their meshes are drawn through
 * InstancedMesh so a screen full of tracers still costs one draw call per kind.
 */
import { Pool, TAU, clamp, clamp01, lengthXZ } from '../core/util.js';
import { createNovaMaterial } from '../render/materials.js';
import { buildBolt, buildMortarShell, buildMine, PALETTE } from '../render/models.js';

const FORWARD = new THREE.Vector3(0, 0, 1);

/** Thin wrapper that rewrites an InstancedMesh's matrices each frame. */
export class InstancedPool {
  constructor(scene, geometry, material, capacity) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.capacity = capacity;
    this.n = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._geo = geometry;
    this._mat = material;
  }
  begin() { this.n = 0; }
  write(x, y, z, quat, sx, sy, sz) {
    if (this.n >= this.capacity) return;
    this._p.set(x, y, z);
    this._s.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    this._m.compose(this._p, quat || this._q, this._s);
    this.mesh.setMatrixAt(this.n++, this._m);
  }
  end() {
    this.mesh.count = this.n;
    if (this.n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.dispose();
    this._geo.dispose();
    this._mat.dispose();
  }
}

const newBullet = () => ({
  x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0,
  damage: 0, radius: 0.34, life: 0, maxLife: 1,
  pierce: 0, bounce: 0, homing: 0, crit: false, chill: 0,
  team: 0, kind: 'bolt', color: 0x46e6ff, scale: 1,
  target: null, hitIds: null, trail: 0, arcT: 0, arcTime: 1,
  x0: 0, z0: 0, tx: 0, tz: 0, height: 0, aoe: 0, decal: null, armed: 0, sourceId: 0,
});

export class Projectiles {
  constructor(scene, game) {
    this.game = game;
    this.scene = scene;

    const boltGeo = buildBolt(PALETTE.cyan, 1.0).geometry;
    const eBoltGeo = buildBolt(PALETTE.magenta, 0.85).geometry;
    const shellGeo = buildMortarShell().geometry;
    const mineGeo = buildMine().geometry;
    const mat = () => createNovaMaterial({ rim: 0.2, spec: 0, fog: 0.4 });

    this.playerMesh = new InstancedPool(scene, boltGeo, mat(), 320);
    this.enemyMesh = new InstancedPool(scene, eBoltGeo, mat(), 320);
    this.shellMesh = new InstancedPool(scene, shellGeo, mat(), 48);
    this.mineMesh = new InstancedPool(scene, mineGeo, mat(), 32);

    this.player = new Pool(newBullet, 320);
    this.enemy = new Pool(newBullet, 320);
    this.shells = new Pool(newBullet, 48);
    this.mines = new Pool(newBullet, 32);

    this._q = new THREE.Quaternion();
    this._dir = new THREE.Vector3();
    this._hitIds = new Set();
  }

  clear() {
    this.player.releaseAll();
    this.enemy.releaseAll();
    this.shells.each((s) => { if (s.decal) { this.game.decals.release(s.decal); s.decal = null; } });
    this.shells.releaseAll();
    this.mines.releaseAll();
  }

  get count() { return this.player.count + this.enemy.count + this.shells.count + this.mines.count; }

  // ------------------------------------------------------------------
  //  spawning
  // ------------------------------------------------------------------
  firePlayer(x, z, dx, dz, opts) {
    const b = this.player.acquire();
    if (!b) return null;
    const sp = opts.speed;
    b.x = x; b.y = opts.y === undefined ? 1.05 : opts.y; b.z = z;
    b.vx = dx * sp; b.vy = 0; b.vz = dz * sp;
    b.damage = opts.damage;
    b.radius = opts.radius || 0.42;
    b.life = b.maxLife = opts.life || 1.15;
    b.pierce = opts.pierce || 0;
    b.bounce = opts.bounce || 0;
    b.homing = opts.homing || 0;
    b.crit = !!opts.crit;
    b.chill = opts.chill || 0;
    b.chain = opts.chain || 0;
    b.color = opts.color || PALETTE.cyan;
    b.scale = opts.scale || 1;
    b.team = 0;
    b.trail = 0;
    if (b.hitIds) b.hitIds.clear(); else b.hitIds = new Set();
    return b;
  }

  fireEnemy(x, y, z, dx, dz, opts) {
    const b = this.enemy.acquire();
    if (!b) return null;
    const sp = opts.speed || 26;
    b.x = x; b.y = y; b.z = z;
    b.vx = dx * sp; b.vy = opts.vy || 0; b.vz = dz * sp;
    b.damage = opts.damage || 8;
    b.radius = opts.radius || 0.5;
    b.life = b.maxLife = opts.life || 3.2;
    b.color = opts.color || PALETTE.magenta;
    b.scale = opts.scale || 1;
    b.homing = opts.homing || 0;
    b.team = 1;
    b.trail = 0;
    return b;
  }

  /** Lobbed mortar: flies an arc to a fixed ground point and detonates. */
  fireMortar(x, y, z, tx, tz, opts) {
    const s = this.shells.acquire();
    if (!s) return null;
    s.x = x; s.y = y; s.z = z;
    s.x0 = x; s.z0 = z; s.tx = tx; s.tz = tz;
    s.arcT = 0;
    s.arcTime = opts.time || 1.5;
    s.height = opts.height || 12;
    s.damage = opts.damage || 18;
    s.aoe = opts.aoe || 5.5;
    s.color = opts.color || PALETTE.amber;
    s.scale = opts.scale || 1;
    s.team = 1;
    s.decal = this.game.decals.acquire(tx, tz, s.aoe, 0xffb347, { fill: 1, thickness: 0.09, opacity: 0.85 });
    return s;
  }

  dropMine(x, z, opts) {
    const m = this.mines.acquire();
    if (!m) return null;
    m.x = x; m.y = 0.7; m.z = z;
    m.vx = opts.vx || 0; m.vz = opts.vz || 0;
    m.damage = opts.damage || 22;
    m.aoe = opts.aoe || 5.0;
    m.life = opts.life || 12;
    m.armed = 0.7;
    m.scale = opts.scale || 1;
    m.team = 1;
    return m;
  }

  // ------------------------------------------------------------------
  //  simulation
  // ------------------------------------------------------------------
  update(dt) {
    const game = this.game;
    const R = game.world.radius;
    const fx = game.fx;

    // ---- player bolts ----
    this.player.each((b) => {
      b.life -= dt;
      if (b.life <= 0) { this.player.release(b); return; }

      if (b.homing > 0) {
        const t = game.enemies.nearestTo(b.x, b.z, 20, b.hitIds);
        if (t) {
          const dx = t.x - b.x, dz = t.z - b.z;
          const d = Math.hypot(dx, dz) || 1;
          const sp = Math.hypot(b.vx, b.vz);
          const k = clamp01(b.homing * dt);
          b.vx += (dx / d * sp - b.vx) * k;
          b.vz += (dz / d * sp - b.vz) * k;
          const ns = Math.hypot(b.vx, b.vz) || 1;
          b.vx = b.vx / ns * sp; b.vz = b.vz / ns * sp;
        }
      }

      b.x += b.vx * dt; b.z += b.vz * dt;

      // arena bounds
      if (b.x * b.x + b.z * b.z > (R + 1) * (R + 1)) {
        fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 0.5);
        this.player.release(b); return;
      }
      // static cover
      const ob = game.obstacleAt(b.x, b.z, b.radius);
      if (ob) {
        if (b.bounce > 0) {
          b.bounce--;
          const nx = (b.x - ob.x), nz = (b.z - ob.z);
          const nl = Math.hypot(nx, nz) || 1;
          const dot = (b.vx * nx / nl + b.vz * nz / nl) * 2;
          b.vx -= dot * nx / nl; b.vz -= dot * nz / nl;
          b.x += b.vx * dt * 1.4; b.z += b.vz * dt * 1.4;
          fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 0.5);
          game.audio.play('zap', { gain: 0.4 });
        } else {
          fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 0.6);
          this.player.release(b); return;
        }
      }

      // enemy contact
      const hit = game.enemies.queryFirst(b.x, b.z, b.radius, b.hitIds);
      if (hit) {
        b.hitIds.add(hit.id);
        game.damageEnemy(hit, b.damage, {
          crit: b.crit, x: b.x, z: b.z, dx: b.vx, dz: b.vz,
          chill: b.chill, chain: b.chain, source: 'bolt', knock: 3.4,
        });
        fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 0.85);
        if (b.pierce > 0) {
          b.pierce--;
          b.damage *= 0.86;
        } else if (b.bounce > 0) {
          b.bounce--;
          const next = game.enemies.nearestTo(b.x, b.z, 22, b.hitIds);
          if (next) {
            const dx = next.x - b.x, dz = next.z - b.z;
            const d = Math.hypot(dx, dz) || 1;
            const sp = Math.hypot(b.vx, b.vz);
            b.vx = dx / d * sp; b.vz = dz / d * sp;
            b.damage *= 0.9;
            b.life = Math.max(b.life, 0.5);
          } else { this.player.release(b); return; }
        } else {
          this.player.release(b); return;
        }
      }

      b.trail -= dt;
      if (b.trail <= 0) {
        b.trail = 0.02;
        fx.glow.spawn({
          x: b.x, y: b.y, z: b.z, color: 0xffffff, color2: b.color,
          size: 0.5 * b.scale, size2: 0, life: 0.11, alpha: 0.7, drag: 1,
        });
      }
    });

    // ---- enemy bolts ----
    const p = game.player;
    this.enemy.each((b) => {
      b.life -= dt;
      if (b.life <= 0) { this.enemy.release(b); return; }
      if (b.homing > 0 && p.alive) {
        const dx = p.position.x - b.x, dz = p.position.z - b.z;
        const d = Math.hypot(dx, dz) || 1;
        const sp = Math.hypot(b.vx, b.vz);
        const k = clamp01(b.homing * dt);
        b.vx += (dx / d * sp - b.vx) * k;
        b.vz += (dz / d * sp - b.vz) * k;
        const ns = Math.hypot(b.vx, b.vz) || 1;
        b.vx = b.vx / ns * sp; b.vz = b.vz / ns * sp;
      }
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;

      if (b.x * b.x + b.z * b.z > (R + 1.5) * (R + 1.5)) { this.enemy.release(b); return; }
      if (game.obstacleAt(b.x, b.z, b.radius)) {
        fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 0.5);
        this.enemy.release(b); return;
      }
      if (p.alive && !p.invulnerable) {
        const dx = p.position.x - b.x, dz = p.position.z - b.z;
        const rr = b.radius + p.radius;
        if (dx * dx + dz * dz < rr * rr) {
          game.damagePlayer(b.damage, b.x, b.z);
          fx.hit(b.x, b.y, b.z, -b.vx, -b.vz, b.color, 1.1);
          this.enemy.release(b); return;
        }
      }
      b.trail -= dt;
      if (b.trail <= 0) {
        b.trail = 0.035;
        fx.glow.spawn({ x: b.x, y: b.y, z: b.z, color: b.color, color2: 0x30103a, size: 0.55 * b.scale, size2: 0, life: 0.16, alpha: 0.6, drag: 1 });
      }
    });

    // ---- mortar shells ----
    this.shells.each((s) => {
      s.arcT += dt / s.arcTime;
      const t = clamp01(s.arcT);
      s.x = s.x0 + (s.tx - s.x0) * t;
      s.z = s.z0 + (s.tz - s.z0) * t;
      s.y = 0.8 + Math.sin(t * Math.PI) * s.height;
      if (s.decal) this.game.decals.set(s.decal, s.tx, s.tz, s.aoe, t, 0.5 + t * 0.5);
      if (t >= 1) {
        if (s.decal) { this.game.decals.release(s.decal); s.decal = null; }
        game.explosionAt(s.tx, s.tz, s.aoe, s.damage, 1, 0xffb347);
        this.shells.release(s);
      }
    });

    // ---- mines ----
    this.mines.each((m) => {
      m.life -= dt;
      m.armed = Math.max(0, m.armed - dt);
      m.x += m.vx * dt; m.z += m.vz * dt;
      m.vx *= Math.max(0, 1 - 3 * dt); m.vz *= Math.max(0, 1 - 3 * dt);
      const near = p.alive && lengthXZ(p.position.x - m.x, p.position.z - m.z) < 3.4;
      if (m.life <= 0 || (m.armed <= 0 && near)) {
        game.explosionAt(m.x, m.z, m.aoe, m.damage, 1, 0xff3ea5);
        this.mines.release(m);
      }
    });

    this._sync();
  }

  /** Push simulation state into the instanced meshes. */
  _sync() {
    const q = this._q, dir = this._dir;
    this.playerMesh.begin();
    this.player.each((b) => {
      dir.set(b.vx, 0, b.vz).normalize();
      q.setFromUnitVectors(FORWARD, dir);
      this.playerMesh.write(b.x, b.y, b.z, q, b.scale, b.scale, b.scale * 1.6);
    });
    this.playerMesh.end();

    this.enemyMesh.begin();
    this.enemy.each((b) => {
      dir.set(b.vx, b.vy, b.vz).normalize();
      q.setFromUnitVectors(FORWARD, dir);
      this.enemyMesh.write(b.x, b.y, b.z, q, b.scale, b.scale, b.scale * 1.3);
    });
    this.enemyMesh.end();

    const spin = performance.now() * 0.004;
    this.shellMesh.begin();
    this.shells.each((s) => {
      q.setFromAxisAngle(FORWARD, spin);
      this.shellMesh.write(s.x, s.y, s.z, q, s.scale);
    });
    this.shellMesh.end();

    this.mineMesh.begin();
    this.mines.each((m) => {
      const pulse = m.armed > 0 ? 0.8 : 1 + Math.sin(performance.now() * 0.012) * 0.12;
      this.mineMesh.write(m.x, m.y, m.z, null, m.scale * pulse);
    });
    this.mineMesh.end();
  }

  dispose() {
    this.playerMesh.dispose();
    this.enemyMesh.dispose();
    this.shellMesh.dispose();
    this.mineMesh.dispose();
  }
}
