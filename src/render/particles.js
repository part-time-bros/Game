/**
 * particles.js — data-oriented GPU particles.
 *
 * All particles of a blend mode live in ONE THREE.Points object backed by typed
 * arrays: emitting costs no allocation, updating is a flat loop, and the whole
 * system draws in a single call. Dead particles are swap-removed so the draw
 * range stays compact.
 */
import { clamp01, TAU } from '../core/util.js';
import { createParticleMaterial } from './materials.js';
import { glowSprite, smokeSprite, shardSprite } from './textures.js';

export class ParticleSystem {
  constructor(scene, capacity, texture, blending = THREE.AdditiveBlending) {
    this.capacity = capacity;
    this.count = 0;

    this.px = new Float32Array(capacity * 3);   // position
    this.vx = new Float32Array(capacity * 3);   // velocity
    this.cs = new Float32Array(capacity * 3);   // colour start
    this.ce = new Float32Array(capacity * 3);   // colour end
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);      // 1 = bounce on deck

    this.geometry = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.aSize = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    this.aAlpha.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.aPos);
    this.geometry.setAttribute('aColor', this.aCol);
    this.geometry.setAttribute('aSize', this.aSize);
    this.geometry.setAttribute('aAlpha', this.aAlpha);
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    this.material = createParticleMaterial(texture);
    this.material.blending = blending;
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    this._c = new THREE.Color();
    this.budget = 1;              // scaled by quality tier
  }

  clear() { this.count = 0; this.geometry.setDrawRange(0, 0); }

  /**
   * spawn({ x,y,z, vx,vy,vz, color, color2, size, size2, life, alpha, drag, gravity, bounce })
   * Silently drops the particle when the pool is full — never grows mid-frame.
   */
  spawn(o) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const i3 = i * 3;
    this.px[i3] = o.x; this.px[i3 + 1] = o.y; this.px[i3 + 2] = o.z;
    this.vx[i3] = o.vx || 0; this.vx[i3 + 1] = o.vy || 0; this.vx[i3 + 2] = o.vz || 0;
    const c = this._c.set(o.color === undefined ? 0xffffff : o.color);
    this.cs[i3] = c.r; this.cs[i3 + 1] = c.g; this.cs[i3 + 2] = c.b;
    const c2 = this._c.set(o.color2 === undefined ? (o.color === undefined ? 0xffffff : o.color) : o.color2);
    this.ce[i3] = c2.r; this.ce[i3 + 1] = c2.g; this.ce[i3 + 2] = c2.b;
    const life = o.life === undefined ? 0.6 : o.life;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = o.size === undefined ? 1 : o.size;
    this.size1[i] = o.size2 === undefined ? 0 : o.size2;
    this.alpha0[i] = o.alpha === undefined ? 1 : o.alpha;
    this.drag[i] = o.drag === undefined ? 2.2 : o.drag;
    this.grav[i] = o.gravity === undefined ? 0 : o.gravity;
    this.flags[i] = o.bounce ? 1 : 0;
    return true;
  }

  update(dt) {
    const n = this.count;
    const pos = this.aPos.array, col = this.aCol.array, sz = this.aSize.array, al = this.aAlpha.array;
    let write = 0;
    for (let i = 0; i < n; i++) {
      let l = this.life[i] - dt;
      if (l <= 0) continue;
      const i3 = i * 3;
      // integrate
      let vx = this.vx[i3], vy = this.vx[i3 + 1], vz = this.vx[i3 + 2];
      vy -= this.grav[i] * dt;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      vx *= d; vy *= d; vz *= d;
      let x = this.px[i3] + vx * dt;
      let y = this.px[i3 + 1] + vy * dt;
      let z = this.px[i3 + 2] + vz * dt;
      if (this.flags[i] === 1 && y < 0.08) { y = 0.08; vy = Math.abs(vy) * 0.42; vx *= 0.7; vz *= 0.7; }

      const w = write;
      const w3 = w * 3;
      // compact in place (swap-down): survivors move to the front of the arrays
      this.px[w3] = x; this.px[w3 + 1] = y; this.px[w3 + 2] = z;
      this.vx[w3] = vx; this.vx[w3 + 1] = vy; this.vx[w3 + 2] = vz;
      if (w !== i) {
        this.cs[w3] = this.cs[i3]; this.cs[w3 + 1] = this.cs[i3 + 1]; this.cs[w3 + 2] = this.cs[i3 + 2];
        this.ce[w3] = this.ce[i3]; this.ce[w3 + 1] = this.ce[i3 + 1]; this.ce[w3 + 2] = this.ce[i3 + 2];
        this.maxLife[w] = this.maxLife[i];
        this.size0[w] = this.size0[i]; this.size1[w] = this.size1[i];
        this.alpha0[w] = this.alpha0[i];
        this.drag[w] = this.drag[i]; this.grav[w] = this.grav[i]; this.flags[w] = this.flags[i];
      }
      this.life[w] = l;

      const t = 1 - l / this.maxLife[w];        // 0 at birth -> 1 at death
      pos[w3] = x; pos[w3 + 1] = y; pos[w3 + 2] = z;
      col[w3] = this.cs[w3] + (this.ce[w3] - this.cs[w3]) * t;
      col[w3 + 1] = this.cs[w3 + 1] + (this.ce[w3 + 1] - this.cs[w3 + 1]) * t;
      col[w3 + 2] = this.cs[w3 + 2] + (this.ce[w3 + 2] - this.cs[w3 + 2]) * t;
      sz[w] = this.size0[w] + (this.size1[w] - this.size0[w]) * t;
      // quick fade-in then long fade-out reads better than linear
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      al[w] = this.alpha0[w] * clamp01(fade);
      write++;
    }
    this.count = write;
    this.geometry.setDrawRange(0, write);
    if (write > 0) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aAlpha.needsUpdate = true;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    if (this.points.parent) this.points.parent.remove(this.points);
  }
}

/**
 * FX facade — gameplay code calls these named effects, never the raw system.
 * Every count is multiplied by the quality budget so low-end devices thin out
 * automatically without changing call sites.
 */
export class ParticleFX {
  constructor(scene, rng) {
    this.rng = rng;
    this.glow = new ParticleSystem(scene, 3600, glowSprite(128), THREE.AdditiveBlending);
    this.smoke = new ParticleSystem(scene, 900, smokeSprite(128), THREE.NormalBlending);
    this.shard = new ParticleSystem(scene, 700, shardSprite(64), THREE.AdditiveBlending);
    this.systems = [this.glow, this.smoke, this.shard];
    this.budget = 1;
  }

  setBudget(v) { this.budget = v; }
  clear() { for (const s of this.systems) s.clear(); }
  update(dt) { for (const s of this.systems) s.update(dt); }
  get count() { return this.glow.count + this.smoke.count + this.shard.count; }

  _n(count) { return Math.max(1, Math.round(count * this.budget)); }

  /** Muzzle flash: a hot core plus a short cone of sparks along the shot. */
  muzzle(x, y, z, dx, dz, color, scale = 1) {
    const r = this.rng;
    this.glow.spawn({ x, y, z, color: 0xffffff, color2: color, size: 2.4 * scale, size2: 0.2, life: 0.09, alpha: 1, drag: 6 });
    const n = this._n(4 * scale);
    for (let i = 0; i < n; i++) {
      const spread = 0.34;
      const a = Math.atan2(dz, dx) + r.range(-spread, spread);
      const sp = r.range(6, 20) * scale;
      this.glow.spawn({
        x, y: y + r.range(-0.1, 0.1), z,
        vx: Math.cos(a) * sp, vy: r.range(-1.4, 1.4), vz: Math.sin(a) * sp,
        color: 0xffffff, color2: color, size: r.range(0.35, 0.7) * scale, size2: 0,
        life: r.range(0.08, 0.2), alpha: 0.95, drag: 5.5,
      });
    }
  }

  /** Impact spark fan, oriented away from the surface it hit. */
  hit(x, y, z, dx, dz, color, scale = 1) {
    const r = this.rng;
    const n = this._n(7 * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dz, dx) + r.range(-1.5, 1.5);
      const sp = r.range(3, 16) * scale;
      this.glow.spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: r.range(1, 7) * scale, vz: Math.sin(a) * sp,
        color: 0xffffff, color2: color, size: r.range(0.3, 0.62) * scale, size2: 0,
        life: r.range(0.16, 0.42), alpha: 1, drag: 3.4, gravity: 11, bounce: true,
      });
    }
    this.glow.spawn({ x, y, z, color: 0xffffff, color2: color, size: 2.6 * scale, size2: 0.2, life: 0.13, alpha: 0.95, drag: 7 });
  }

  /** Full destruction: flash, fireball, sparks, smoke and rising embers. */
  explode(x, y, z, radius = 1, colorA = 0xffd08a, colorB = 0xff3ea5) {
    const r = this.rng;
    this.glow.spawn({ x, y, z, color: 0xffffff, color2: colorA, size: 8 * radius, size2: 1, life: 0.19, alpha: 1, drag: 5 });
    const n = this._n(16 * radius);
    for (let i = 0; i < n; i++) {
      const a = r.next() * TAU;
      const el = r.range(-0.35, 1.0);
      const sp = r.range(5, 24) * radius;
      this.glow.spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: el * sp * 0.6, vz: Math.sin(a) * sp,
        color: colorA, color2: colorB, size: r.range(0.5, 1.5) * radius, size2: 0.05,
        life: r.range(0.28, 0.72), alpha: 1, drag: 2.6, gravity: 6, bounce: true,
      });
    }
    const ns = this._n(6 * radius);
    for (let i = 0; i < ns; i++) {
      const a = r.next() * TAU;
      const sp = r.range(1.5, 6) * radius;
      this.smoke.spawn({
        x, y: y + r.range(-0.3, 0.8), z,
        vx: Math.cos(a) * sp, vy: r.range(1.4, 4.2), vz: Math.sin(a) * sp,
        color: 0x50406e, color2: 0x0d0a18, size: r.range(2.4, 4.6) * radius, size2: 7 * radius,
        life: r.range(0.7, 1.5), alpha: 0.42, drag: 1.5,
      });
    }
    const nd = this._n(7 * radius);
    for (let i = 0; i < nd; i++) {
      const a = r.next() * TAU;
      const sp = r.range(4, 18) * radius;
      this.shard.spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: r.range(3, 13), vz: Math.sin(a) * sp,
        color: colorB, color2: 0x40204a, size: r.range(0.5, 1.1) * radius, size2: 0.1,
        life: r.range(0.5, 1.2), alpha: 1, drag: 1.1, gravity: 22, bounce: true,
      });
    }
  }

  /** Continuous engine plume — call each frame with dt-scaled rate. */
  thruster(x, y, z, dx, dy, dz, color, rate, dt, speed = 6) {
    const r = this.rng;
    let n = rate * dt * this.budget;
    let count = Math.floor(n);
    if (r.next() < n - count) count++;
    for (let i = 0; i < count; i++) {
      this.glow.spawn({
        x: x + r.range(-0.12, 0.12), y: y + r.range(-0.08, 0.08), z: z + r.range(-0.12, 0.12),
        vx: dx * speed + r.range(-1.2, 1.2), vy: dy * speed + r.range(-0.6, 0.6), vz: dz * speed + r.range(-1.2, 1.2),
        color: 0xffffff, color2: color, size: r.range(0.4, 0.85), size2: 0.05,
        life: r.range(0.14, 0.3), alpha: 0.8, drag: 4.5,
      });
    }
  }

  /** Ribbon of light left behind a dash. */
  dashTrail(x, y, z, color) {
    const r = this.rng;
    const n = this._n(3);
    for (let i = 0; i < n; i++) {
      this.glow.spawn({
        x: x + r.range(-0.5, 0.5), y: y + r.range(-0.25, 0.45), z: z + r.range(-0.5, 0.5),
        vx: r.range(-1.2, 1.2), vy: r.range(0.4, 2.2), vz: r.range(-1.2, 1.2),
        color: 0xffffff, color2: color, size: r.range(0.8, 1.7), size2: 0.1,
        life: r.range(0.22, 0.5), alpha: 0.85, drag: 3,
      });
    }
  }

  /** Swirling column that marks an opening spawn rift. */
  rift(x, z, radius, color, dt, intensity = 1) {
    const r = this.rng;
    let n = 34 * dt * intensity * this.budget;
    let count = Math.floor(n);
    if (r.next() < n - count) count++;
    for (let i = 0; i < count; i++) {
      const a = r.next() * TAU;
      const rr = radius * r.range(0.35, 1.05);
      this.glow.spawn({
        x: x + Math.cos(a) * rr, y: r.range(0.05, 0.5), z: z + Math.sin(a) * rr,
        vx: -Math.sin(a) * 3.2 - Math.cos(a) * 1.2, vy: r.range(1.5, 6.5), vz: Math.cos(a) * 3.2 - Math.sin(a) * 1.2,
        color, color2: 0x2a0f4a, size: r.range(0.35, 0.9), size2: 0.05,
        life: r.range(0.4, 0.9), alpha: 0.9, drag: 1.2,
      });
    }
  }

  /** Pickup vacuum sparkle. */
  sparkle(x, y, z, color, count = 5) {
    const r = this.rng;
    const n = this._n(count);
    for (let i = 0; i < n; i++) {
      const a = r.next() * TAU;
      this.glow.spawn({
        x, y, z,
        vx: Math.cos(a) * r.range(1, 5), vy: r.range(1, 5), vz: Math.sin(a) * r.range(1, 5),
        color: 0xffffff, color2: color, size: r.range(0.3, 0.7), size2: 0,
        life: r.range(0.2, 0.5), alpha: 1, drag: 3.5,
      });
    }
  }

  /** Ground dust ring — used by heavy landings and charge attacks. */
  dust(x, z, radius, color, count = 10) {
    const r = this.rng;
    const n = this._n(count);
    for (let i = 0; i < n; i++) {
      const a = r.next() * TAU;
      this.smoke.spawn({
        x: x + Math.cos(a) * radius * 0.5, y: 0.1, z: z + Math.sin(a) * radius * 0.5,
        vx: Math.cos(a) * r.range(3, 9), vy: r.range(0.3, 1.6), vz: Math.sin(a) * r.range(3, 9),
        color: 0x3d3358, color2: 0x0b0a16, size: r.range(1.6, 3.2), size2: 5.5,
        life: r.range(0.5, 1.0), alpha: 0.34, drag: 2.6,
      });
    }
  }

  /** Thin vertical energy column (heals, buffs, boss phase changes). */
  column(x, z, color, height = 8, count = 18) {
    const r = this.rng;
    const n = this._n(count);
    for (let i = 0; i < n; i++) {
      const a = r.next() * TAU;
      const rr = r.range(0.2, 1.6);
      this.glow.spawn({
        x: x + Math.cos(a) * rr, y: r.range(0, 1), z: z + Math.sin(a) * rr,
        vx: -Math.cos(a) * 0.6, vy: r.range(4, 1 + height), vz: -Math.sin(a) * 0.6,
        color: 0xffffff, color2: color, size: r.range(0.4, 1.0), size2: 0.05,
        life: r.range(0.5, 1.1), alpha: 0.9, drag: 0.8,
      });
    }
  }

  dispose() { for (const s of this.systems) s.dispose(); }
}
