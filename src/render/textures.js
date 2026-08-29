/**
 * textures.js — every pixel in NOVA LANCE is generated at load time.
 * No image files ship with the game; these builders paint into offscreen
 * canvases and hand back THREE textures.
 */
import { clamp01, RNG, TAU } from '../core/util.js';

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = opts.wrap || THREE.ClampToEdgeWrapping;
  t.minFilter = opts.min || THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = opts.mips !== false;
  t.anisotropy = opts.aniso || 1;
  if (opts.srgb !== false && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Deterministic 2D value noise, bilinearly interpolated — used for clouds/grunge. */
function valueNoise2D(rng, size) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const idx = (a, b) => g[((b % size) + size) % size * size + (((a % size) + size) % size)];
    const a = idx(xi, yi), b = idx(xi + 1, yi), c = idx(xi, yi + 1), d = idx(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

function fbm(noise, x, y, octaves = 5, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** Soft radial glow — the workhorse particle sprite. */
export function glowSprite(size = 128, inner = 'rgba(255,255,255,1)', power = 2.2) {
  return cached(`glow${size}${power}`, () => {
    const c = canvas(size, size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = Math.pow(clamp01(1 - d), power);
        const i = (y * size + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false });
  });
}

/** Hard-edged shard with a soft core — debris and sparks. */
export function shardSprite(size = 64) {
  return cached('shard', () => {
    const c = canvas(size, size), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(size / 2, 2); ctx.lineTo(size - 6, size / 2); ctx.lineTo(size / 2, size - 2); ctx.lineTo(6, size / 2);
    ctx.closePath(); ctx.fill();
    return toTexture(c, { srgb: false });
  });
}

/** Billowing smoke puff (noise-modulated radial falloff). */
export function smokeSprite(size = 128) {
  return cached('smoke', () => {
    const rng = new RNG(9182);
    const noise = valueNoise2D(rng, 16);
    const c = canvas(size, size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = fbm(noise, x / size * 5, y / size * 5, 4);
        let a = clamp01(1 - d) * (0.45 + n * 0.85);
        a = Math.pow(clamp01(a), 1.7);
        const i = (y * size + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false });
  });
}

/** Four-point anamorphic flare for pickups and big impacts. */
export function flareSprite(size = 128) {
  return cached('flare', () => {
    const c = canvas(size, size), ctx = c.getContext('2d');
    ctx.translate(size / 2, size / 2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.22);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      ctx.save();
      ctx.rotate(k * Math.PI / 2);
      const lg = ctx.createLinearGradient(-size / 2, 0, size / 2, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(-size / 2, -size * 0.012, size, size * 0.024);
      ctx.restore();
    }
    return toTexture(c, { srgb: false });
  });
}

/** Ground shadow blob — cheaper and more stylised than a shadow map. */
export function shadowSprite(size = 128) {
  return cached('shadow', () => {
    const c = canvas(size, size), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return toTexture(c, { srgb: false });
  });
}

/** Seamless tiling noise used by the floor and energy-field shaders. */
export function noiseTexture(size = 256) {
  return cached('noise', () => {
    const rng = new RNG(4242);
    const n1 = valueNoise2D(rng, 8);
    const n2 = valueNoise2D(rng, 32);
    const c = canvas(size, size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        img.data[i] = Math.round(fbm(n1, x / size * 8, y / size * 8, 4) * 255);
        img.data[i + 1] = Math.round(fbm(n2, x / size * 32, y / size * 32, 3) * 255);
        img.data[i + 2] = Math.round(n1(x / size * 8, y / size * 8) * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { wrap: THREE.RepeatWrapping, srgb: false });
  });
}

/**
 * Equirectangular sky: a desert dusk. Warm low sun near the horizon, banded
 * cloud lit from that side, indigo overhead, dust haze at the bottom. Baked
 * once, so the sky costs nothing per frame.
 */
export function skyTexture(w = 2048, h = 1024) {
  return cached('sky', () => {
    const rng = new RNG(20260828);
    const noise = valueNoise2D(rng, 24);
    const noise2 = valueNoise2D(rng, 12);
    const c = canvas(w, h), ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;

    const SUN_U = 0.30;          // where the sun sits around the horizon
    const SUN_V = 0.505;         // just below the horizon line: long shadows
    const mix = (a, b, t) => a + (b - a) * t;

    for (let y = 0; y < h; y++) {
      const v = y / h;
      // 0 at the horizon, 1 at the zenith
      const up = clamp01((0.5 - v) * 2);
      for (let x = 0; x < w; x++) {
        const u = x / w;
        // Sample noise on a circle in u so the map wraps without a seam.
        const ang = u * TAU;
        const cx = Math.cos(ang) * 2.6, cy = Math.sin(ang) * 2.6;

        // angular distance to the sun, wrapped
        let du = Math.abs(u - SUN_U);
        if (du > 0.5) du = 1 - du;
        const dv = v - SUN_V;
        const sunD = Math.sqrt(du * du * 4 + dv * dv * 3.2);

        // sky gradient: warm at the horizon, indigo overhead
        let r = mix(232, 38, Math.pow(up, 0.62));
        let g = mix(150, 58, Math.pow(up, 0.55));
        let b = mix(92, 104, Math.pow(up, 0.40));

        // the sun's own glow, and a broad warm wash along the horizon
        const glow = Math.exp(-sunD * 5.2);
        const wash = Math.exp(-Math.abs(dv) * 7.0) * (0.35 + 0.65 * Math.exp(-du * 3.0));
        r += glow * 210 + wash * 70;
        g += glow * 150 + wash * 38;
        b += glow * 72 + wash * 12;

        if (v < 0.5) {
          // cloud banding: stretched hard in v so it reads as layered strata
          const cloud = fbm(noise, cx + 8, cy * 0.35 + up * 5.2 + 8, 5, 2.1, 0.55);
          const cloud2 = fbm(noise2, cx * 1.7 + 21, cy * 0.5 + up * 8.0 + 15, 4, 2.0, 0.5);
          const band = Math.pow(clamp01(cloud * 1.25 - 0.30), 1.7) * (1 - up * 0.55);
          const wisp = Math.pow(clamp01(cloud2 * 1.1 - 0.44), 2.2) * (1 - up * 0.3);
          // lit from the sun side, shadowed away from it
          const lit = clamp01(0.25 + Math.exp(-du * 2.4) * 0.95);
          r += band * mix(52, 235, lit) + wisp * mix(30, 150, lit);
          g += band * mix(44, 158, lit) + wisp * mix(26, 96, lit);
          b += band * mix(58, 104, lit) + wisp * mix(38, 82, lit);
        } else {
          // below the horizon: dust, darkening downward
          const k = clamp01((v - 0.5) * 2.6);
          r = mix(r, 74, k); g = mix(g, 54, k); b = mix(b, 38, k);
        }

        const i = (y * w + x) * 4;
        d[i] = Math.min(255, r); d[i + 1] = Math.min(255, g); d[i + 2] = Math.min(255, b); d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // a handful of high circling birds, because an empty sky reads as a backdrop
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(28,22,20,0.5)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 14; i++) {
      const bx = rng.range(0.1, 0.9) * w, by = rng.range(0.10, 0.34) * h;
      const sc = rng.range(3, 7);
      ctx.beginPath();
      ctx.moveTo(bx - sc, by);
      ctx.quadraticCurveTo(bx - sc * 0.4, by - sc * 0.6, bx, by - sc * 0.1);
      ctx.quadraticCurveTo(bx + sc * 0.4, by - sc * 0.6, bx + sc, by);
      ctx.stroke();
    }
    return toTexture(c, { wrap: THREE.RepeatWrapping, mips: true });
  });
}

/** Burn mark left where something died: irregular, soot-dark, hot at the rim. */
export function scorchTexture(size = 128) {
  return cached('scorch', () => {
    const rng = new RNG(5150);
    const noise = valueNoise2D(rng, 12);
    const c = canvas(size, size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = fbm(noise, x / size * 4, y / size * 4, 4);
        const edge = clamp01(1 - d * (0.75 + n * 0.55));
        const a = Math.pow(edge, 1.5);
        const rim = Math.pow(clamp01(1 - Math.abs(d - 0.62) * 3.4), 2) * n;
        const i = (y * size + x) * 4;
        img.data[i] = Math.round(40 + rim * 215);
        img.data[i + 1] = Math.round(18 + rim * 90);
        img.data[i + 2] = Math.round(30 + rim * 120);
        img.data[i + 3] = Math.round(clamp01(a * (0.55 + n * 0.6)) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false });
  });
}

/** Swirling rift portal disc used by spawn portals and the void hazards. */
export function riftTexture(size = 256) {
  return cached('rift', () => {
    const rng = new RNG(77123);
    const noise = valueNoise2D(rng, 16);
    const c = canvas(size, size), ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ang = Math.atan2(dy, dx);
        const swirl = fbm(noise, Math.cos(ang + d * 3.2) * 2.4 + 4, Math.sin(ang + d * 3.2) * 2.4 + 4, 4);
        let a = clamp01(1 - d) * clamp01(swirl * 1.6 - 0.15);
        a = Math.pow(a, 1.25);
        const i = (y * size + x) * 4;
        img.data[i] = 200 + swirl * 55;
        img.data[i + 1] = 60 + swirl * 60;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(clamp01(a) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(c, { srgb: false });
  });
}

function cached(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

export function disposeTextures() {
  for (const t of cache.values()) { try { t.dispose(); } catch (e) { /* ignore */ } }
  cache.clear();
}

export const textureCache = cache;
