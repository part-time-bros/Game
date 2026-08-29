/**
 * renderer.js — WebGL setup plus a hand-written post chain.
 *
 * three.js's UMD build ships no post-processing addons, so the pipeline here is
 * bespoke and deliberately small:
 *
 *   scene ──> HDR target ──> bright pass ──> blur H/V (½ and ¼ res) ─┐
 *                    └──────────────────────────────────────────────┴─> composite
 *
 * The composite pass also does ACES tone mapping, sRGB encode, vignette,
 * chromatic aberration (damage/dash), grain and the overdrive colour grade,
 * so the whole screen treatment costs one extra fullscreen pass.
 */
import { clamp, clamp01, RollingStat } from '../core/util.js';

const QUALITY = {
  low: { bloom: false, bloomLevels: 0, maxPixelRatio: 1.0, particleScale: 0.45, grain: 0.0, shadowBlobs: true },
  medium: { bloom: true, bloomLevels: 1, maxPixelRatio: 1.35, particleScale: 0.75, grain: 0.02, shadowBlobs: true },
  high: { bloom: true, bloomLevels: 2, maxPixelRatio: 2.0, particleScale: 1.0, grain: 0.03, shadowBlobs: true },
};

const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class Renderer {
  constructor(canvas, quality = 'auto') {
    this.canvas = canvas;
    this.contextLost = false;
    this.frameStat = new RollingStat(120);
    this.gpuBudget = 1000 / 55;
    this._autoTimer = 0;
    this._autoLocked = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,            // FXAA-free: bloom + composite already soften edges, MSAA is costly
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      // only for automated capture: keeps the backbuffer readable for screenshots
      preserveDrawingBuffer: typeof location !== 'undefined' && location.search.indexOf('capture') >= 0,
    });
    this.renderer.setClearColor(0x03040c, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;   // we tone map in the composite
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;

    this.isWebGL2 = this.renderer.capabilities.isWebGL2;
    this.hdrType = this.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.quality = quality === 'auto' ? this._detectQuality() : quality;
    this.autoQuality = quality === 'auto';
    this.settings = QUALITY[this.quality] || QUALITY.medium;

    this._buildTargets(1, 1);
    this._buildPasses();

    this._onLost = (e) => { e.preventDefault(); this.contextLost = true; this._orphaned = true; };
    this._onRestored = () => { this.contextLost = false; this.resize(this._w, this._h, true); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
  }

  /** Rough tier guess from device hints; auto-tuning refines it once frames flow. */
  _detectQuality() {
    const dm = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (mobile) return dm >= 6 && cores >= 8 ? 'medium' : 'low';
    if (cores <= 4 || dm <= 4) return 'medium';
    return 'high';
  }

  _makeRT(w, h, type) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: type || this.hdrType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.generateMipmaps = false;
    return rt;
  }

  _buildTargets(w, h) {
    this._disposeTargets();
    this.sceneRT = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this.hdrType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.sceneRT.texture.generateMipmaps = false;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.brightRT = this._makeRT(hw, hh);
    this.blurA = this._makeRT(hw, hh);
    this.blurB = this._makeRT(hw, hh);
    this.blurC = this._makeRT(qw, qh);
    this.blurD = this._makeRT(qw, qh);
  }

  _disposeTargets() {
    for (const k of ['sceneRT', 'brightRT', 'blurA', 'blurB', 'blurC', 'blurD']) {
      if (!this[k]) continue;
      // After a context loss the GPU objects are already gone; calling dispose()
      // makes three try to delete handles that no longer belong to the context.
      if (!this._orphaned) this[k].dispose();
      this[k] = null;
    }
    this._orphaned = false;
  }

  _buildPasses() {
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.72 }, uSoft: { value: 0.45 } },
      vertexShader: FS_VERT,
      depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse; uniform float uThreshold; uniform float uSoft;
        varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float knee = uThreshold * uSoft + 1e-5;
          float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee);
          float contrib = max(soft, l - uThreshold) / max(l, 1e-5);
          gl_FragColor = vec4(c * contrib, 1.0);
        }
      `,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) } },
      vertexShader: FS_VERT,
      depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel;
        varying vec2 vUv;
        void main(){
          vec2 o = uDir * uTexel;
          vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
          sum += texture2D(tDiffuse, vUv + o * 1.3846153846).rgb * 0.3162162162;
          sum += texture2D(tDiffuse, vUv - o * 1.3846153846).rgb * 0.3162162162;
          sum += texture2D(tDiffuse, vUv + o * 3.2307692308).rgb * 0.0702702703;
          sum += texture2D(tDiffuse, vUv - o * 3.2307692308).rgb * 0.0702702703;
          gl_FragColor = vec4(sum, 1.0);
        }
      `,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tBloom2: { value: null },
        uBloom: { value: 0.85 },
        uUseBloom: { value: 1 },
        uUseBloom2: { value: 1 },
        uExposure: { value: 1.0 },
        uVignette: { value: 0.42 },
        uAberration: { value: 0.0 },
        uGrain: { value: 0.03 },
        uTime: { value: 0 },
        uSaturation: { value: 1.06 },
        uFlashColor: { value: new THREE.Color(0, 0, 0) },
        uFlash: { value: 0 },
        uDesaturate: { value: 0 },
        uRadial: { value: 0 },
        uScanline: { value: 0.0 },
      },
      vertexShader: FS_VERT,
      depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tBloom2;
        uniform float uBloom, uUseBloom, uUseBloom2, uExposure, uVignette, uAberration, uGrain, uTime;
        uniform float uSaturation, uFlash, uDesaturate, uRadial, uScanline;
        uniform vec3 uFlashColor;
        varying vec2 vUv;

        vec3 aces(vec3 x){
          const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }
        vec3 toSRGB(vec3 c){
          return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
        }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

        void main(){
          vec2 uv = vUv;
          vec2 centered = uv - 0.5;
          float r2 = dot(centered, centered);

          // radial blur streaks during dash / big hits
          vec3 col;
          if (uRadial > 0.001) {
            col = vec3(0.0);
            float total = 0.0;
            for (int i = 0; i < 6; i++) {
              float t = float(i) / 5.0;
              float scale = 1.0 - uRadial * 0.06 * t;
              vec2 suv = centered * scale + 0.5;
              float w = 1.0 - t * 0.55;
              col += texture2D(tScene, suv).rgb * w;
              total += w;
            }
            col /= total;
          } else {
            col = texture2D(tScene, uv).rgb;
          }

          // chromatic aberration scaled by distance from centre
          if (uAberration > 0.0001) {
            vec2 off = centered * uAberration * (0.4 + r2 * 2.2);
            col.r = texture2D(tScene, uv + off).r;
            col.b = texture2D(tScene, uv - off).b;
          }

          if (uUseBloom > 0.5) {
            vec3 bloom = texture2D(tBloom, uv).rgb;
            if (uUseBloom2 > 0.5) bloom += texture2D(tBloom2, uv).rgb * 0.85;
            col += bloom * uBloom;
          }

          col *= uExposure;
          col = aces(col);

          // grade
          float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(luma), col, uSaturation);
          col = mix(col, vec3(luma), uDesaturate);
          col = mix(col, uFlashColor, uFlash);

          // vignette
          float vig = smoothstep(0.85, 0.18, r2 * 2.0);
          col *= mix(1.0, vig, uVignette);

          if (uScanline > 0.001) {
            col *= 1.0 - uScanline * step(0.5, fract(gl_FragCoord.y * 0.5));
          }

          if (uGrain > 0.0001) {
            float g = hash(uv * 1024.0 + fract(uTime) * 91.7) - 0.5;
            col += g * uGrain;
          }

          gl_FragColor = vec4(toSRGB(max(col, vec3(0.0))), 1.0);
        }
      `,
    });
  }

  setQuality(q) {
    if (q === 'auto') { this.autoQuality = true; this._autoLocked = false; q = this._detectQuality(); }
    else { this.autoQuality = false; }
    if (!QUALITY[q]) q = 'medium';
    this.quality = q;
    this.settings = QUALITY[q];
    this.resize(this._w, this._h, true);
  }

  resize(w, h, force = false) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    const dpr = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio);
    if (!force && w === this._w && h === this._h && dpr === this._dpr) return;
    this._w = w; this._h = h; this._dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    this._pw = pw; this._ph = ph;
    this._buildTargets(pw, ph);
  }

  /** Full frame: scene into HDR target, bloom chain, composite to the canvas. */
  render(scene, camera, fx = null) {
    if (this.contextLost) return;
    const r = this.renderer;
    r.info.reset();

    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    const s = this.settings;
    if (s.bloom) {
      this.quad.material = this.brightMat;
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      r.setRenderTarget(this.brightRT);
      r.render(this.quadScene, this.quadCam);

      this._blur(this.brightRT, this.blurA, this.blurB, 1.0);
      if (s.bloomLevels > 1) this._blur(this.blurB, this.blurC, this.blurD, 2.0);
    }

    this.quad.material = this.compositeMat;
    const u = this.compositeMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = s.bloom ? this.blurB.texture : null;
    u.tBloom2.value = s.bloomLevels > 1 ? this.blurD.texture : null;
    u.uUseBloom.value = s.bloom ? 1 : 0;
    u.uUseBloom2.value = s.bloomLevels > 1 ? 1 : 0;
    u.uGrain.value = s.grain * (fx ? fx.grain : 1);
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  _blur(src, tmp, dst, spread) {
    const r = this.renderer;
    this.quad.material = this.blurMat;
    const u = this.blurMat.uniforms;
    u.tDiffuse.value = src.texture;
    u.uTexel.value.set(spread / tmp.width, spread / tmp.height);
    u.uDir.value.set(1, 0);
    r.setRenderTarget(tmp);
    r.render(this.quadScene, this.quadCam);
    u.tDiffuse.value = tmp.texture;
    u.uDir.value.set(0, 1);
    r.setRenderTarget(dst);
    r.render(this.quadScene, this.quadCam);
  }

  /**
   * Auto-tune: if the frame budget is blown consistently, step the tier down.
   * Only ever downgrades, and only once per direction, so quality never
   * oscillates mid-fight.
   */
  autoTune(dtMs) {
    this.frameStat.push(dtMs);
    if (!this.autoQuality || this._autoLocked) return null;
    this._autoTimer += dtMs;
    if (this._autoTimer < 2500 || this.frameStat.n < 60) return null;
    this._autoTimer = 0;
    const p90 = this.frameStat.percentile(0.9);
    if (p90 > 26 && this.quality === 'high') { this.quality = 'medium'; this.settings = QUALITY.medium; this.resize(this._w, this._h, true); return 'medium'; }
    if (p90 > 30 && this.quality === 'medium') { this.quality = 'low'; this.settings = QUALITY.low; this.resize(this._w, this._h, true); this._autoLocked = true; return 'low'; }
    return null;
  }

  get info() {
    const i = this.renderer.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      points: i.render.points,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0,
    };
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this._disposeTargets();
    this.brightMat.dispose(); this.blurMat.dispose(); this.compositeMat.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}

export const QUALITY_TIERS = QUALITY;
