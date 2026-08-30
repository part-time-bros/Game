/**
 * world.js — the arena: a fractured stabilizer platform adrift in the Void.
 *
 * Everything here is static or shader-animated, so the whole environment costs
 * a handful of draw calls no matter what the fight is doing.
 */
import { TAU, clamp01, lerp, RNG } from '../core/util.js';
import { createFloorMaterial, createSkyMaterial, createNovaMaterial } from './materials.js';
import { noiseTexture, skyTexture } from './textures.js';
import { buildWaterTower } from './models.js';
import { buildRock, buildGround, buildCanyon, buildMesaBelt, buildBranchTree, buildSaguaro, buildScrub, buildPebble, mergeGeometries } from './terrain.js';

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

    // ---------- sun ----------
    // A real light, not a direction uniform. This is what buys cast shadows,
    // and cast shadows are most of what "golden hour" means.
    this.sun = new THREE.DirectionalLight(0xffd2a1, 1.95);
    this.sun.position.set(-58, 30, -24);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    const sc = this.sun.shadow;
    sc.mapSize.set(2048, 2048);
    // One cascade sized to the arena: the whole playfield is 46 across, so a
    // 64-unit ortho box covers it without the resolution loss of a big frustum.
    sc.camera.left = -64; sc.camera.right = 64;
    sc.camera.top = 64; sc.camera.bottom = -64;
    sc.camera.near = 1; sc.camera.far = 190;
    sc.bias = -0.0008;
    sc.normalBias = 0.06;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Warm bounce from the ground, cool sky from above. The environment map
    // does most of the ambient work, but this keeps shadowed sides from going
    // flat when the tier drops and IBL is off.
    // Deliberately weak. Ambient is what kills contrast: with the environment
    // map carrying the sky, this only needs to stop shadowed sides going black.
    // Dust-hazed golden hour, not a clear blue day: a blue sky term is what
    // was tinting the ground violet everywhere the sun did not reach.
    this.bounce = new THREE.HemisphereLight(0xc4b39c, 0x7a5537, 0.20);
    scene.add(this.bounce);

    // Distance haze. The materials are three's standard now, so fog has to be
    // on the scene — `fog: true` on a material does nothing without it.
    this.fog = new THREE.Fog(0x8a6a4c, 105, 330);
    scene.fog = this.fog;

    // ---------- ground ----------
    // A displaced landform, not a disc. The mesh is authored in world XZ so it
    // needs no rotation; rings are dense where the camera lives and coarsen out
    // to the canyon foot, and the vertex colours carry the large-scale tone
    // that the floor shader then details.
    this.floorMat = createFloorMaterial();
    this.floorMat.uniforms.uRadius.value = this.radius;
    this.floor = new THREE.Mesh(buildGround(this.radius, 150), this.floorMat);
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    // ---------- canyon rim ----------
    // Rock instead of an energy fence: a boundary you can read from any angle
    // and which does not glow. Merged to one draw call.
    this.rimMat = createNovaMaterial({ rim: 0.30, spec: 0.05, rimColor: 0xffb877, bump: 0.24, bumpScale: 0.085 });
    this.rim = new THREE.Mesh(buildCanyon(this.radius, 31337), this.rimMat);
    this.rim.frustumCulled = false;
    this.rim.castShadow = true;
    this.rim.receiveShadow = true;
    scene.add(this.rim);

    // ---------- water tower at the centre ----------
    const tower = buildWaterTower();
    this.towerMat = createNovaMaterial({ rim: 0.30, spec: 0.10, rimColor: 0xffc98a, bump: 0.10, bumpScale: 2.6 });
    this.stabGroup = new THREE.Group();
    this.towerFrame = new THREE.Mesh(tower.frame, this.towerMat);
    this.towerTank = new THREE.Mesh(tower.tank, this.towerMat);
    this.towerTank.position.y = 7.3;
    this.towerVane = new THREE.Mesh(tower.vane, this.towerMat);
    this.towerVane.position.set(0, 13.4, -1.6);
    for (const m of [this.towerFrame, this.towerTank, this.towerVane]) { m.castShadow = true; m.receiveShadow = true; }
    this.stabGroup.add(this.towerFrame, this.towerTank, this.towerVane);
    scene.add(this.stabGroup);
    this._stabGeos = [tower.frame, tower.tank, tower.vane];

    // ---------- cover: spires, dead trees, cactus ----------
    this.pillarMat = createNovaMaterial({ rim: 0.28, spec: 0.05, rimColor: 0xffb877, bump: 0.22, bumpScale: 0.5 });
    this.pillars = [];
    const layout = [
      [0.30, 24, 'spire'], [1.35, 30, 'spire'], [2.35, 22, 'tree'], [3.35, 31, 'spire'],
      [4.35, 25, 'spire'], [5.35, 30, 'tree'], [0.85, 38, 'spire'], [2.90, 39, 'cactus'],
      [4.95, 38, 'spire'], [1.90, 15, 'cactus'], [3.90, 17, 'tree'], [5.90, 36, 'cactus'],
    ];
    const kinds = {
      spire: [this._spire(0), this._spire(1), this._spire(2)],
      tree: [buildBranchTree(0), buildBranchTree(1)],
      cactus: [buildSaguaro(0), buildSaguaro(1)],
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
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      this.pillars.push(m);
      // only rock blocks; you ride straight through a cactus or a dead tree
      if (kind === 'spire') this.obstacles.push({ x, z, r: spec.radius * s * 1.5, height: spec.height * s });
    });
    // the tower's legs are solid
    this.obstacles.push({ x: 0, z: 0, r: 4.4, height: 7, core: true });

    // ---------- distant mesas ----------
    this.islands = this._buildIslands();
    scene.add(this.islands);

    // ---------- scatter: loose stone and dry brush ----------
    // Density is what separates a game arena from an empty plane, and it has to
    // be free: two InstancedMeshes carry ~250 objects for two draw calls.
    this.scatter = this._buildScatter();
    for (const m of this.scatter) scene.add(m);

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
   * A rock spire: one eroded landform, plus a couple of fallen blocks at its
   * foot so it sits in the ground rather than on it.
   */
  _spire(seed) {
    const h = 7.0 + (seed % 3) * 2.6;
    const main = buildRock(seed * 131 + 17, { rough: 0.46, tall: 1.0, wide: 0.72 });
    main.scale(2.7, h * 0.62, 2.7);
    main.translate(0, h * 0.42, 0);
    const parts = [main];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + seed;
      const r = 2.2 + (i * 0.7);
      const g = buildRock(seed * 71 + i * 13, { detail: 2, rough: 0.55, tall: 0.7 });
      const sc = 0.8 + (i % 2) * 0.55;
      g.scale(sc * 1.3, sc * 0.8, sc * 1.3);
      g.rotateY(a * 2.1);
      g.translate(Math.cos(a) * r, 0.1, Math.sin(a) * r);
      parts.push(g);
    }
    return { geometry: mergeGeometries(parts), radius: 2.6, height: h };
  }

  /**
   * Loose stone and dry brush across the flats. Instanced, so the whole layer
   * costs two draw calls no matter how many objects are in it.
   */
  _buildScatter() {
    const rng = new RNG(90210);
    const out = [];
    const specs = [
      { geo: buildPebble(3), count: 150, mat: this.pillarMat, lo: 0.16, hi: 0.72, edge: true },
      { geo: buildScrub(11), count: 110, mat: createNovaMaterial({ rim: 0.2, spec: 0.04, rimColor: 0xffd0a0 }), lo: 0.7, hi: 1.5, edge: false },
    ];
    this._scatterGeos = [];
    this._scatterMats = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const sv = new THREE.Vector3();
    for (const spec of specs) {
      const mesh = new THREE.InstancedMesh(spec.geo, spec.mat, spec.count);
      for (let i = 0; i < spec.count; i++) {
        const a = rng.next() * TAU;
        // biased outward: the middle of the arena has to stay clear to fight in
        const r = lerp(6, this.radius + 0.5, Math.pow(rng.next(), 0.55));
        const s = rng.range(spec.lo, spec.hi);
        v.set(Math.cos(a) * r, spec.edge ? rng.range(-0.1, 0.15) : -0.06, Math.sin(a) * r);
        e.set(spec.edge ? rng.next() * TAU : 0, rng.next() * TAU, spec.edge ? rng.range(-0.4, 0.4) : 0);
        q.setFromEuler(e);
        sv.set(s * rng.range(0.8, 1.3), s * rng.range(0.7, 1.2), s * rng.range(0.8, 1.3));
        mesh.setMatrixAt(i, m4.compose(v, q, sv));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      out.push(mesh);
      this._scatterGeos.push(spec.geo);
      if (spec.mat !== this.pillarMat) this._scatterMats.push(spec.mat);
    }
    return out;
  }

  /** Mesas out past the canyon. Eroded, hazed, purely for the horizon. */
  _buildIslands() {
    // fog eats most of them, which is the point: depth without detail
    const mesh = new THREE.Mesh(buildMesaBelt(21), createNovaMaterial({ rim: 0.18, spec: 0.02, fog: 1.0, rimColor: 0xffb877, bump: 0.0 }));
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

  /**
   * Image-based lighting from the sky we already baked. Prefiltering the sky
   * into a radiance map is the single biggest realism lever available here and
   * it costs one texture — no HDR asset needed.
   */
  buildEnvironment(renderer) {
    if (this._envRT) return;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const tex = skyTexture();
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this._envRT = pmrem.fromEquirectangular(tex);
      this.scene.environment = this._envRT.texture;
      // An LDR sky prefilters to a flat, bright ambient; keep it low and let
      // the sun do the work, or everything turns milky.
      this.scene.environmentIntensity = 0.30;
      pmrem.dispose();
    } catch (e) {
      // An env map is a quality win, never a requirement to run.
      console.warn('[nova-lance] environment map unavailable:', e && e.message);
    }
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
    this._scatterGeos.forEach((g) => g.dispose());
    this._scatterMats.forEach((m) => m.dispose());
    this.scatter.forEach((m) => m.dispose());
    this.towerMat.dispose(); this.pillarMat.dispose();
    this.islands.geometry.dispose(); this._islandMat.dispose();
    this.motes.geometry.dispose(); this._moteMat.dispose();
    this._mistGeo.dispose();
    this._mistMats.forEach((m) => m.dispose());
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
  }
}
