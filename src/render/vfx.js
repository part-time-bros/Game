/**
 * vfx.js — mesh-based effects (rings, beams, telegraphs, debris, blob shadows)
 * and the screen-feedback controller that drives shake, hit-stop and the
 * composite pass's grade.
 */
import { Pool, clamp, clamp01, easeOutCubic, TAU, lerp } from '../core/util.js';
import { createRingMaterial, createEnergyMaterial, createNovaMaterial, createBeamMaterial } from './materials.js';
import { shadowSprite, scorchTexture } from './textures.js';
import { buildDebris } from './models.js';

const FLAT = -Math.PI / 2;

/** Expanding rings: explosions, pulses, spawn pops, boss slams. */
export class RingFX {
  constructor(scene, capacity = 28) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.geo = geo;
    this.pool = new Pool((i) => {
      const mat = createRingMaterial({ color: 0x46e6ff });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = FLAT;
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { mesh, mat, t: 0, dur: 1, r0: 1, r1: 8, tilt: false, y: 0.06, fade: 1 };
    }, capacity, (it) => { it.mesh.visible = false; });
  }

  spawn(x, z, opts = {}) {
    const it = this.pool.acquire();
    if (!it) return null;
    it.t = 0;
    it.dur = opts.duration || 0.5;
    it.r0 = opts.from !== undefined ? opts.from : 0.6;
    it.r1 = opts.to !== undefined ? opts.to : 8;
    it.y = opts.y !== undefined ? opts.y : 0.08;
    it.fade = opts.opacity !== undefined ? opts.opacity : 1;
    it.mat.uniforms.uColor.value.set(opts.color === undefined ? 0x46e6ff : opts.color);
    it.mat.uniforms.uThickness.value = opts.thickness === undefined ? 0.16 : opts.thickness;
    it.mat.uniforms.uFill.value = opts.fill || 0;
    it.mat.uniforms.uOpacity.value = it.fade;
    it.mat.uniforms.uDashes.value = opts.dashes || 0;
    it.mat.uniforms.uProgress.value = 0;
    it.mesh.position.set(x, it.y, z);
    it.mesh.scale.set(it.r0 * 2, it.r0 * 2, 1);
    it.mesh.rotation.x = FLAT;
    it.mesh.rotation.z = opts.spin ? Math.random() * TAU : 0;
    it.mesh.visible = true;
    return it;
  }

  update(dt) {
    this.pool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { this.pool.release(it); return; }
      const e = easeOutCubic(k);
      const r = lerp(it.r0, it.r1, e);
      it.mesh.scale.set(r * 2, r * 2, 1);
      it.mat.uniforms.uOpacity.value = it.fade * (1 - k * k);
    });
  }

  clear() { this.pool.releaseAll(); }
  dispose() {
    this.pool.items.forEach((it) => { it.mat.dispose(); if (it.mesh.parent) it.mesh.parent.remove(it.mesh); });
    this.geo.dispose();
  }
}

/**
 * Persistent ground telegraphs. Gameplay owns the handle and updates radius /
 * fill progress, which is how every "danger is about to happen here" read works.
 */
export class DecalFX {
  constructor(scene, capacity = 40) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.geo = geo;
    this.pool = new Pool(() => {
      const mat = createRingMaterial({ color: 0xd9702c, thickness: 0.10, fill: 1 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = FLAT;
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { mesh, mat };
    }, capacity, (it) => { it.mesh.visible = false; });
  }

  acquire(x, z, radius, color, opts = {}) {
    const it = this.pool.acquire();
    if (!it) return null;
    it.mesh.position.set(x, opts.y !== undefined ? opts.y : 0.05, z);
    it.mesh.scale.set(radius * 2, radius * 2, 1);
    it.mat.uniforms.uColor.value.set(color);
    it.mat.uniforms.uOpacity.value = opts.opacity !== undefined ? opts.opacity : 1;
    it.mat.uniforms.uFill.value = opts.fill !== undefined ? opts.fill : 1;
    it.mat.uniforms.uThickness.value = opts.thickness !== undefined ? opts.thickness : 0.1;
    it.mat.uniforms.uProgress.value = opts.progress !== undefined ? opts.progress : 0;
    it.mat.uniforms.uDashes.value = opts.dashes || 0;
    it.mesh.visible = true;
    return it;
  }

  set(it, x, z, radius, progress, opacity) {
    if (!it) return;
    it.mesh.position.x = x; it.mesh.position.z = z;
    it.mesh.scale.set(radius * 2, radius * 2, 1);
    if (progress !== undefined) it.mat.uniforms.uProgress.value = progress;
    if (opacity !== undefined) it.mat.uniforms.uOpacity.value = opacity;
  }

  release(it) { if (it) this.pool.release(it); }
  clear() { this.pool.releaseAll(); }
  dispose() {
    this.pool.items.forEach((it) => { it.mat.dispose(); if (it.mesh.parent) it.mesh.parent.remove(it.mesh); });
    this.geo.dispose();
  }
}

/** Crossed-quad energy beams (sentinel lasers, boss sweeps). */
export class BeamFX {
  constructor(scene, capacity = 10) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.geo = geo;
    this.pool = new Pool(() => {
      const mat = createBeamMaterial(0xd9702c);
      const g = new THREE.Group();
      const a = new THREE.Mesh(geo, mat);
      const b = new THREE.Mesh(geo, mat);
      b.rotation.x = Math.PI / 2;
      g.add(a, b);
      g.visible = false;
      g.renderOrder = 5;
      a.frustumCulled = false; b.frustumCulled = false;
      scene.add(g);
      return { group: g, mat, a, b };
    }, capacity, (it) => { it.group.visible = false; });
    this._v = new THREE.Vector3();
  }

  acquire(color) {
    const it = this.pool.acquire();
    if (!it) return null;
    it.mat.uniforms.uColor.value.set(color);
    it.mat.uniforms.uOpacity.value = 1;
    it.group.visible = true;
    return it;
  }

  /** Point the beam from (x0,y0,z0) toward (x1,y1,z1) with a given width. */
  set(it, x0, y0, z0, x1, y1, z1, width, opacity) {
    if (!it) return;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    it.group.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    it.group.rotation.set(0, Math.atan2(dx, dz), 0);
    it.group.rotateX(Math.asin(clamp(dy / len, -1, 1)) * -1);
    it.a.scale.set(len, width, 1);
    it.b.scale.set(len, width, 1);
    it.a.rotation.z = 0;
    // planes are built in XY; rotate so X spans the beam length
    it.group.children[0].rotation.set(0, Math.PI / 2, 0);
    it.group.children[1].rotation.set(Math.PI / 2, Math.PI / 2, 0);
    it.mat.uniforms.uOpacity.value = opacity === undefined ? 1 : opacity;
  }

  release(it) { if (it) this.pool.release(it); }
  clear() { this.pool.releaseAll(); }
  dispose() {
    this.pool.items.forEach((it) => { it.mat.dispose(); if (it.group.parent) it.group.parent.remove(it.group); });
    this.geo.dispose();
  }
}

/** Physical debris chunks thrown by kills and destructible props. */
export class DebrisFX {
  constructor(scene, capacity = 40) {
    this.geos = [buildDebris(1).geometry, buildDebris(7).geometry, buildDebris(13).geometry];
    // per-chunk material so wreckage can carry the colour of whatever it came from
    this.pool = new Pool((i) => {
      const mat = createNovaMaterial({ rim: 0.5, spec: 0.2 });
      const mesh = new THREE.Mesh(this.geos[i % this.geos.length], mat);
      mesh.userData.mat = mat;
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, mat, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, life: 0, maxLife: 1, scale: 1 };
    }, capacity, (it) => { it.mesh.visible = false; });
  }

  spawn(x, y, z, opts = {}) {
    const it = this.pool.acquire();
    if (!it) return null;
    const sp = opts.speed || 8;
    it.vx = (Math.random() - 0.5) * sp;
    it.vy = Math.random() * sp * 0.8 + 2;
    it.vz = (Math.random() - 0.5) * sp;
    it.sx = (Math.random() - 0.5) * 14;
    it.sy = (Math.random() - 0.5) * 14;
    it.sz = (Math.random() - 0.5) * 14;
    it.life = it.maxLife = opts.life || 1.6;
    it.scale = opts.scale || 1;
    it.mesh.position.set(x, y, z);
    it.mesh.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
    it.mesh.scale.setScalar(it.scale);
    it.mat.uniforms.uTint.value.set(opts.tint === undefined ? 0xffffff : opts.tint);
    it.mat.uniforms.uEmitScale.value = opts.tint === undefined ? 1 : 1.5;
    it.mesh.visible = true;
    return it;
  }

  update(dt) {
    this.pool.each((it) => {
      it.life -= dt;
      if (it.life <= 0) { this.pool.release(it); return; }
      it.vy -= 34 * dt;
      const p = it.mesh.position;
      p.x += it.vx * dt; p.y += it.vy * dt; p.z += it.vz * dt;
      if (p.y < 0.16) { p.y = 0.16; it.vy = Math.abs(it.vy) * 0.34; it.vx *= 0.72; it.vz *= 0.72; it.sx *= 0.6; it.sz *= 0.6; }
      it.mesh.rotation.x += it.sx * dt;
      it.mesh.rotation.y += it.sy * dt;
      it.mesh.rotation.z += it.sz * dt;
      const k = clamp01(it.life / it.maxLife);
      it.mesh.scale.setScalar(it.scale * (0.35 + k * 0.65));
    });
  }

  clear() { this.pool.releaseAll(); }
  dispose() {
    this.pool.items.forEach((it) => { it.mat.dispose(); if (it.mesh.parent) it.mesh.parent.remove(it.mesh); });
    this.geos.forEach((g) => g.dispose());
  }
}

/**
 * Persistent burn marks. The deck remembers where things died for a while,
 * which makes a long fight feel like it happened somewhere.
 */
export class ScorchFX {
  constructor(scene, capacity = 34) {
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.tex = scorchTexture();
    this.capacity = capacity;
    this.items = [];
    this.next = 0;
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex, transparent: true, depthWrite: false, opacity: 0,
        blending: THREE.NormalBlending, toneMapped: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.rotation.x = FLAT;
      mesh.position.y = 0.035;
      mesh.visible = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
      this.items.push({ mesh, mat, life: 0, maxLife: 1, peak: 0.55 });
    }
  }

  add(x, z, radius, color = 0xffffff, life = 9) {
    // oldest slot is recycled: a busy deck should stay smudged, not stack up
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.capacity;
    it.life = it.maxLife = life;
    it.peak = 0.42 + Math.random() * 0.22;
    it.mesh.position.set(x, 0.035, z);
    it.mesh.rotation.z = Math.random() * TAU;
    it.mesh.scale.set(radius * 2, radius * 2, 1);
    it.mat.color.set(color);
    it.mat.opacity = it.peak;
    it.mesh.visible = true;
    return it;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; it.mat.opacity = 0; continue; }
      const k = it.life / it.maxLife;
      it.mat.opacity = it.peak * (k > 0.75 ? (1 - k) * 4 : k / 0.75);
    }
  }

  clear() { for (const it of this.items) { it.life = 0; it.mesh.visible = false; } }
  dispose() {
    this.items.forEach((it) => { it.mat.dispose(); if (it.mesh.parent) it.mesh.parent.remove(it.mesh); });
    this.geo.dispose();
  }
}

/**
 * Blob shadows for every hovering entity, drawn as one InstancedMesh.
 * Cheaper than a shadow map, and it grounds hovering entities the sun's own
 * shadow map cannot reach.
 */
export class ShadowFX {
  constructor(scene, capacity = 120) {
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    geo.index = plane.index;
    geo.attributes.position = plane.attributes.position;
    geo.attributes.uv = plane.attributes.uv;
    geo.attributes.normal = plane.attributes.normal;
    this._plane = plane;
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aShadow', this.alphaAttr);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uMap: { value: shadowSprite() } },
      vertexShader: /* glsl */`
        attribute float aShadow;
        varying vec2 vUv; varying float vA;
        void main(){
          vUv = uv; vA = aShadow;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uMap; varying vec2 vUv; varying float vA;
        void main(){
          float a = texture2D(uMap, vUv).a * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.02, a);
        }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion().setFromEuler(new THREE.Euler(FLAT, 0, 0));
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.n = 0;
  }

  begin() { this.n = 0; }

  /** Push one shadow for this frame; height fades and shrinks the blob. */
  push(x, y, z, radius, strength = 1) {
    if (this.n >= this.capacity) return;
    const h = clamp01(1 - y / 9);
    const r = radius * (0.72 + h * 0.5);
    this._p.set(x, 0.028, z);
    this._s.set(r * 2, r * 2, 1);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(this.n, this._m);
    this.alphaAttr.array[this.n] = strength * (0.28 + h * 0.72);
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.geometry.instanceCount = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this._plane.dispose();
    this.mesh.material.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}

/**
 * ScreenFX — the "juice" bus. Gameplay pushes trauma/flash/hit-stop here and
 * the camera + composite read it, so feel tuning lives in one place.
 */
export class ScreenFX {
  constructor() {
    this.trauma = 0;          // 0..1, decays; shake = trauma^2
    this.shakeScale = 1;      // player preference
    this.hitStop = 0;         // seconds of frozen sim
    this.timeScale = 1;
    this.targetTimeScale = 1;
    this.flash = 0;
    this.flashColor = new THREE.Color(1, 1, 1);
    this.aberration = 0;
    this.radial = 0;
    this.desaturate = 0;
    this.grain = 1;
    this.fovPunch = 0;
    this._seed = Math.random() * 1000;
  }

  addTrauma(v) { this.trauma = clamp01(this.trauma + v); }
  addFlash(color, amount) { this.flashColor.set(color); this.flash = Math.max(this.flash, amount); }
  stop(seconds) { this.hitStop = Math.max(this.hitStop, seconds); }
  punchFov(v) { this.fovPunch = Math.max(this.fovPunch, v); }

  /** Advance decay curves. Uses unscaled dt so effects resolve during hit-stop. */
  update(dtReal) {
    this.trauma = Math.max(0, this.trauma - dtReal * 1.55);
    this.flash = Math.max(0, this.flash - dtReal * 4.2);
    this.aberration = Math.max(0, this.aberration - dtReal * 3.2);
    this.radial = Math.max(0, this.radial - dtReal * 4.0);
    this.fovPunch = Math.max(0, this.fovPunch - dtReal * 5.5);
    this.desaturate = lerp(this.desaturate, 0, clamp01(dtReal * 3));
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dtReal);
      this.timeScale = 0.02;
    } else {
      this.timeScale = lerp(this.timeScale, this.targetTimeScale, clamp01(dtReal * 9));
    }
  }

  /** Perlin-ish 2D shake offsets from trauma^2 (Squirrel Eiserloh's model). */
  shake(t) {
    const s = this.trauma * this.trauma * this.shakeScale;
    if (s < 0.0005) return { x: 0, y: 0, roll: 0 };
    const n = (o) => Math.sin(t * (13.7 + o * 4.3) + this._seed + o) * Math.sin(t * (7.3 + o * 2.1) + o * 3.1);
    return { x: n(0) * s * 1.5, y: n(1) * s * 1.1, roll: n(2) * s * 0.05 };
  }

  reset() {
    this.trauma = 0; this.hitStop = 0; this.timeScale = 1; this.targetTimeScale = 1;
    this.flash = 0; this.aberration = 0; this.radial = 0; this.desaturate = 0; this.fovPunch = 0;
  }
}
