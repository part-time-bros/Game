/**
 * pickups.js — dropped shards and orbs.
 * They pop out with physics, settle, then get vacuumed in once the player is
 * inside the collection radius, which is what makes clearing a pack feel good.
 */
import { Pool, clamp01, lengthXZ, TAU } from '../core/util.js';
import { createNovaMaterial } from '../render/materials.js';
import { buildShard, buildOrb, PALETTE } from '../render/models.js';

export class Pickups {
  constructor(scene, game) {
    this.game = game;
    const shard = buildShard();
    const heal = buildOrb(PALETTE.lime);
    const energy = buildOrb(PALETTE.violet);
    this.geos = [shard.geometry, heal.geometry, energy.geometry];

    const mk = (geo, tint) => {
      const mat = createNovaMaterial({ rim: 1.0, spec: 0.4, rimColor: tint });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, mat };
    };
    this.shards = new Pool(() => ({ ...mk(shard.geometry, PALETTE.cyan), kind: 'shard' }), 200, (p) => { p.mesh.visible = false; });
    this.healOrbs = new Pool(() => ({ ...mk(heal.geometry, PALETTE.lime), kind: 'heal' }), 24, (p) => { p.mesh.visible = false; });
    this.energyOrbs = new Pool(() => ({ ...mk(energy.geometry, PALETTE.violet), kind: 'energy' }), 24, (p) => { p.mesh.visible = false; });
    this.active = [];
  }

  get count() { return this.active.length; }

  _init(p, x, z, opts) {
    p.x = x; p.y = 0.9; p.z = z;
    const a = Math.random() * TAU;
    const sp = opts.speed === undefined ? 6 : opts.speed;
    p.vx = Math.cos(a) * sp * Math.random();
    p.vz = Math.sin(a) * sp * Math.random();
    p.vy = 5 + Math.random() * 5;
    p.life = opts.life === undefined ? 22 : opts.life;
    p.spin = (Math.random() - 0.5) * 5;
    p.magnet = false;
    p.value = opts.value || 1;
    p.settle = 0;
    p.mesh.position.set(x, p.y, z);
    p.mesh.scale.setScalar(opts.scale || 1);
    p.mesh.visible = true;
    this.active.push(p);
  }

  spawnShards(x, z, count, elite) {
    for (let i = 0; i < count; i++) {
      const p = this.shards.acquire();
      if (!p) return;
      this._init(p, x, z, { value: elite ? 2 : 1, scale: elite ? 1.25 : 1 });
    }
  }

  spawnOrb(x, z, kind) {
    const pool = kind === 'heal' ? this.healOrbs : this.energyOrbs;
    const p = pool.acquire();
    if (!p) return null;
    this._init(p, x, z, { value: 1, scale: 1, life: 26 });
    return p;
  }

  update(dt) {
    const g = this.game;
    const p0 = g.player;
    const magnetR = p0.alive ? p0.stats.magnetRadius : 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;

      if (!p.magnet && p0.alive) {
        const d = lengthXZ(p0.position.x - p.x, p0.position.z - p.z);
        if (d < magnetR) p.magnet = true;
      }

      if (p.magnet && p0.alive) {
        const dx = p0.position.x - p.x, dy = p0.position.y - p.y, dz = p0.position.z - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const pull = 26 + (1 - clamp01(d / 12)) * 40;
        p.vx += dx / d * pull * dt * 4;
        p.vy += dy / d * pull * dt * 4;
        p.vz += dz / d * pull * dt * 4;
        const damp = Math.max(0, 1 - 5 * dt);
        p.vx *= damp; p.vy *= damp; p.vz *= damp;
        if (d < 1.5) { this._collect(p, i); continue; }
      } else {
        p.vy -= 26 * dt;
        const damp = Math.max(0, 1 - 1.6 * dt);
        p.vx *= damp; p.vz *= damp;
      }

      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.75) {
        p.y = 0.75;
        if (p.vy < -1) { p.vy = -p.vy * 0.35; p.vx *= 0.6; p.vz *= 0.6; }
        else p.vy = 0;
      }
      const R = g.world.radius - 1;
      const dd = p.x * p.x + p.z * p.z;
      if (dd > R * R) {
        const d = Math.sqrt(dd);
        p.x = p.x / d * R; p.z = p.z / d * R;
        p.vx *= -0.4; p.vz *= -0.4;
      }

      p.mesh.position.set(p.x, p.y + Math.sin(g.time * 3 + p.x) * 0.12, p.z);
      p.mesh.rotation.y += dt * (2.4 + p.spin);
      p.mesh.rotation.x = Math.sin(g.time * 2 + p.z) * 0.3;

      if (p.life <= 0) { this._despawn(p, i); continue; }
      if (p.life < 3) p.mesh.visible = Math.sin(p.life * 18) > -0.4;
      if (p.magnet && Math.random() < 0.3) {
        g.fx.glow.spawn({
          x: p.x, y: p.y, z: p.z, color: p.kind === 'heal' ? PALETTE.lime : p.kind === 'energy' ? PALETTE.violet : PALETTE.cyan,
          color2: 0x102030, size: 0.4, size2: 0, life: 0.24, alpha: 0.7, drag: 2,
        });
      }
    }
  }

  _collect(p, index) {
    const g = this.game;
    const player = g.player;
    if (p.kind === 'shard') {
      const value = p.value * player.stats.shardValue;
      g.addScore(8 * value, p.x, p.z);
      player.gainOverdrive(2.2 * value);
      g.runStats.shards += p.value;
      g.audio.play('pickup', { gain: 0.5, pitch: 1 + Math.random() * 0.25 });
    } else if (p.kind === 'heal') {
      player.heal(22);
      g.audio.play('heal', { gain: 0.6 });
    } else {
      player.energy = Math.min(player.stats.maxEnergy, player.energy + 45);
      player.gainOverdrive(9);
      g.audio.play('pickup', { gain: 0.7, pitch: 0.75 });
      g.ui.floatText(player.position, '+ENERGY', 'xp');
    }
    g.fx.sparkle(p.x, p.y, p.z, p.kind === 'heal' ? PALETTE.lime : PALETTE.cyan, 6);
    this._despawn(p, index);
  }

  _despawn(p, index) {
    this.active.splice(index, 1);
    this._poolFor(p).release(p);
  }

  _poolFor(p) { return p.kind === 'shard' ? this.shards : p.kind === 'heal' ? this.healOrbs : this.energyOrbs; }

  clear() {
    for (const p of this.active) this._poolFor(p).release(p);
    this.active.length = 0;
  }

  dispose() {
    this.clear();
    const all = this.shards.items.concat(this.healOrbs.items, this.energyOrbs.items);
    all.forEach((p) => { p.mat.dispose(); if (p.mesh.parent) p.mesh.parent.remove(p.mesh); });
    this.geos.forEach((g) => g.dispose());
  }
}
