/**
 * materials.js — the game's whole look lives here.
 *
 * Everything is drawn with a small family of hand-written shaders rather than
 * three.js's PBR stack: it is cheaper, it keeps the faceted neon art direction
 * consistent, and it gives us per-vertex emissive plus a dissolve effect used
 * for every spawn and death in the game.
 *
 * Lighting is evaluated in VIEW space (so non-uniform scaling still shades
 * correctly) with one key light, a hemisphere fill, a rim term and cheap spec.
 */
import { noiseTexture, skyTexture, glowSprite } from './textures.js';
import { MAX_BONES } from './rig.js';

/** Uniform objects shared by reference across every material instance. */
export const globalUniforms = {
  uTime: { value: 0 },
  uLightDirView: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },
  uUpView: { value: new THREE.Vector3(0, 1, 0) },
  uLightColor: { value: new THREE.Color(1.0, 0.95, 0.92).multiplyScalar(1.15) },
  uSkyColor: { value: new THREE.Color(0.18, 0.26, 0.46) },
  uGroundColor: { value: new THREE.Color(0.05, 0.04, 0.10) },
  uFogColor: { value: new THREE.Color(0.035, 0.045, 0.10) },
  uFogNear: { value: 90 },
  uFogFar: { value: 260 },
};

const NOVA_VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aEmit;
  uniform float uTime;
  #ifdef RIGGED
    // Rigid bind: one bone per vertex, authored in that bone's local space,
    // so the pose is a single matrix multiply with no inverse-bind term.
    attribute float aBone;
    uniform mat4 uBones[MAX_BONES];
  #endif
  varying vec3 vColor;
  varying float vEmit;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying float vDepth;
  void main() {
    vColor = aColor;
    vEmit = aEmit;
    vec3 pos = position;
    vec3 nrm = normal;
    #ifdef RIGGED
      mat4 boneMat = uBones[int(aBone)];
      pos = (boneMat * vec4(pos, 1.0)).xyz;
      nrm = mat3(boneMat) * nrm;
    #endif
    // InstancedMesh support: three declares instanceMatrix for us, but this
    // shader does its own space transforms so it has to fold it in by hand.
    #ifdef USE_INSTANCING
      pos = (instanceMatrix * vec4(pos, 1.0)).xyz;
      nrm = mat3(instanceMatrix) * nrm;
    #endif
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorldPos = world.xyz;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mv.xyz;
    vDepth = -mv.z;
    vNormal = normalize(normalMatrix * nrm);
    gl_Position = projectionMatrix * mv;
  }
`;

const NOVA_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uTint;
  uniform vec3 uFlashColor;
  uniform vec3 uRimColor;
  uniform vec3 uLightColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform vec3 uLightDirView;
  uniform vec3 uUpView;
  uniform float uFlash;
  uniform float uEmitScale;
  uniform float uOpacity;
  uniform float uRim;
  uniform float uSpec;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogAmount;
  uniform float uDissolve;
  uniform vec3 uDissolveColor;
  uniform float uTime;
  uniform sampler2D uNoise;
  varying vec3 vColor;
  varying float vEmit;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying float vDepth;

  void main() {
    float edgeGlow = 0.0;
    if (uDissolve > 0.001) {
      float n = texture2D(uNoise, vWorldPos.xz * 0.22 + vWorldPos.y * 0.11).r;
      float n2 = texture2D(uNoise, vWorldPos.xz * 0.9 - vWorldPos.y * 0.4).g;
      n = n * 0.72 + n2 * 0.28;
      if (n < uDissolve) discard;
      edgeGlow = smoothstep(uDissolve + 0.16, uDissolve, n);
    }

    vec3 N = normalize(vNormal);
    vec3 V = normalize(-vViewPos);
    vec3 L = uLightDirView;
    float ndl = dot(N, L);
    float diff = max(ndl, 0.0);
    float wrapped = ndl * 0.5 + 0.5;
    float hemi = dot(N, uUpView) * 0.5 + 0.5;

    vec3 base = vColor * uTint;
    vec3 amb = mix(uGroundColor, uSkyColor, hemi);
    vec3 lit = base * (amb + uLightColor * (diff * 0.82 + wrapped * wrapped * 0.30));

    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 42.0) * uSpec;
    lit += uLightColor * spec;

    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.5);
    lit += uRimColor * fres * uRim;

    lit += base * vEmit * uEmitScale;
    lit += uDissolveColor * edgeGlow * 3.4;

    lit = mix(lit, uFlashColor, uFlash);

    float fog = smoothstep(uFogNear, uFogFar, vDepth) * uFogAmount;
    lit = mix(lit, uFogColor, fog);

    gl_FragColor = vec4(lit, uOpacity);
  }
`;

/**
 * Standard lit surface used by every ship, enemy and prop.
 * Pass `pose` (a rig Pose) to compile the skinned variant for this material.
 */
export function createNovaMaterial(opts = {}) {
  const m = new THREE.ShaderMaterial({
    vertexShader: NOVA_VERT,
    fragmentShader: NOVA_FRAG,
    defines: opts.pose ? { RIGGED: '', MAX_BONES } : {},
    transparent: !!opts.transparent,
    depthWrite: opts.depthWrite !== undefined ? opts.depthWrite : true,
    side: opts.side || THREE.FrontSide,
    toneMapped: false,
    uniforms: {
      uTime: globalUniforms.uTime,
      uLightDirView: globalUniforms.uLightDirView,
      uUpView: globalUniforms.uUpView,
      uLightColor: globalUniforms.uLightColor,
      uSkyColor: globalUniforms.uSkyColor,
      uGroundColor: globalUniforms.uGroundColor,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
      uNoise: { value: noiseTexture() },
      uTint: { value: new THREE.Color(opts.tint !== undefined ? opts.tint : 0xffffff) },
      uFlashColor: { value: new THREE.Color(opts.flashColor !== undefined ? opts.flashColor : 0xffffff) },
      uRimColor: { value: new THREE.Color(opts.rimColor !== undefined ? opts.rimColor : 0x53d9ff) },
      uDissolveColor: { value: new THREE.Color(opts.dissolveColor !== undefined ? opts.dissolveColor : 0x8ce8ff) },
      uFlash: { value: 0 },
      uEmitScale: { value: opts.emitScale !== undefined ? opts.emitScale : 1 },
      uOpacity: { value: opts.opacity !== undefined ? opts.opacity : 1 },
      uRim: { value: opts.rim !== undefined ? opts.rim : 0.32 },
      uSpec: { value: opts.spec !== undefined ? opts.spec : 0.35 },
      uFogAmount: { value: opts.fog !== undefined ? opts.fog : 1 },
      uDissolve: { value: 0 },
      uBones: { value: opts.pose ? opts.pose.uniform : null },
    },
  });
  m.name = opts.name || 'nova';
  return m;
}

/** Unlit additive material for energy shells, beams and glow cards. */
export function createEnergyMaterial(opts = {}) {
  const m = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: opts.blending !== undefined ? opts.blending : THREE.AdditiveBlending,
    side: opts.side || THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: globalUniforms.uTime,
      uColor: { value: new THREE.Color(opts.color !== undefined ? opts.color : 0x46e6ff) },
      uOpacity: { value: opts.opacity !== undefined ? opts.opacity : 1 },
      uPower: { value: opts.power !== undefined ? opts.power : 2.0 },
      uPulse: { value: opts.pulse !== undefined ? opts.pulse : 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uColor; uniform float uOpacity; uniform float uPower; uniform float uPulse; uniform float uTime;
      varying vec3 vNormal; varying vec3 vViewPos; varying vec2 vUv;
      void main(){
        vec3 N = normalize(vNormal);
        vec3 V = normalize(-vViewPos);
        float fres = pow(1.0 - abs(dot(N, V)), uPower);
        float pulse = 1.0 + uPulse * sin(uTime * 6.0);
        gl_FragColor = vec4(uColor * (fres * 2.1 + 0.16) * pulse, uOpacity * (fres * 0.95 + 0.1));
      }
    `,
  });
  m.name = 'energy';
  return m;
}

/**
 * The arena deck. A procedural hex lattice with travelling scan pulses and up
 * to eight live impact ripples — no textures, so it stays crisp at any zoom.
 */
export function createFloorMaterial() {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    transparent: false,
    uniforms: {
      uTime: globalUniforms.uTime,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
      uLightDirView: globalUniforms.uLightDirView,
      uNoise: { value: noiseTexture() },
      uBase: { value: new THREE.Color(0x080d1c) },
      uSeam: { value: new THREE.Color(0x2ad6ff) },
      uAccent: { value: new THREE.Color(0xff3ea5) },
      uDanger: { value: new THREE.Color(0x8b3fd0) },
      uRadius: { value: 46 },
      uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -99, 0)) },
      uPlayerPos: { value: new THREE.Vector3() },
      uThreat: { value: 0 },     // rises with danger — pushes the deck toward magenta
      uCoreGlow: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      varying float vDepth;
      varying vec3 vNormal;
      void main(){
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime; uniform float uRadius; uniform float uThreat; uniform float uCoreGlow;
      uniform vec3 uBase; uniform vec3 uSeam; uniform vec3 uAccent; uniform vec3 uDanger; uniform vec3 uFogColor;
      uniform float uFogNear; uniform float uFogFar;
      uniform vec4 uRipples[8];
      uniform vec3 uPlayerPos;
      uniform sampler2D uNoise;
      varying vec3 vWorldPos; varying float vDepth; varying vec3 vNormal;

      const vec2 S = vec2(1.7320508, 1.0);
      float hexDist(vec2 p){ p = abs(p); return max(dot(p, S * 0.5), p.y); }
      vec4 hexCell(vec2 p){
        vec4 hC = floor(vec4(p, p - vec2(0.8660254, 0.5)) / S.xyxy) + 0.5;
        vec4 h = vec4(p - hC.xy * S, p - (hC.zw + 0.5) * S);
        return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
      }
      float hash21(vec2 p){ return fract(sin(dot(p, vec2(27.619, 57.583))) * 43758.5453); }

      void main(){
        vec2 p = vWorldPos.xz;
        float rad = length(p);
        float t = uTime;

        // two-tier lattice: big structural plates over a fine deck weave
        vec4 plate = hexCell(p * 0.085);
        float plateEdge = hexDist(plate.xy);
        float plateSeam = smoothstep(0.435, 0.495, plateEdge);
        float plateRand = hash21(plate.zw);

        vec4 hc = hexCell(p * 0.42);
        float e = hexDist(hc.xy);
        float seam = smoothstep(0.450, 0.498, e);
        float cellRand = hash21(hc.zw);

        float grunge = texture2D(uNoise, p * 0.035).r * 0.55 + texture2D(uNoise, p * 0.15).g * 0.45;
        vec3 col = uBase * (0.45 + grunge * 0.85);
        col *= 0.84 + 0.16 * step(0.55, cellRand);
        col *= 0.88 + 0.24 * plateRand;

        // scan pulse rolling out from the stabilizer
        float scan = pow(sin(rad * 0.30 - t * 1.35) * 0.5 + 0.5, 14.0);
        float breathe = 0.5 + 0.5 * sin(t * 0.7 + plateRand * 12.0);

        // danger tint is violet, not bullet-magenta, so hostile fire stays legible
        vec3 seamCol = mix(uSeam, uDanger, uThreat * 0.72);
        // fine detail fades with distance: procedural lines have no mips, and
        // shimmering hex edges near the horizon are the fastest way to look cheap
        float detailFade = 1.0 - smoothstep(26.0, 78.0, vDepth);
        float fine = seam * (0.075 + breathe * 0.04 + scan * 0.20) * detailFade;
        float heavy = plateSeam * (0.19 + breathe * 0.085 + scan * 0.42);

        // impact ripples ride the lattice
        float ripple = 0.0;
        for (int i = 0; i < 8; i++) {
          vec4 R = uRipples[i];
          float age = t - R.z;
          if (age < 0.0 || age > 1.7) continue;
          float d = distance(p, R.xy);
          float r = age * 26.0;
          ripple += exp(-abs(d - r) * 0.55) * (1.0 - age / 1.7) * R.w;
        }

        col += seamCol * (fine + heavy + ripple * 0.9) * 1.35;
        col += seamCol * ripple * 0.16;

        // pilot proximity glow keeps the ship readable against the deck
        float pd = distance(p, uPlayerPos.xz);
        col += uSeam * 0.035 * exp(-pd * 0.20);

        // core well in the middle of the arena
        float core = exp(-rad * 0.11);
        col += mix(uSeam, vec3(1.0), 0.35) * core * (0.22 + uCoreGlow);

        // rim treatment + falloff into the void
        float edge = smoothstep(uRadius - 2.8, uRadius, rad);
        col = mix(col, uAccent * 1.1, edge * 0.45);
        float outside = smoothstep(uRadius, uRadius + 0.8, rad);
        col *= (1.0 - outside * 0.85);

        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        col = mix(col, uFogColor, fog * 0.9);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Inverted sphere carrying the baked nebula. */
export function createSkyMaterial() {
  return new THREE.MeshBasicMaterial({
    map: skyTexture(),
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
}

/** GPU point sprites: one draw call for the entire particle system. */
export function createParticleMaterial(texture) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uTexture: { value: texture || glowSprite() },
      uScale: { value: 500 },
      uBrightness: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main(){
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.0, aSize * uScale / max(0.001, -mv.z));
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uBrightness;
      varying vec3 vColor;
      varying float vAlpha;
      void main(){
        vec4 tex = texture2D(uTexture, gl_PointCoord);
        float a = tex.a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * uBrightness * a, a);
      }
    `,
  });
}

/** Expanding shockwave ring / telegraph decal. */
export function createRingMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: opts.blending !== undefined ? opts.blending : THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color(opts.color !== undefined ? opts.color : 0x46e6ff) },
      uOpacity: { value: 1 },
      uThickness: { value: opts.thickness !== undefined ? opts.thickness : 0.18 },
      uFill: { value: opts.fill !== undefined ? opts.fill : 0 },
      uProgress: { value: 0 },
      uTime: globalUniforms.uTime,
      uDashes: { value: opts.dashes !== undefined ? opts.dashes : 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uColor; uniform float uOpacity; uniform float uThickness; uniform float uFill;
      uniform float uProgress; uniform float uTime; uniform float uDashes;
      varying vec2 vUv;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float ring = smoothstep(1.0, 1.0 - uThickness, r) * smoothstep(1.0 - uThickness * 2.2, 1.0 - uThickness, r);
        float fill = uFill * (0.10 + 0.14 * smoothstep(1.0, 0.0, r));
        float sweep = 1.0;
        if (uProgress > 0.0) {
          float a = atan(p.y, p.x) / 6.2831853 + 0.5;
          sweep = step(a, uProgress) * 0.85 + 0.15;
        }
        float dashMask = 1.0;
        if (uDashes > 0.5) {
          float a = atan(p.y, p.x);
          dashMask = step(0.35, fract(a * uDashes / 6.2831853 + uTime * 0.25));
        }
        float alpha = (ring * dashMask * 1.4 + fill) * uOpacity * sweep;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor * alpha * 1.6, alpha);
      }
    `,
  });
}

/** Soft ground shadow / decal quad. */
export function createDecalMaterial(texture, opts = {}) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: opts.blending !== undefined ? opts.blending : THREE.NormalBlending,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    color: opts.color !== undefined ? opts.color : 0xffffff,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

/** Screen-facing energy beam (a stretched quad with animated core). */
export function createBeamMaterial(color = 0xff3ea5) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
      uTime: globalUniforms.uTime,
      uCharge: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uCharge;
      varying vec2 vUv;
      void main(){
        float d = abs(vUv.y - 0.5) * 2.0;
        float core = pow(1.0 - d, 6.0);
        float halo = pow(1.0 - d, 1.6) * 0.5;
        float flicker = 0.86 + 0.14 * sin(uTime * 47.0 + vUv.x * 30.0);
        float head = smoothstep(1.0, 0.86, vUv.x);
        float a = (core + halo) * uOpacity * flicker * head;
        vec3 col = mix(uColor, vec3(1.0), core * 0.75);
        gl_FragColor = vec4(col * a * 2.2, a);
      }
    `,
  });
}

export function setLightDirection(dirWorld, camera) {
  const v = globalUniforms.uLightDirView.value;
  v.copy(dirWorld).normalize().transformDirection(camera.matrixWorldInverse);
  const up = globalUniforms.uUpView.value;
  up.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
}
