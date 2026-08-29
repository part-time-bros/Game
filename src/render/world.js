/**
 * world.js — the arena: a fractured stabilizer platform adrift in the Void.
 *
 * Everything here is static or shader-animated, so the whole environment costs
 * a handful of draw calls no matter what the fight is doing.
 */
import { TAU, clamp01, lerp, RNG } from '../core/util.js';
import { createFloorMaterial, createSkyMaterial, createNovaMaterial } from './materials.js';
import { noiseTexture } from './textures.js';
import { MeshBuilder, PALETTE, buildRockSpire, buildDeadTree, buildCactus, buildWaterTower } from './models.js';

export const ARENA_RADIUS = 46;

export class World {
  constructor(scene, rng) {
    this.scene = scene;
    this.rng = rng;
    this.radius = ARENA_RADIUS;
    this.obstacles = [];
    this._rippleIndex = 0;
    this.threat = 0;
    this.targetThreat = 0;
    this.coreGlow = 0;
    this.time = 0;

    // ---------- sky ----------
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 20), createSkyMaterial());
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    // ---------- deck ----------
    this.floorMat = createFloorMaterial();
    this.floorMat.uniforms.uRadius.value = this.radius;
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(this.radius + 1.2, 128), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = false;
    scene.add(this.floor);

    // ---------- canyon rim ----------
    // Rock instead of an energy fence: a boundary you can read from any angle
    // and which does not glow. Merged to one draw call.
    this.rimMat = createNovaMaterial({ rim: 0.30, spec: 0.06, rimColor: 0xffb877 });
    this.rim = new THREE.Mesh(this._buildRim(), this.rimMat);
    this.rim.frustumCulled = false;
    scene.add(this.rim);

    // ---------- water tower at the centre ----------
    const tower = buildWaterTower();
    this.towerMat = createNovaMaterial({ rim: 0.35, spec: 0.14, rimColor: 0xffc98a });
    this.stabGroup = new THREE.Group();
    this.towerFrame = new THREE.Mesh(tower.frame, this.towerMat);
    this.towerTank = new THREE.Mesh(tower.tank, this.towerMat);
    this.towerTank.position.y = 7.3;
    this.towerVane = new THREE.Mesh(tower.vane, this.towerMat);
    this.towerVane.position.set(0, 13.4, -1.6);
    this.stabGroup.add(this.towerFrame, this.towerTank, this.towerVane);
    scene.add(this.stabGroup);
    this._stabGeos = [tower.frame, tower.tank, tower.vane];

    // ---------- cover: spires, dead trees, cactus ----------
    this.pillarMat = createNovaMaterial({ rim: 0.28, spec: 0.05, rimColor: 0xffb877 });
    this.pillars = [];
    const layout = [
      [0.30, 24, 'spire'], [1.35, 30, 'spire'], [2.35, 22, 'tree'], [3.35, 31, 'spire'],
      [4.35, 25, 'spire'], [5.35, 30, 'tree'], [0.85, 38, 'spire'], [2.90, 39, 'cactus'],
      [4.95, 38, 'spire'], [1.90, 15, 'cactus'], [3.90, 17, 'tree'], [5.90, 36, 'cactus'],
    ];
    const kinds = {
      spire: [buildRockSpire(0), buildRockSpire(1), buildRockSpire(2)],
      tree: [buildDeadTree(0), buildDeadTree(1)],
      cactus: [buildCactus(0), buildCactus(1)],
    };
    this._pillarGeos = [];
    for (const k in kinds) for (const g of kinds[k]) this._pillarGeos.push(g.geometry);
    layout.forEach(([a, r, kind], i) => {
      const pool = kinds[kind];
      const spec = pool[i % pool.length];
      const m = new THREE.Mesh(spec.geometry, this.pillarMat);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      m.position.set(x, 0, z);
      m.rotation.y = a * 1.7;
      const s = kind === 'spire' ? (i >= 6 ? 0.85 : 1) : 1;
      m.scale.setScalar(s);
      scene.add(m);
      this.pillars.push(m);
      // only rock blocks; you ride straight through a cactus or a dead tree
      if (kind === 'spire') this.obstacles.push({ x, z, r: spec.radius * s * 1.5, height: spec.height * s });
    });
    // the tower's legs are solid
    this.obstacles.push({ x: 0, z: 0, r: 4.4, height: 7, core: true });

    // ---------- parallax debris islands ----------
    this.islands = this._buildIslands();
    scene.add(this.islands);

    // ---------- ground mist ----------
    // Two slow-scrolling noise layers just above the deck. Cheap, but it gives
    // the arena air: ships and shots visibly travel *through* something.
    this.mist = this._buildMist();
    scene.add(this.mist);

    // ---------- ambient motes ----------
    this.motes = this._buildMotes(420);
    scene.add(this.motes);
  }

  /**
   * The canyon that rings the arena. Chunky rock blocks at varied height and
   * radius, plus a low apron of scree so the ground meets the wall instead of
   * ending at a line. One merged geometry, one draw call.
   */
  _buildRim() {
    const b = new MeshBuilder();
    const R = this.radius;
    const rng = new RNG(31337);
    const tones = [PALETTE.rockRed, PALETTE.rockDark, PALETTE.strata, PALETTE.clay, PALETTE.rockLite];

    // Per-block value jitter. Without it the wall reads as a fence of identical
    // flat-shaded boxes; rock is the same hue at a dozen different values.
    const tint = (hex, k) => {
      const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
      const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
      const b = Math.min(255, Math.round((hex & 255) * k));
      return (r << 16) | (g << 8) | b;
    };

    const blocks = 64;
    for (let i = 0; i < blocks; i++) {
      const a = (i / blocks) * TAU;
      const wob = rng.range(-2.4, 2.6);
      const h = rng.range(11, 30);
      const rr = R + 3.0 + wob;
      // stack two or three slabs so the wall has a stepped, eroded profile
      let y = -1.5;
      const slabs = 2 + Math.floor(rng.next() * 2);
      for (let k = 0; k < slabs; k++) {
        const sh = (h / slabs) * rng.range(0.75, 1.25);
        b.add(new THREE.CylinderGeometry(0.5, 0.62, 1, 5), {
          pos: [Math.cos(a) * rr, y + sh / 2, Math.sin(a) * rr],
          rot: [rng.range(-0.06, 0.06), a + rng.range(-0.5, 0.5), rng.range(-0.05, 0.05)],
          scale: [rng.range(8, 15), sh, rng.range(7, 12)],
          color: tint(tones[(i + k) % tones.length], rng.range(0.42, 1.02)),
        });
        y += sh * 0.86;
      }
    }
    // scree apron
    for (let i = 0; i < 90; i++) {
      const a = rng.next() * TAU;
      const rr = R - rng.range(0, 5.5);
      b.add(new THREE.IcosahedronGeometry(0.5, 0), {
        pos: [Math.cos(a) * rr, rng.range(0.1, 0.6), Math.sin(a) * rr],
        rot: [rng.next() * TAU, rng.next() * TAU, rng.next() * TAU],
        scale: rng.range(0.5, 2.4),
        color: tint(rng.next() < 0.5 ? PALETTE.rockDark : PALETTE.strata, rng.range(0.55, 1.0)),
      });
    }
    return b.build('canyon-rim');
  }

  /** Mesas out past the canyon. Flat-topped, hazed, purely for the horizon. */
  _buildIslands() {
    const b = new MeshBuilder();
    const rng = this.rng;
    for (let i = 0; i < 26; i++) {
      const a = rng.next() * TAU;
      const r = rng.range(120, 320);
      const h = rng.range(14, 62);
      const w = rng.range(18, 62);
      b.add(new THREE.CylinderGeometry(0.44, 0.5, 1, 6), {
        pos: [Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r],
        rot: [0, rng.next() * TAU, 0],
        scale: [w, h, w * rng.range(0.6, 1.3)],
        color: i % 3 === 0 ? PALETTE.rockDark : PALETTE.strata,
      });
      // a shoulder of talus so they do not read as cylinders
      b.add(new THREE.CylinderGeometry(0.5, 0.72, 1, 6), {
        pos: [Math.cos(a) * r, -4, Math.sin(a) * r],
        rot: [0, rng.next() * TAU, 0],
        scale: [w * 1.35, h * 0.24, w * 1.2],
        color: PALETTE.rockDark,
      });
    }
    // fog eats most of them, which is the point: depth without detail
    const mesh = new THREE.Mesh(b.build('mesas'), createNovaMaterial({ rim: 0.18, spec: 0.02, fog: 1.0, rimColor: 0xffb877 }));
    mesh.frustumCulled = false;
    this._islandMat = mesh.material;
    return mesh;
  }

  _buildMist() {
    const group = new THREE.Group();
    const geo = new THREE.CircleGeometry(this.radius + 1, 72);
    this._mistGeo = geo;
    this._mistMats = [];
    // Blown dust rather than energy mist: warm, low, and drifting one way.
    const layers = [
      { y: 0.45, scale: 0.026, speed: 0.020, opacity: 0.30, color: 0xb08a5c },
      { y: 1.7, scale: 0.015, speed: 0.012, opacity: 0.16, color: 0x8d6a48 },
    ];
    for (const L of layers) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uNoise: { value: noiseTexture() },
          uColor: { value: new THREE.Color(L.color) },
          uOpacity: { value: L.opacity },
          uScale: { value: L.scale },
          uSpeed: { value: L.speed },
          uRadius: { value: this.radius },
        },
        vertexShader: /* glsl */`
          varying vec3 vWorld;
          void main(){
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */`
          precision highp float;
          uniform float uTime; uniform float uOpacity; uniform float uScale;
          uniform float uSpeed; uniform float uRadius;
          uniform vec3 uColor; uniform sampler2D uNoise;
          varying vec3 vWorld;
          void main(){
            vec2 p = vWorld.xz * uScale;
            float a = texture2D(uNoise, p + vec2(uTime * uSpeed, uTime * uSpeed * 0.6)).r;
            float b = texture2D(uNoise, p * 2.1 - vec2(uTime * uSpeed * 1.7, 0.0)).g;
            float m = smoothstep(0.26, 0.88, a * 0.65 + b * 0.5);
            float edge = 1.0 - smoothstep(uRadius * 0.55, uRadius, length(vWorld.xz));
            float alpha = m * edge * uOpacity;
            if (alpha < 0.004) discard;
            gl_FragColor = vec4(uColor * alpha, alpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = L.y;
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      group.add(mesh);
      this._mistMats.push(mat);
    }
    return group;
  }

  _buildMotes(count) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const a = rng.next() * TAU;
      const r = Math.sqrt(rng.next()) * (this.radius + 14);
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rng.range(0.2, 11);
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = rng.next() * TAU;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 300);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xe6c48f) }, uScale: { value: 300 } },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime; uniform float uScale;
        varying float vA;
        void main(){
          vec3 p = position;
          p.y += sin(uTime * 0.32 + aSeed) * 1.9;
          p.x += cos(uTime * 0.21 + aSeed * 1.7) * 1.6;
          p.z += sin(uTime * 0.17 + aSeed * 2.3) * 1.6;
          vA = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * 1.1 + aSeed * 5.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = max(1.0, 0.10 * uScale / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uColor; varying float vA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d)) * vA * 0.55;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this._moteMat = mat;
    return pts;
  }

  /** Ping the deck shader with an impact ripple. */
  addRipple(x, z, strength = 1) {
    const arr = this.floorMat.uniforms.uRipples.value;
    const v = arr[this._rippleIndex % arr.length];
    v.set(x, z, this.time, strength);
    this._rippleIndex++;
  }

  setThreat(v) { this.targetThreat = clamp01(v); }

  update(dt, playerPos, coreGlow = 0) {
    this.time += dt;
    const u = this.floorMat.uniforms;
    this.threat = lerp(this.threat, this.targetThreat, clamp01(dt * 1.2));
    u.uThreat.value = this.threat;
    u.uCoreGlow.value = coreGlow;
    if (playerPos) u.uPlayerPos.value.copy(playerPos);

    // the windmill turns in gusts, not at a constant rate
    this._vaneSpin = (this._vaneSpin || 0) + dt * (1.6 + Math.sin(this.time * 0.31) * 0.9);
    this.towerVane.rotation.z = this._vaneSpin;
    this.towerTank.position.y = 7.3;

    for (const m of this._mistMats) m.uniforms.uTime.value = this.time;
    this._moteMat.uniforms.uTime.value = this.time;
  }

  /** Reset per-run visual state. */
  reset() {
    this.threat = 0;
    this.targetThreat = 0;
    const arr = this.floorMat.uniforms.uRipples.value;
    for (const v of arr) v.set(0, 0, -99, 0);
  }

  setMoteScale(px) { this._moteMat.uniforms.uScale.value = px; }

  /** Mist is overdraw-only; the low quality tier does without it. */
  setMistEnabled(on) { this.mist.visible = !!on; }

  dispose() {
    this.sky.geometry.dispose(); this.sky.material.dispose();
    this.floor.geometry.dispose(); this.floorMat.dispose();
    this.rim.geometry.dispose(); this.rimMat.dispose();
    this._stabGeos.forEach((g) => g.dispose());
    this._pillarGeos.forEach((g) => g.dispose());
    this.towerMat.dispose(); this.pillarMat.dispose();
    this.islands.geometry.dispose(); this._islandMat.dispose();
    this.motes.geometry.dispose(); this._moteMat.dispose();
    this._mistGeo.dispose();
    this._mistMats.forEach((m) => m.dispose());
  }
}
