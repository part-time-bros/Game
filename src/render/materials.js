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
  // Golden hour: a warm low key light, warm sky fill from above, and bounce
  // off dry dirt from below. The old cold blue fill is what made everything
  // read as neon-lit plastic.
  uLightColor: { value: new THREE.Color(1.0, 0.80, 0.55).multiplyScalar(1.30) },
  uSkyColor: { value: new THREE.Color(0.30, 0.28, 0.34) },
  uGroundColor: { value: new THREE.Color(0.17, 0.12, 0.08) },
  uFogColor: { value: new THREE.Color(0.52, 0.38, 0.26) },
  uFogNear: { value: 90 },
  uFogFar: { value: 260 },
  // 0 = write linear HDR for the composite pass to tone map (the normal path).
  // 1 = the composite is gone (see Renderer.degrade) and each shader has to
  // tone map and encode on its own. One shared object, so flipping it flips
  // every material at once without touching a registry.
  uOutput: { value: 0 },
};

/** Tone map + sRGB encode, matched to the composite pass, for the direct path. */
const NOVA_OUT = /* glsl */`
  uniform float uOutput;
  vec3 novaOut(vec3 c){
    if (uOutput < 0.5) return c;
    c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c));
  }
`;

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
  ${NOVA_OUT}
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

    // A tight, dim rim reads as sun wrap on a dusty edge. The old wide bright
    // one outlined every object in colour, which is most of what "neon" was.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 6.5);
    lit += uRimColor * fres * uRim * 0.34;

    lit += base * vEmit * uEmitScale;
    lit += uDissolveColor * edgeGlow * 3.4;

    lit = mix(lit, uFlashColor, uFlash);

    float fog = smoothstep(uFogNear, uFogFar, vDepth) * uFogAmount;
    lit = mix(lit, uFogColor, fog);

    gl_FragColor = vec4(novaOut(lit), uOpacity);
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
      uOutput: globalUniforms.uOutput,
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
      uRimColor: { value: new THREE.Color(opts.rimColor !== undefined ? opts.rimColor : 0xffc98a) },
      uDissolveColor: { value: new THREE.Color(opts.dissolveColor !== undefined ? opts.dissolveColor : 0xffb060) },
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
      uOutput: globalUniforms.uOutput,
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
  ${NOVA_OUT}
      uniform vec3 uColor; uniform float uOpacity; uniform float uPower; uniform float uPulse; uniform float uTime;
      varying vec3 vNormal; varying vec3 vViewPos; varying vec2 vUv;
      void main(){
        vec3 N = normalize(vNormal);
        vec3 V = normalize(-vViewPos);
        float fres = pow(1.0 - abs(dot(N, V)), uPower);
        float pulse = 1.0 + uPulse * sin(uTime * 6.0);
        gl_FragColor = vec4(novaOut(uColor * (fres * 2.1 + 0.16) * pulse), uOpacity * (fres * 0.95 + 0.1));
      }
    `,
  });
  m.name = 'energy';
  return m;
}

/**
 * The canyon floor. Dry cracked earth: a cellular crack network over layered
 * fbm tone, with dust kicked up by impacts. No lattice, no seam glow — the
 * ground is lit, not emissive, which is most of what separates this from the
 * neon deck it replaced.
 */
export function createFloorMaterial() {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    transparent: false,
    uniforms: {
      uTime: globalUniforms.uTime,
      uOutput: globalUniforms.uOutput,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
      uLightDirView: globalUniforms.uLightDirView,
      uLightColor: globalUniforms.uLightColor,
      uSkyColor: globalUniforms.uSkyColor,
      uNoise: { value: noiseTexture() },
      uBase: { value: new THREE.Color(0x8a6a46) },      // dry dirt
      uSeam: { value: new THREE.Color(0x53402c) },      // crack shadow
      uAccent: { value: new THREE.Color(0xc2a374) },    // pale sand drift
      uDanger: { value: new THREE.Color(0x7a2b22) },    // blood-dark, rises with threat
      uRadius: { value: 46 },
      uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -99, 0)) },
      uPlayerPos: { value: new THREE.Vector3() },
      uThreat: { value: 0 },
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
      ${NOVA_OUT}
      uniform float uTime; uniform float uRadius; uniform float uThreat; uniform float uCoreGlow;
      uniform vec3 uBase; uniform vec3 uSeam; uniform vec3 uAccent; uniform vec3 uDanger;
      uniform vec3 uFogColor; uniform vec3 uLightColor; uniform vec3 uSkyColor;
      uniform vec3 uLightDirView;
      uniform float uFogNear; uniform float uFogFar;
      uniform vec4 uRipples[8];
      uniform vec3 uPlayerPos;
      uniform sampler2D uNoise;
      varying vec3 vWorldPos; varying float vDepth; varying vec3 vNormal;

      vec2 hash22(vec2 p){
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      /** Worley F2-F1: near zero along cell borders, which is where clay splits. */
      float crackField(vec2 p){
        vec2 n = floor(p), f = fract(p);
        float f1 = 8.0, f2 = 8.0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            float d = length(g + hash22(n + g) - f);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
        }
        return f2 - f1;
      }

      void main(){
        vec2 p = vWorldPos.xz;
        float rad = length(p);

        // Fine detail has no mips, and shimmering crack lines near the horizon
        // are the fastest way to look cheap, so it fades with distance.
        float detail = 1.0 - smoothstep(22.0, 74.0, vDepth);

        float grain = texture2D(uNoise, p * 0.045).r * 0.55 + texture2D(uNoise, p * 0.21).g * 0.45;
        float drift = texture2D(uNoise, p * 0.012).b;   // 'patch' is a GLSL reserved word

        // Two crack scales. These are hairline splits in dried clay, roughly a
        // hand's width apart — an earlier pass had cells six metres across,
        // which read as paving slabs rather than ground.
        float big = 1.0 - smoothstep(0.0, 0.055, crackField(p * 0.45));
        float fine = 1.0 - smoothstep(0.0, 0.085, crackField(p * 1.35));
        float crack = clamp(big * 0.85 + fine * 0.5 * detail, 0.0, 1.0);

        // dirt tone: sun-bleached sand drifting over darker earth, in broad
        // uneven blotches so no two stretches of ground look the same
        vec3 albedo = mix(uBase, uAccent, smoothstep(0.34, 0.82, drift));
        albedo = mix(albedo, uSeam, smoothstep(0.62, 0.16, drift) * 0.45);
        albedo *= 0.70 + grain * 0.58;
        albedo = mix(albedo, uSeam, crack * 0.34);
        // blood-dark wash as the field gets dangerous, not a shift to magenta
        albedo = mix(albedo, uDanger, uThreat * 0.16);

        // lit, not emissive: flat key + sky fill, with the cracks self-shadowing
        vec3 N = normalize(vNormal);
        float ndl = max(dot(N, uLightDirView), 0.0);
        float ao = 1.0 - crack * 0.26;
        vec3 col = albedo * (uSkyColor * 0.85 * ao + uLightColor * (0.28 + ndl * 0.72) * ao);

        // dust kicked up by impacts
        float ripple = 0.0;
        for (int i = 0; i < 8; i++) {
          vec4 R = uRipples[i];
          float age = uTime - R.z;
          if (age < 0.0 || age > 1.7) continue;
          float d = distance(p, R.xy);
          float r = age * 26.0;
          ripple += exp(-abs(d - r) * 0.55) * (1.0 - age / 1.7) * R.w;
        }
        col = mix(col, uAccent * 1.05, clamp(ripple * 0.45, 0.0, 0.65));

        // a soft pool of light around the rider keeps them readable on open ground
        float pd = distance(p, uPlayerPos.xz);
        col += uLightColor * 0.030 * exp(-pd * 0.16);
        col += uAccent * uCoreGlow * 0.05 * exp(-rad * 0.09);

        // the ground darkens toward the canyon wall: ambient occlusion at the
        // scale of the whole arena, and it stops the floor reading as a disc
        float edge = smoothstep(uRadius - 22.0, uRadius, rad);
        col *= 1.0 - edge * 0.62;

        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        col = mix(col, uFogColor, fog * 0.92);
        gl_FragColor = vec4(novaOut(col), 1.0);
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
      uOutput: globalUniforms.uOutput,
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
  ${NOVA_OUT}
      uniform sampler2D uTexture;
      uniform float uBrightness;
      varying vec3 vColor;
      varying float vAlpha;
      void main(){
        vec4 tex = texture2D(uTexture, gl_PointCoord);
        float a = tex.a * vAlpha;
        if (a < 0.004) discard;
        gl_FragColor = vec4(novaOut(vColor * uBrightness * a), a);
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
      uOutput: globalUniforms.uOutput,
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
  ${NOVA_OUT}
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
        gl_FragColor = vec4(novaOut(uColor * alpha * 1.6), alpha);
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
      uOutput: globalUniforms.uOutput,
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
  ${NOVA_OUT}
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
        gl_FragColor = vec4(novaOut(col * a * 2.2), a);
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
