/**
 * world.js — the arena: a fractured stabilizer platform adrift in the Void.
 *
 * Everything here is static or shader-animated, so the whole environment costs
 * a handful of draw calls no matter what the fight is doing.
 */
import { TAU, clamp01, lerp } from '../core/util.js';
import { createFloorMaterial, createSkyMaterial, createNovaMaterial, createEnergyMaterial } from './materials.js';
import { noiseTexture } from './textures.js';
import { MeshBuilder, PALETTE, buildPillar, buildStabilizer } from './models.js';

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

    // ---------- hull beneath the deck ----------
    this.shellMat = createNovaMaterial({ rim: 0.35, spec: 0.15 });
    this.shell = new THREE.Mesh(this._buildShell(), this.shellMat);
    scene.add(this.shell);

    // ---------- containment barrier ----------
    // A low camera looks along the barrier instead of down through it, and an
    // additive shell seen edge-on stacks into a solid wall. A tighter fresnel
    // keeps it a rim highlight from every angle.
    this.barrierMat = createEnergyMaterial({ color: 0x46e6ff, opacity: 0.30, power: 4.4, pulse: 0.16 });
    this.barrier = new THREE.Mesh(new THREE.CylinderGeometry(this.radius, this.radius, 6.5, 72, 1, true), this.barrierMat);
    this.barrier.position.y = 3.1;
    this.barrier.renderOrder = 7;
    scene.add(this.barrier);

    // ---------- centre stabilizer ----------
    const stab = buildStabilizer();
    this.stabMat = createNovaMaterial({ rim: 0.7, spec: 0.5 });
    this.stabGroup = new THREE.Group();
    this.stabBase = new THREE.Mesh(stab.base, this.stabMat);
    this.stabCrystal = new THREE.Mesh(stab.crystal, this.stabMat);
    this.stabCrystal.position.y = 6.4;
    this.stabRingA = new THREE.Mesh(stab.ring, this.stabMat);
    this.stabRingA.position.y = 6.4;
    this.stabRingB = new THREE.Mesh(stab.ring, this.stabMat);
    this.stabRingB.position.y = 6.4;
    this.stabRingB.rotation.z = Math.PI / 3;
    this.stabGroup.add(this.stabBase, this.stabCrystal, this.stabRingA, this.stabRingB);
    scene.add(this.stabGroup);
    this._stabGeos = [stab.base, stab.crystal, stab.ring];

    // ---------- cover pillars ----------
    this.pillarMat = createNovaMaterial({ rim: 0.5, spec: 0.3 });
    this.pillars = [];
    const layout = [
      [0.30, 24], [1.35, 30], [2.35, 22], [3.35, 31], [4.35, 25], [5.35, 30],
      [0.85, 38], [2.90, 39], [4.95, 38],
    ];
    const pillarGeos = [buildPillar(0), buildPillar(1), buildPillar(2)];
    this._pillarGeos = pillarGeos.map((p) => p.geometry);
    layout.forEach(([a, r], i) => {
      const spec = pillarGeos[i % pillarGeos.length];
      const m = new THREE.Mesh(spec.geometry, this.pillarMat);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      m.position.set(x, 0, z);
      m.rotation.y = a;
      const s = i >= 6 ? 0.8 : 1;
      m.scale.setScalar(s);
      scene.add(m);
      this.pillars.push(m);
      this.obstacles.push({ x, z, r: spec.radius * s * 1.5, height: spec.height * s });
    });
    // the stabilizer itself is solid
    this.obstacles.push({ x: 0, z: 0, r: 6.2, height: 4, core: true });

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

  _buildShell() {
    const b = new MeshBuilder();
    const R = this.radius;
    // rim wall
    b.add(new THREE.CylinderGeometry(R + 1.2, R + 0.6, 2.6, 72, 1, true), { pos: [0, -1.3, 0], color: PALETTE.hullDark, flat: false });
    b.add(new THREE.TorusGeometry(0.5, 0.02, 6, 80), { pos: [0, -0.06, 0], rot: [Math.PI / 2, 0, 0], scale: (R + 1.2) * 2, color: PALETTE.cyan, emit: 2.2, flat: false });
    // tapered underside
    b.add(new THREE.CylinderGeometry(R * 0.98, R * 0.16, 15, 40, 1, true), { pos: [0, -9, 0], color: PALETTE.hullDark, flat: false });
    b.add(new THREE.CylinderGeometry(R * 0.16, 0.4, 7, 20, 1, true), { pos: [0, -19.5, 0], color: 0x0d1122, flat: false });
    // structural spars
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      b.add(new THREE.BoxGeometry(1, 1, 1), {
        pos: [Math.cos(a) * R * 0.55, -7.5, Math.sin(a) * R * 0.55],
        rot: [Math.cos(a) * 0.42, -a, Math.sin(a) * 0.42],
        scale: [1.5, 15, 1.5], color: PALETTE.hullMid,
      });
      b.add(new THREE.BoxGeometry(1, 1, 1), {
        pos: [Math.cos(a) * (R + 0.6), -2.4, Math.sin(a) * (R + 0.6)],
        rot: [0, -a, 0], scale: [1.0, 0.28, 0.28], color: PALETTE.cyan, emit: 2.0,
      });
    }
    // hanging cables / broken struts for silhouette interest
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.4;
      b.add(new THREE.CylinderGeometry(0.16, 0.06, 1, 5), {
        pos: [Math.cos(a) * R * 0.8, -13, Math.sin(a) * R * 0.8],
        rot: [0.2, 0, 0.15], scale: [1, 12, 1], color: PALETTE.hullDark,
      });
    }
    return b.build('arena-shell');
  }

  _buildIslands() {
    const b = new MeshBuilder();
    const rng = this.rng;
    for (let i = 0; i < 22; i++) {
      const a = rng.next() * TAU;
      const r = rng.range(78, 210);
      const y = rng.range(-52, 26);
      const s = rng.range(3.5, 15);
      b.add(new THREE.IcosahedronGeometry(0.5, 0), {
        pos: [Math.cos(a) * r, y, Math.sin(a) * r],
        rot: [rng.next() * TAU, rng.next() * TAU, rng.next() * TAU],
        scale: [s, s * rng.range(0.4, 0.9), s * rng.range(0.7, 1.3)],
        color: i % 4 === 0 ? PALETTE.voidMid : PALETTE.hullDark,
      });
      if (i % 3 === 0) {
        b.add(new THREE.TorusGeometry(0.5, 0.03, 5, 14), {
          pos: [Math.cos(a) * r, y + s * 0.6, Math.sin(a) * r],
          rot: [Math.PI / 2 + rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4)],
          scale: s * 1.7, color: PALETTE.violet, emit: 1.8, flat: false,
        });
      }
    }
    const mesh = new THREE.Mesh(b.build('islands'), createNovaMaterial({ rim: 0.8, spec: 0.1, fog: 0.55 }));
    mesh.frustumCulled = false;
    this._islandMat = mesh.material;
    return mesh;
  }

  _buildMist() {
    const group = new THREE.Group();
    const geo = new THREE.CircleGeometry(this.radius + 1, 72);
    this._mistGeo = geo;
    this._mistMats = [];
    const layers = [
      { y: 0.55, scale: 0.028, speed: 0.012, opacity: 0.22, color: 0x2f6fa8 },
      { y: 1.9, scale: 0.017, speed: -0.008, opacity: 0.13, color: 0x6a4fb0 },
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
      pos[i * 3 + 1] = rng.range(0.4, 26);
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = rng.next() * TAU;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 300);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x6fd6ff) }, uScale: { value: 300 } },
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

    this.stabCrystal.rotation.y += dt * 0.35;
    this.stabCrystal.position.y = 6.4 + Math.sin(this.time * 0.9) * 0.32;
    this.stabRingA.rotation.y += dt * 0.7;
    this.stabRingA.rotation.x = Math.sin(this.time * 0.4) * 0.35;
    this.stabRingB.rotation.y -= dt * 0.5;
    this.stabRingB.rotation.z = Math.PI / 3 + Math.cos(this.time * 0.33) * 0.4;

    this.islands.rotation.y += dt * 0.006;
    for (const m of this._mistMats) m.uniforms.uTime.value = this.time;
    this._moteMat.uniforms.uTime.value = this.time;
    this.barrierMat.uniforms.uOpacity.value = 0.055 + this.threat * 0.075 + Math.sin(this.time * 1.7) * 0.015;
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
    this.shell.geometry.dispose(); this.shellMat.dispose();
    this.barrier.geometry.dispose(); this.barrierMat.dispose();
    this._stabGeos.forEach((g) => g.dispose());
    this._pillarGeos.forEach((g) => g.dispose());
    this.stabMat.dispose(); this.pillarMat.dispose();
    this.islands.geometry.dispose(); this._islandMat.dispose();
    this.motes.geometry.dispose(); this._moteMat.dispose();
    this._mistGeo.dispose();
    this._mistMats.forEach((m) => m.dispose());
  }
}
