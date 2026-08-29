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
import { globalUniforms } from './materials.js';

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
    // A shader that fails to link renders nothing but must not kill the frame
    // loop; three throws by default, so take the report and carry on.
    this.shaderErrors = [];
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const msg = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
        .filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
      if (this.shaderErrors.length < 12) this.shaderErrors.push(msg.slice(0, 240));
      console.error('[nova-lance] shader link failed:', msg);
    };

    this.hdrType = this._probeHalfFloat() ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.postEnabled = true;
    this.pipelineStage = this.hdrType === THREE.HalfFloatType ? 0 : 1;
    this.pipelineReason = this.pipelineStage ? 'no renderable half-float colour buffer' : '';

    this.quality = quality === 'auto' ? this._detectQuality() : quality;
    this.autoQuality = quality === 'auto';
    this.settings = QUALITY[this.quality] || QUALITY.medium;

    this._wdFrames = 0;
    this._wdBlack = 0;
    this._wdPixelsOK = false;
    this._wdDone = false;
    this.expectContent = false;   // set by the game once a run is on screen

    this._buildTargets(1, 1);
    this._buildPasses();

    this._onLost = (e) => { e.preventDefault(); this.contextLost = true; this._orphaned = true; };
    this._onRestored = () => {
      this.contextLost = false;
      // A restored context is a different GPU state; re-earn the HDR path.
      this._wdFrames = 0; this._wdBlack = 0; this._wdPixelsOK = false; this._wdDone = false;
      if (this.postEnabled) this.hdrType = this._probeHalfFloat() ? THREE.HalfFloatType : THREE.UnsignedByteType;
      this.resize(this._w, this._h, true);
    };
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

  /**
   * Half-float colour buffers carry the whole HDR chain, but a good number of
   * mobile GPUs expose WebGL2 without being able to *render* to RGBA16F —
   * `isWebGL2` answers a different question. Getting it wrong points every pass
   * at an incomplete framebuffer, which shows up as a black scene under a
   * perfectly healthy HUD. So: check the extension, then make the driver prove
   * it with a real framebuffer before trusting it.
   */
  _probeHalfFloat() {
    const gl = this.renderer.getContext();
    if (!gl) return false;
    // WebGL1 stays on 8-bit targets by choice: the devices that land there run
    // at the 'low' tier with bloom off, so HDR buys nothing but new failure modes.
    if (!this.isWebGL2) return false;
    let internal, type;
    try {
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
      internal = gl.RGBA16F; type = gl.HALF_FLOAT;
    } catch (e) { return false; }

    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    let ok = false;
    try {
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, type, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    } catch (e) {
      ok = false;
    }
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    } catch (e) { /* nothing left to clean up */ }
    this.renderer.resetState();   // we bound things behind three's back
    return ok;
  }

  /**
   * Test hook: re-arm the HDR path *without* the completeness check, so the
   * black-frame watchdog can be exercised on a driver that cannot render to
   * half-float. Not reachable from gameplay.
   */
  forceHDR() {
    this.hdrType = THREE.HalfFloatType;
    this.pipelineStage = 0;
    this.pipelineReason = '';
    this.postEnabled = true;
    globalUniforms.uOutput.value = 0;
    this._wdFrames = 0; this._wdBlack = 0; this._wdPixelsOK = false; this._wdDone = false;
    this._allocTargets(this._pw || 1, this._ph || 1);
  }

  /** Are the targets we just allocated actually renderable on this driver? */
  _targetsComplete() {
    const r = this.renderer, gl = r.getContext();
    if (!gl) return true;
    const prev = r.getRenderTarget();
    let ok = true;
    try {
      for (const k of ['sceneRT', 'brightRT']) {
        r.setRenderTarget(this[k]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { ok = false; break; }
      }
    } catch (e) { ok = false; }
    try { r.setRenderTarget(prev); } catch (e) { /* context is going away */ }
    return ok;
  }

  /**
   * Step the pipeline down one rung and say so. Stage 1 drops HDR targets for
   * plain RGBA8 (bloom clamps at white, everything else is identical); stage 2
   * abandons offscreen rendering entirely and draws straight to the canvas.
   * A duller frame is always better than a black one.
   */
  degrade(reason) {
    if (this.pipelineStage >= 2) return false;
    this._wdPixelsOK = false;   // the new rung has to prove itself too
    this.pipelineStage++;
    this.pipelineReason = reason;
    if (this.pipelineStage === 1) {
      this.hdrType = THREE.UnsignedByteType;
      this._buildTargets(this._pw || 1, this._ph || 1);
    } else {
      // No composite pass to tone map for us any more — the shaders take over.
      this.postEnabled = false;
      globalUniforms.uOutput.value = 1;
      this._disposeTargets();
    }
    console.warn(`[nova-lance] render pipeline stepped down to stage ${this.pipelineStage} — ${reason}`);
    return true;
  }

  /**
   * Drivers fail in ways no capability query admits to, and the failure mode is
   * the worst one available: a silent black screen. For the opening seconds we
   * ask the context whether it is actually managing to draw, and step down
   * until it is. The readback is a sync point, so it stops once frames are
   * clean — or once we run out of rungs.
   */
  watchdog() {
    if (this._wdDone || this.contextLost) return;
    const gl = this.renderer.getContext();
    if (!gl) { this._wdDone = true; return; }
    // Only gameplay frames count against the budget — a long sit on the menu
    // must not spend the watchdog before there is anything to look at.
    if (this.expectContent) this._wdFrames++;

    const err = gl.getError();
    // A lost context is not a capability problem — the lost/restored handlers
    // own it, and the restore re-probes from scratch. Stepping the pipeline
    // down here would punish a tab switch.
    if (err === gl.CONTEXT_LOST_WEBGL) return;
    if (err === gl.INVALID_FRAMEBUFFER_OPERATION || err === gl.OUT_OF_MEMORY) {
      this.degrade(`GL error 0x${err.toString(16)} while drawing`);
      this._wdBlack = 0;
    }

    // Every capability query can come back clean and the driver still write
    // nothing, so read back the frame we just produced and believe the pixels
    // over the API. Only while the game says there is something to see, and
    // only after several samples in a row, so a fade from black is not a bug.
    if (!this._wdPixelsOK && this.pipelineStage < 2 && this.expectContent
        && this._wdFrames >= 45 && this._wdFrames % 20 === 0) {
      const lum = this._sampleFrame();
      if (lum === 0) {
        if (++this._wdBlack >= 3) {
          this._wdBlack = 0;
          this.degrade('the frame came back black');
        }
      } else if (lum > 0) {
        // One good read is proof enough. readPixels stalls the GPU, so the
        // healthy path pays for exactly one of them per run. GL errors keep
        // being watched either way — they are free.
        this._wdBlack = 0;
        this._wdPixelsOK = true;
      }
    }

    if (this._wdFrames > 600) this._wdDone = true;
  }

  /**
   * Peak luminance of a small block at the centre of the frame just drawn.
   * Reads the default framebuffer inside the same task as the draw, so it works
   * without `preserveDrawingBuffer`. Returns -1 if the read is not possible.
   */
  _sampleFrame() {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (w < 32 || h < 32) return -1;
    const buf = this._wdBuf || (this._wdBuf = new Uint8Array(16 * 16 * 4));
    try {
      gl.readPixels((w >> 1) - 8, (h >> 1) - 8, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      if (gl.getError() !== gl.NO_ERROR) return -1;
    } catch (e) { return -1; }
    let max = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const l = buf[i] + buf[i + 1] + buf[i + 2];
      if (l > max) max = l;
    }
    return max;
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
    this._allocTargets(w, h);
    // Allocation succeeding is not the same as the driver being able to draw
    // into it; ask before we point a whole frame at it.
    if (this.hdrType !== THREE.UnsignedByteType && !this._targetsComplete()) {
      this.hdrType = THREE.UnsignedByteType;
      this.pipelineStage = Math.max(this.pipelineStage, 1);
      this.pipelineReason = 'half-float targets are not framebuffer-complete';
      console.warn(`[nova-lance] ${this.pipelineReason}; falling back to 8-bit targets`);
      this._allocTargets(w, h);
    }
  }

  _allocTargets(w, h) {
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
    if (this.postEnabled) this._buildTargets(pw, ph);
  }

  /** Full frame: scene into HDR target, bloom chain, composite to the canvas. */
  render(scene, camera, fx = null) {
    if (this.contextLost) return;
    const r = this.renderer;
    r.info.reset();

    if (!this.postEnabled) {
      // Last rung: no offscreen targets at all. three tone maps and encodes on
      // the way out, so the frame is flatter than the composite but honest.
      r.setRenderTarget(null);
      r.clear(true, true, false);
      r.render(scene, camera);
      this.watchdog();
      return;
    }

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
    this.watchdog();
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
      pipeline: this.pipelineStage,
      hdr: this.hdrType === THREE.HalfFloatType,
      shaderErrors: this.shaderErrors.length,
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
