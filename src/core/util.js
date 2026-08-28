/**
 * util.js — math, random, pooling and formatting helpers.
 * Deliberately dependency-free so every other module can lean on it.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Frame-rate independent exponential smoothing. `smoothing` = fraction remaining after 1s. */
export const damp = (a, b, smoothing, dt) => lerp(a, b, 1 - Math.pow(smoothing, dt));
export const moveToward = (a, b, maxDelta) => {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + Math.sign(d) * maxDelta;
};
export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const dampAngle = (a, b, smoothing, dt) => a + wrapAngle(b - a) * (1 - Math.pow(smoothing, dt));

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeOutElastic = (t) => {
  if (t === 0 || t === 1) return t;
  const c4 = TAU / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

/** Deterministic, fast PRNG (mulberry32). Seedable so playtests can repeat a run. */
export class RNG {
  constructor(seed = (Math.random() * 0xffffffff) >>> 0) { this.seed(seed); }
  seed(s) { this._s = (s >>> 0) || 1; return this; }
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Box-Muller, cached second sample. */
  gaussian(mean = 0, sd = 1) {
    if (this._g !== undefined) { const g = this._g; this._g = undefined; return mean + g * sd; }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._g = r * Math.sin(TAU * v);
    return mean + r * Math.cos(TAU * v) * sd;
  }
  /** Weighted pick: items is [{weight}] or a parallel weights array. */
  weighted(items, weightOf = (it) => it.weight) {
    let total = 0;
    for (const it of items) total += Math.max(0, weightOf(it));
    if (total <= 0) return items[0];
    let r = this.next() * total;
    for (const it of items) { r -= Math.max(0, weightOf(it)); if (r <= 0) return it; }
    return items[items.length - 1];
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** Random point on unit circle -> {x, z} (gameplay plane is XZ). */
  onCircle(out = { x: 0, z: 0 }) {
    const a = this.next() * TAU;
    out.x = Math.cos(a); out.z = Math.sin(a);
    return out;
  }
}

/** Shared game-side RNG. Re-seeded per run so a seed reproduces a whole run. */
export const rng = new RNG();

/**
 * Fixed-capacity object pool. Zero allocation during play: every entity type
 * pre-builds its meshes once and recycles them.
 */
export class Pool {
  constructor(factory, capacity, reset = null) {
    this.items = new Array(capacity);
    this.free = new Array(capacity);
    this.active = [];
    this.reset = reset;
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      const it = factory(i);
      it.__poolIndex = i;
      it.__poolActive = false;
      this.items[i] = it;
      this.free[i] = it;
    }
  }
  get count() { return this.active.length; }
  acquire() {
    const it = this.free.pop();
    if (!it) return null;              // pool exhausted — caller decides what to do
    it.__poolActive = true;
    this.active.push(it);
    return it;
  }
  release(it) {
    if (!it.__poolActive) return;
    it.__poolActive = false;
    const i = this.active.indexOf(it);
    if (i >= 0) this.active.splice(i, 1);
    if (this.reset) this.reset(it);
    this.free.push(it);
  }
  releaseAll() {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(this.active[i]);
  }
  /** Iterate backwards so handlers can release the current item safely. */
  each(fn) {
    for (let i = this.active.length - 1; i >= 0; i--) fn(this.active[i], i);
  }
}

/** Rolling window used for frame-time statistics. */
export class RollingStat {
  constructor(size = 90) { this.buf = new Float32Array(size); this.i = 0; this.n = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.buf.length; if (this.n < this.buf.length) this.n++; }
  get avg() { let s = 0; for (let i = 0; i < this.n; i++) s += this.buf[i]; return this.n ? s / this.n : 0; }
  get max() { let m = 0; for (let i = 0; i < this.n; i++) m = Math.max(m, this.buf[i]); return m; }
  percentile(p) {
    if (!this.n) return 0;
    const a = Array.prototype.slice.call(this.buf, 0, this.n).sort((x, y) => x - y);
    return a[clamp(Math.floor(p * a.length), 0, a.length - 1)];
  }
  clear() { this.i = 0; this.n = 0; }
}

export const formatScore = (n) => Math.floor(n).toLocaleString('en-US');
export const formatTime = (sec) => {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
};
export const formatTimeMs = (sec) => {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${m}:${s < 10 ? '0' : ''}${s}.${cs < 10 ? '0' : ''}${cs}`;
};

/** Squared distance on the XZ plane — the only distance test the sim needs. */
export const dist2XZ = (a, b) => {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
};
export const lengthXZ = (x, z) => Math.sqrt(x * x + z * z);

/** True if a value went non-finite; used by the sim's NaN guards. */
export const isBadVec = (v) => !(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
