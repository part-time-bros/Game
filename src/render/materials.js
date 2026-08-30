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
import { clamp } from '../core/util.js';
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
  const u = {
    uNoise: { value: noiseTexture() },
    uTint: { value: new THREE.Color(opts.tint !== undefined ? opts.tint : 0xffffff) },
    uFlashColor: { value: new THREE.Color(opts.flashColor !== undefined ? opts.flashColor : 0xffffff) },
    uRimColor: { value: new THREE.Color(opts.rimColor !== undefined ? opts.rimColor : 0xffc98a) },
    uDissolveColor: { value: new THREE.Color(opts.dissolveColor !== undefined ? opts.dissolveColor : 0xffb060) },
    uFlash: { value: 0 },
    uEmitScale: { value: opts.emitScale !== undefined ? opts.emitScale : 1 },
    uOpacity: { value: opts.opacity !== undefined ? opts.opacity : 1 },
    uRim: { value: opts.rim !== undefined ? opts.rim : 0.32 },
    uDissolve: { value: 0 },
    uDetail: { value: opts.detail !== undefined ? opts.detail : 1 },
    uBump: { value: opts.bump !== undefined ? opts.bump : 0.07 },
    uBumpScale: { value: opts.bumpScale !== undefined ? opts.bumpScale : 1.2 },
    uBones: { value: opts.pose ? opts.pose.uniform : null },
  };

  // `spec` used to drive a hand-rolled specular lobe; it now maps to PBR
  // roughness, which is the same intent expressed in the units the BRDF wants.
  const spec = opts.spec !== undefined ? opts.spec : 0.35;
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: clamp(1.0 - spec * 0.85, 0.18, 1.0),
    metalness: opts.metalness !== undefined ? opts.metalness : 0.06,
    transparent: !!opts.transparent,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    depthWrite: opts.depthWrite !== undefined ? opts.depthWrite : true,
    side: opts.side || THREE.FrontSide,
    fog: true,
  });
  m.defines = opts.pose ? { RIGGED: '', MAX_BONES } : {};
  // Call sites mutate uniforms directly (mat.uniforms.uDissolve.value = ...).
  // These are the same objects the compiled program binds, so the assignment
  // still lands even though this is no longer a raw ShaderMaterial.
  m.uniforms = u;

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aColor;
        attribute float aEmit;
        varying vec3 vNovaColor;
        varying float vNovaEmit;
        varying vec3 vNovaWorld;
        #ifdef RIGGED
          // Rigid bind: one bone per vertex, authored in that bone's local
          // space, so the pose is a single matrix multiply and no inverse-bind.
          attribute float aBone;
          uniform mat4 uBones[MAX_BONES];
        #endif`)
      // Bone transform has to land before three's instancing and projection
      // maths, which is exactly what these two chunks are for.
      .replace('#include <beginnormal_vertex>', `
        vec3 objectNormal = vec3(normal);
        #ifdef RIGGED
          objectNormal = mat3(uBones[int(aBone)]) * objectNormal;
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        #ifdef RIGGED
          transformed = (uBones[int(aBone)] * vec4(transformed, 1.0)).xyz;
        #endif
        vNovaColor = aColor;
        vNovaEmit = aEmit;
        vNovaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vNovaColor;
        varying float vNovaEmit;
        varying vec3 vNovaWorld;
        uniform vec3 uTint; uniform vec3 uFlashColor; uniform vec3 uRimColor;
        uniform vec3 uDissolveColor;
        uniform float uFlash; uniform float uEmitScale; uniform float uOpacity;
        uniform float uRim; uniform float uDissolve; uniform float uDetail;
        uniform float uBump; uniform float uBumpScale;
        uniform sampler2D uNoise;`)
      // Writing into diffuseColor rather than gl_FragColor is the whole point:
      // everything downstream — shadows, IBL, the BRDF, fog, tone mapping —
      // then applies to it for free. Writing gl_FragColor skipped all of it.
      .replace('#include <map_fragment>', `
        float novaDis = texture2D(uNoise, vNovaWorld.xz * 0.22 + vNovaWorld.y * 0.11).r;
        float novaEdge = 0.0;
        if (uDissolve > 0.001) {
          float novaN2 = texture2D(uNoise, vNovaWorld.xz * 0.9 - vNovaWorld.y * 0.4).g;
          float n = novaDis * 0.72 + novaN2 * 0.28;
          if (n < uDissolve) discard;
          novaEdge = smoothstep(uDissolve + 0.16, uDissolve, n);
        }
        // Triplanar break-up. Flat vertex colour on flat geometry is most of
        // why untextured models read as plastic; this costs three taps and
        // gives every face some grain that follows the surface.
        float novaDxz = texture2D(uNoise, vNovaWorld.xz * 0.85).g;
        float novaDxy = texture2D(uNoise, vNovaWorld.xy * 0.85).b;
        float novaDzy = texture2D(uNoise, vNovaWorld.zy * 0.85).r;
        float novaDet = mix(0.5, (novaDxz + novaDxy + novaDzy) / 3.0, uDetail);

        // ---- procedural detail height, projected triplanar ----
        // Geometry can only carry features bigger than an edge; everything
        // below that has to come from the normal. This is the height field the
        // shading normal is perturbed by, a few lines further down.
        vec3 novaWN = normalize(cross(dFdx(vNovaWorld), dFdy(vNovaWorld)));
        vec3 novaTri = abs(novaWN);
        novaTri /= max(1e-4, novaTri.x + novaTri.y + novaTri.z);
        vec2 novaSc = vec2(uBumpScale);
        float novaH =
            texture2D(uNoise, vNovaWorld.zy * novaSc).r * novaTri.x +
            texture2D(uNoise, vNovaWorld.xz * novaSc).r * novaTri.y +
            texture2D(uNoise, vNovaWorld.xy * novaSc).r * novaTri.z;
        novaH += 0.34 * (
            texture2D(uNoise, vNovaWorld.zy * novaSc * 2.4).g * novaTri.x +
            texture2D(uNoise, vNovaWorld.xz * novaSc * 2.4).g * novaTri.y +
            texture2D(uNoise, vNovaWorld.xy * novaSc * 2.4).g * novaTri.z);
        diffuseColor.rgb *= vNovaColor * uTint * (0.80 + novaDet * 0.42);
        diffuseColor.rgb = mix(diffuseColor.rgb, uFlashColor, uFlash);
        diffuseColor.a *= uOpacity;`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * (0.82 + novaDet * 0.36);`)
      // Mikkelsen's derivative bump: the surface gradient of a height field,
      // rebuilt from screen-space derivatives, so no tangents and no UVs are
      // needed. This is what gives untextured rock a readable surface up close.
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        // A derivative bump has no mip chain, so at distance it turns into
        // speckle. It has to fade out before it gets there.
        float novaBump = uBump * (1.0 - smoothstep(16.0, 52.0, length(vViewPosition)));
        if (novaBump > 0.001) {
          vec3 novaSurf = -vViewPosition;
          vec3 novaPx = dFdx(novaSurf), novaPy = dFdy(novaSurf);
          vec3 novaR1 = cross(novaPy, normal);
          vec3 novaR2 = cross(normal, novaPx);
          float novaDt = dot(novaPx, novaR1);
          vec3 novaGrad = sign(novaDt) * (dFdx(novaH) * novaR1 + dFdy(novaH) * novaR2);
          normal = normalize(abs(novaDt) * normal - novaBump * novaGrad);
        }`)
      .replace('#include <emissivemap_fragment>', `
        totalEmissiveRadiance += vNovaColor * vNovaEmit * uEmitScale;
        totalEmissiveRadiance += uDissolveColor * novaEdge * 3.0;
        // a thin warm sun-wrap along silhouettes, on top of the real lighting
        float novaFres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
        totalEmissiveRadiance += uRimColor * novaFres * uRim * 0.30;`);
  };

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
 * fbm tone. Built on MeshStandardMaterial so it *receives the sun's shadow* —
 * the ground is where cast shadows matter most, and a raw ShaderMaterial
 * cannot receive them at all.
 */
export function createFloorMaterial() {
  const u = {
    uNoise: { value: noiseTexture() },
    uBase: { value: new THREE.Color(0x6f5537) },      // dry dirt
    uSeam: { value: new THREE.Color(0x3a2c1d) },      // crack shadow
    uAccent: { value: new THREE.Color(0x9d8259) },    // pale sand drift
    uDanger: { value: new THREE.Color(0x7a2b22) },    // blood-dark, rises with threat
    uRadius: { value: 46 },
    uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -99, 0)) },
    uPlayerPos: { value: new THREE.Vector3() },
    uThreat: { value: 0 },
    uCoreGlow: { value: 0 },
    uTime: globalUniforms.uTime,
  };

  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0, fog: true });
  m.uniforms = u;

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aColor;
        varying vec3 vFloorWorld;
        varying vec3 vFloorTint;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        vFloorTint = aColor;
        vFloorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFloorWorld;
        varying vec3 vFloorTint;
        uniform float uTime; uniform float uRadius; uniform float uThreat; uniform float uCoreGlow;
        uniform vec3 uBase; uniform vec3 uSeam; uniform vec3 uAccent; uniform vec3 uDanger;
        uniform vec4 uRipples[8];
        uniform vec3 uPlayerPos;
        uniform sampler2D uNoise;

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
        }`)
      .replace('#include <map_fragment>', `
        vec2 fp = vFloorWorld.xz;
        float frad = length(fp);
        // Fine detail has no mips; shimmering crack lines near the horizon are
        // the fastest way to look cheap, so it fades with distance.
        float fdetail = 1.0 - smoothstep(22.0, 74.0, length(vViewPosition));

        float fgrain = texture2D(uNoise, fp * 0.045).r * 0.55 + texture2D(uNoise, fp * 0.21).g * 0.45;
        float fdrift = texture2D(uNoise, fp * 0.012).b;

        // hairline splits in dried clay, roughly a hand's width apart
        float fbig = 1.0 - smoothstep(0.0, 0.075, crackField(fp * 0.62));
        float ffine = 1.0 - smoothstep(0.0, 0.095, crackField(fp * 1.9));
        // Clay does not craze evenly over a whole basin — it splits where the
        // silt lay thickest. An even crack field over the entire floor is the
        // clearest tell that a texture is generated rather than observed.
        float fpatch = smoothstep(0.30, 0.66, texture2D(uNoise, fp * 0.023).r);
        float fcrack = clamp(fbig * 0.85 + ffine * 0.55 * fdetail, 0.0, 1.0) * fpatch;

        // The terrain mesh bakes the large-scale story into vertex colour —
        // sand drifts, wash bottoms, the shadow under the canyon wall — because
        // that is the scale a shader cannot see. Everything below is detail too
        // fine to tessellate, applied as modulation on top of it.
        vec3 fground = mix(uBase, uAccent, smoothstep(0.34, 0.82, fdrift));
        vec3 falbedo = mix(fground, vFloorTint, 0.72);
        falbedo = mix(falbedo, uSeam, smoothstep(0.62, 0.16, fdrift) * 0.35);
        falbedo *= 0.74 + fgrain * 0.34;
        falbedo = mix(falbedo, uSeam, fcrack * 0.46);
        falbedo = mix(falbedo, uDanger, uThreat * 0.16);

        // dust kicked up by impacts
        float fripple = 0.0;
        for (int i = 0; i < 8; i++) {
          vec4 R = uRipples[i];
          float age = uTime - R.z;
          if (age < 0.0 || age > 1.7) continue;
          float d = distance(fp, R.xy);
          float r = age * 26.0;
          fripple += exp(-abs(d - r) * 0.55) * (1.0 - age / 1.7) * R.w;
        }
        falbedo = mix(falbedo, uAccent * 1.05, clamp(fripple * 0.45, 0.0, 0.65));

        // arena-scale occlusion: the ground darkens toward the canyon wall
        float fedge = smoothstep(uRadius - 22.0, uRadius, frad);
        falbedo *= 1.0 - fedge * 0.55;

        diffuseColor.rgb *= falbedo;`)
      // cracks read as damp/rough, drifted sand as smoother
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * (0.86 + fcrack * 0.14) - fdrift * 0.10;`)
      // The cracks are grooves, not a painted pattern: perturbing the shading
      // normal by the same field is what makes them catch the low sun.
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        {
          float fh = fgrain * 0.30 - fcrack * 0.75;
          vec3 fsurf = -vViewPosition;
          vec3 fpx = dFdx(fsurf), fpy = dFdy(fsurf);
          vec3 fr1 = cross(fpy, normal);
          vec3 fr2 = cross(normal, fpx);
          float fdt = dot(fpx, fr1);
          vec3 fgrad = sign(fdt) * (dFdx(fh) * fr1 + dFdy(fh) * fr2);
          normal = normalize(abs(fdt) * normal - 0.075 * fdetail * fgrad);
        }`)
      .replace('#include <emissivemap_fragment>', `
        totalEmissiveRadiance += uAccent * uCoreGlow * 0.04 * exp(-frad * 0.09);
        // the cracks self-shadow: cheap contact darkening the shadow map is
        // far too coarse to resolve
        diffuseColor.rgb *= 1.0 - fcrack * 0.26;`);
  };

  return m;
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
