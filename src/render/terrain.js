/**
 * terrain.js — displaced landform geometry.
 *
 * Everything here exists because stacked primitives do not read as rock. A
 * cone is a cone at every angle; real stone has an eroded silhouette, strata
 * that wander, and darkness where it meets the ground. So these builders start
 * from a dense primitive, push every vertex along multi-octave noise, and bake
 * strata and occlusion into vertex colour before handing back one merged
 * geometry.
 *
 * Output matches the MeshBuilder convention — position / normal / aColor /
 * aEmit — so the standard material path lights it unchanged.
 */
import { clamp01, lerp, TAU } from '../core/util.js';
import { PALETTE } from './models.js';

/** Deterministic per-seed stream, so a given arena is always the same arena. */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Trilinear value noise. Cheap, and it only runs at load. */
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w);
}

function fbm3(x, y, z, octaves = 4, lac = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** Ridged noise: sharp crests, the shape erosion actually leaves behind. */
function ridge3(x, y, z, octaves = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(x * freq, y * freq, z * freq) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.07;
  }
  return sum / norm;
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Stepped stone profile. Sedimentary rock weathers into treads and risers, not
 * into a smooth cone; this returns `y` snapped toward the nearest bed, and the
 * difference between the two is what the builders push the surface out by.
 */
function bench(y, freq, hard = 0.62) {
  const t = y * freq;
  const i = Math.floor(t);
  let f = t - i;
  f = f < hard ? 0 : (f - hard) / (1 - hard);
  return (i + f * f * (3 - 2 * f)) / freq;
}

/**
 * Bands. Deliberately close in value and separated mostly by hue: high-contrast
 * bands read as painted stripes, which is worse than no bands at all.
 */
const STRATA = [0x6b4c3a, 0x7d5a42, 0x8a5c46, 0x6f5340, 0x87694c, 0x94765a, 0x745442];
const _bands = STRATA.map((h) => new THREE.Color(h));

/**
 * Sedimentary banding. The bands repeat up the face and wander sideways, which
 * is what makes a cliff read as layered rock instead of as a painted cone.
 */
function strataColor(x, y, z, spread, out, nscale = 1) {
  const freq = 0.34 / Math.max(0.25, spread * 0.16);
  // Two wanders at different scales: a slow tilt across the whole face, and a
  // faster one that pinches individual beds out. Without the second, the bands
  // stay parallel all the way round and the wall reads as wallpaper.
  // `nscale` maps a small object into the same noise scale a cliff sees, so a
  // boulder authored in unit space gets bands that vary across it rather than
  // one flat colour.
  const tilt = (fbm3(x * 0.055 * nscale, y * 0.02 * nscale, z * 0.055 * nscale, 2) - 0.5) * 4.5;
  const pinch = (fbm3(x * 0.30 * nscale, y * 0.09 * nscale, z * 0.30 * nscale, 3) - 0.5) * 1.7;
  const t = y * freq + tilt + pinch;
  const i = Math.floor(t);
  const f = t - i;
  const n = _bands.length;
  const a = _bands[((i % n) + n) % n];
  const b = _bands[(((i + 1) % n) + n) % n];
  // beds meet at a line rather than cross-fading, but the line is soft enough
  // not to stair-step across the triangles
  const k = f < 0.66 ? 0 : (f - 0.66) / 0.34;
  out.copy(a).lerp(b, k * k * (3 - 2 * k));
  // a fine grain break-up so no two neighbouring faces match exactly
  const g = 0.80 + fbm3(x * 2.6 * Math.min(nscale, 4), y * 2.6 * Math.min(nscale, 4), z * 2.6 * Math.min(nscale, 4), 2) * 0.40;
  out.multiplyScalar(g);
  return out;
}

/**
 * Weld duplicate vertices. three's IcosahedronGeometry is non-indexed, and
 * displacing it unwelded gives a faceted rock; welding first means
 * computeVertexNormals can smooth across faces afterwards.
 */
function weld(geo, precision = 1e-4) {
  const p = geo.attributes.position;
  const inv = 1 / precision;
  const map = new Map();
  const verts = [];
  const idx = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let at = map.get(key);
    if (at === undefined) {
      at = verts.length / 3;
      map.set(key, at);
      verts.push(x, y, z);
    }
    idx[i] = at;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(idx);
  geo.dispose();
  return out;
}

/**
 * A tapered tube swept along a spine. This is what replaces stacked cones for
 * anything organic: the surface is continuous, so limbs bend and join instead
 * of telescoping. `rib` flutes the cross-section — saguaros are ribbed, and it
 * is the single detail that sells the silhouette.
 */
function sweep(spine, radii, sides = 8, rib = 0) {
  const verts = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const alt = new THREE.Vector3(1, 0, 0);
  const tan = new THREE.Vector3(), nx = new THREE.Vector3(), nz = new THREE.Vector3();
  for (let i = 0; i < spine.length; i++) {
    const cur = spine[i];
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(spine.length - 1, i + 1)];
    tan.subVectors(next, prev);
    if (tan.lengthSq() < 1e-9) tan.copy(up);
    tan.normalize();
    // a stable frame: any axis not parallel to the tangent will do here
    nx.crossVectors(Math.abs(tan.y) > 0.95 ? alt : up, tan).normalize();
    nz.crossVectors(tan, nx).normalize();
    const r = radii[i];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU;
      const flute = 1 - rib * (0.5 - 0.5 * Math.cos(a * sides));
      const rr = r * flute;
      verts.push(
        cur.x + (nx.x * Math.cos(a) + nz.x * Math.sin(a)) * rr,
        cur.y + (nx.y * Math.cos(a) + nz.y * Math.sin(a)) * rr,
        cur.z + (nx.z * Math.cos(a) + nz.z * Math.sin(a)) * rr);
    }
  }
  for (let i = 0; i < spine.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = i * sides + s, b = i * sides + s2;
      const c = (i + 1) * sides + s, d = (i + 1) * sides + s2;
      idx.push(a, c, b, b, c, d);
    }
  }
  // cap the tip so branches end in a point rather than an open pipe
  const tipAt = verts.length / 3;
  const tip = spine[spine.length - 1];
  verts.push(tip.x, tip.y, tip.z);
  const base = (spine.length - 1) * sides;
  for (let s = 0; s < sides; s++) idx.push(base + s, base + ((s + 1) % sides), tipAt);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Paint a finished geometry a flat colour with a height-based occlusion ramp. */
function paint(geo, hex, opts = {}) {
  const p = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = p.count;
  const col = new Float32Array(n * 3);
  const emi = new Float32Array(n);
  const c = new THREE.Color();
  const base = new THREE.Color(hex);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const y = p.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = Math.max(0.001, maxY - minY);
  const floor = opts.floor === undefined ? 0.42 : opts.floor;
  const grain = opts.grain === undefined ? 0.16 : opts.grain;
  for (let i = 0; i < n; i++) {
    const h = (p.getY(i) - minY) / span;
    const up = nrm ? nrm.getY(i) * 0.5 + 0.5 : 1;
    c.copy(base);
    if (opts.tip !== undefined) c.lerp(_c2.setHex(opts.tip), h * h);
    const g = 1 - grain * 0.5 + fbm3(p.getX(i) * 3.1, p.getY(i) * 3.1, p.getZ(i) * 3.1, 2) * grain;
    c.multiplyScalar(clamp01(floor + h * (1 - floor)) * clamp01(0.6 + up * 0.55) * g);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    emi[i] = 0;
  }
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(emi, 1));
  return geo;
}

/**
 * One eroded boulder or spire. Starts as a dense icosphere, pushes every vertex
 * out along fbm plus a ridged term, squashes it, and cuts the underside flat so
 * it sits in the ground instead of resting on it.
 */
export function buildRock(seed = 1, opts = {}) {
  const rnd = mulberry(seed);
  // Detail 4 is 2562 vertices — the mesh has to be able to *represent* the
  // noise it is displaced by, or the high frequencies alias into a smooth
  // ovoid. That aliasing is exactly what makes procedural rock look like a
  // potato, so the noise below stops at frequencies this density can hold.
  const detail = opts.detail === undefined ? 4 : opts.detail;
  const geo = weld(new THREE.IcosahedronGeometry(1, detail));
  const pos = geo.attributes.position;
  const n = pos.count;

  const ox = rnd() * 90, oy = rnd() * 90, oz = rnd() * 90;
  const rough = opts.rough === undefined ? 0.42 : opts.rough;
  const tall = opts.tall === undefined ? 1.0 : opts.tall;
  const wide = opts.wide === undefined ? 1.0 : opts.wide;
  const lean = (rnd() - 0.5) * 0.32;
  // bedding planes: how many ledges run around the body
  const beds = opts.beds === undefined ? 3.0 + rnd() * 3.5 : opts.beds;
  const ledge = opts.ledge === undefined ? 0.34 : opts.ledge;

  // Fracture planes. Stone breaks along flat faces with hard edges between
  // them; noise alone only ever produces blobs. Slicing the displaced body
  // against a handful of planes is what buys an angular silhouette.
  const cuts = opts.cuts === undefined ? 6 + Math.floor(rnd() * 4) : opts.cuts;
  const planes = [];
  for (let k = 0; k < cuts; k++) {
    const u = rnd() * 2 - 1, th = rnd() * TAU, sr = Math.sqrt(1 - u * u);
    // biased away from straight up, so cuts read as cliff faces not as a lid
    planes.push({
      nx: sr * Math.cos(th), ny: u * 0.55, nz: sr * Math.sin(th),
      d: 0.52 + rnd() * 0.34,
    });
  }

  const v = new THREE.Vector3();
  const rs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x, ny = v.y, nz = v.z;
    // broad mass, then a ridged crest term for spurs, then mild chipping
    const broad = fbm3(nx * 1.4 + ox, ny * 1.4 + oy, nz * 1.4 + oz, 3) - 0.5;
    let crest = ridge3(nx * 2.6 + ox, ny * 1.2 + oy, nz * 2.6 + oz, 2);
    crest = crest * crest - 0.30;  // squared: crests stay, mush goes
    const chip = fbm3(nx * 4.6 + ox, ny * 4.6 + oy, nz * 4.6 + oz, 2) - 0.5;
    // horizontal ledges, strongest on the flanks and gone at the poles
    const flank = 1 - ny * ny;
    const step = (ny - bench(ny, beds)) * beds * ledge * flank;
    const r = 1 + broad * rough * 1.5 + crest * rough * 1.4 + chip * rough * 0.5 + step;

    rs[i] = r;
    v.set(nx * r * wide, ny * r * tall, nz * r * wide);
    // shear so it does not stand perfectly upright
    v.x += v.y * lean;
    for (const P of planes) {
      const t = v.x * P.nx + v.y * P.ny + v.z * P.nz - P.d * (tall + wide) * 0.5;
      if (t > 0) { v.x -= P.nx * t; v.y -= P.ny * t; v.z -= P.nz * t; }
    }
    // a flat bottom, so it sits in the ground on a face instead of on a point
    if (v.y < -0.12 * tall) v.y = -0.12 * tall;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  // ---- vertex colour: strata + baked occlusion ----
  const nrm = geo.attributes.normal;
  const col = new Float32Array(n * 3);
  const emi = new Float32Array(n);
  const c = new THREE.Color();
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = Math.max(0.001, maxY - minY);
  let rMean = 0;
  for (let i = 0; i < n; i++) rMean += rs[i];
  rMean /= n;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    strataColor(x, y, z, tall, c, 14);
    // Occlusion, baked. Three terms: low ground contact, downward-facing
    // surfaces, and cavities — the clefts between crests, which the sun cannot
    // be relied on to shade because it only ever lights one side.
    const h = (y - minY) / span;
    const up = nrm.getY(i) * 0.5 + 0.5;
    const cavity = clamp01((rMean - rs[i]) / (rough * 0.9));
    // rises from a dark, contact-shadowed foot and then flattens off, so the
    // crown catches light without washing to white
    const ao = clamp01(0.24 + Math.sqrt(h) * 0.66) * clamp01(0.50 + up * 0.55) * (1 - cavity * 0.45);
    c.multiplyScalar(ao);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    emi[i] = 0;
  }
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(emi, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.name = 'rock-' + seed;
  return geo;
}

/**
 * The arena floor. A polar grid rather than a disc: rings are dense near the
 * middle where the camera lives and coarsen outward, and the whole thing gets
 * a gentle undulation. Displacement stays tiny inside the play radius — the
 * simulation treats the ground as y=0 and entities would float otherwise.
 */
export function buildGround(playRadius = 46, outerRadius = 150) {
  const rings = 96, segs = 128;
  const verts = [], cols = [], emis = [], idx = [];
  const c = new THREE.Color();
  // Deliberately mid-dark. The floor fills most of the frame, so its value sets
  // the exposure of the whole scene; a pale floor washes everything else out.
  const sand = new THREE.Color(PALETTE.clay);
  const dirt = new THREE.Color(PALETTE.dirt);

  const heightAt = (x, z, rad) => {
    // inside the arena: barely anything, so gameplay stays flat
    const inner = fbm3(x * 0.035, 0.5, z * 0.035, 3) - 0.5;
    let h = inner * 0.45;
    // beyond the play area the ground lifts into the canyon's base
    const out = clamp01((rad - playRadius * 0.92) / 26);
    h += out * out * 9.5 * (0.55 + fbm3(x * 0.02, 3.1, z * 0.02, 3) * 0.9);
    // dry washes cut across the flats
    const wash = ridge3(x * 0.017, 7.7, z * 0.017, 3);
    h -= clamp01(1 - out) * wash * 0.5;
    return h;
  };

  for (let r = 0; r <= rings; r++) {
    // squared distribution: fine near the player, coarse at the horizon
    const t = r / rings;
    const rad = Math.pow(t, 1.9) * outerRadius;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * TAU;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const y = heightAt(x, z, rad);
      verts.push(x, y, z);
      // Patchy at three scales: broad drifts, mid blotching, fine grain. Even
      // spacing at one scale is the tell that a surface is procedural.
      const tone = clamp01(0.5 + (fbm3(x * 0.02, 1.7, z * 0.02, 3) - 0.5) * 2.2);
      const blotch = fbm3(x * 0.09, 5.1, z * 0.09, 3);
      c.copy(dirt).lerp(sand, clamp01(tone * 0.7 + blotch * 0.5));
      // wash bottoms stay damp-dark, and the ground darkens into the canyon
      const wash2 = ridge3(x * 0.017, 7.7, z * 0.017, 3);
      const ao = clamp01(1 - clamp01((rad - playRadius * 0.8) / 34) * 0.5) * (1 - wash2 * 0.28);
      c.multiplyScalar(ao * (0.86 + fbm3(x * 0.5, 2.3, z * 0.5, 2) * 0.28));
      cols.push(c.r, c.g, c.b);
      emis.push(0);
    }
  }
  const row = segs + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * row + s, b = a + 1, d = a + row, e = d + 1;
      // winding matters: (a,b,d) is the order whose face normal points up
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3));
  geo.setAttribute('aEmit', new THREE.Float32BufferAttribute(emis, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.name = 'ground';
  return geo;
}

/**
 * The canyon. One continuous displaced cylinder rather than a ring of blocks,
 * and the displacement is where the whole read lives: narrow gullies cut down
 * the face, broad buttresses push out between them, and bedding planes step the
 * profile so the wall has benches instead of being a smooth curtain.
 */
export function buildCanyon(radius = 46, seed = 7) {
  const segs = 300, rows = 48;
  const verts = [], cols = [], emis = [], idx = [];
  const c = new THREE.Color();
  const rnd = mulberry(seed);
  const ox = rnd() * 50, oz = rnd() * 50;

  // Noise-space radius sets how many features fit around the ring: the
  // circumference in noise cells is TAU*R, so R=4.6 gives ~29 gullies.
  const GULLY_R = 4.6, BUTTRESS_R = 1.2, ALCOVE_R = 0.55;

  const topAt = (ca, sa) =>
    17 + fbm3(ca * 2.0 + ox, 0.0, sa * 2.0 + oz, 4) * 30
       + ridge3(ca * 5.5 + ox, 1.0, sa * 5.5 + oz, 3) * 9;

  const row = segs + 1;
  const rads = new Float32Array(row * (rows + 1));
  const ys = new Float32Array(row * (rows + 1));
  const gullies = new Float32Array(row * (rows + 1));

  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const top = topAt(ca, sa);
      const y = -3 + Math.pow(t, 1.22) * (top + 3);

      // Alcoves and promontories: the largest scale, and the one that stops
      // the wall reading as a funnel. Whole sections stand proud or recede.
      const alcove = (fbm3(ca * ALCOVE_R + ox, y * 0.012, sa * ALCOVE_R + oz, 2) - 0.5) * 2.2;
      // narrow gullies, deepest where the wall is tallest and fading out at
      // the foot where debris has filled them in
      const g = ridge3(ca * GULLY_R + ox, y * 0.045, sa * GULLY_R + oz, 4);
      const gully = Math.pow(g, 1.7) * (0.25 + t * 1.15);
      const buttress = fbm3(ca * BUTTRESS_R + ox, y * 0.03, sa * BUTTRESS_R + oz, 3) - 0.5;
      // Bedding planes. The frequency has to drift around the ring, or every
      // shelf lines up into a perfect contour and the wall becomes a layer cake.
      const bedFreq = 0.135 * (0.7 + fbm3(ca * 0.9 + ox, 0.0, sa * 0.9 + oz, 2) * 0.75);
      const bedPhase = fbm3(ca * 1.7 + oz, 0.0, sa * 1.7 + ox, 2) * 6.0;
      const step = ((y + bedPhase) - bench(y + bedPhase, bedFreq)) * bedFreq * 7.0;
      // fine erosion so no facet is flat at close range
      const grit = fbm3(ca * 16 + ox, y * 0.55, sa * 16 + oz, 2) - 0.5;
      // the face leans back as it rises, like a real weathered cliff
      let rad = radius + 4.5 + t * 8.0 + alcove * 6.0 + buttress * 9.0 + step + grit * 1.4;
      // Gullies are cut with a soft minimum rather than subtracted outright:
      // the play area is clamped to `radius`, so a gully deep enough to reach
      // past it would let the player fly inside solid rock.
      const room = Math.max(0.001, rad - (radius + 1.5));
      rad -= room * (1 - Math.exp(-(gully * 13.0) / room));

      const at = r * row + s;
      rads[at] = rad; ys[at] = y; gullies[at] = gully;
      verts.push(ca * rad, y, sa * rad);
    }
  }

  // ---- baked cavity occlusion ----
  // A gully is only readable if it is darker than the buttress beside it, and
  // the sun cannot be relied on for that: it lights one side of the ring and
  // leaves the rest to flat ambient. So compare each point's radius against a
  // local average and darken whatever sits behind it. This is the single thing
  // that makes the relief legible from inside the arena.
  const WS = 7, WR = 3;
  for (let r = 0; r <= rows; r++) {
    for (let s = 0; s <= segs; s++) {
      const at = r * row + s;
      let sum = 0, cnt = 0;
      for (let dr = -WR; dr <= WR; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr > rows) continue;
        for (let ds = -WS; ds <= WS; ds++) {
          // the ring wraps, so the window wraps with it
          const ss = ((s + ds) % segs + segs) % segs;
          sum += rads[rr * row + ss]; cnt++;
        }
      }
      const local = sum / cnt;
      // negative = recessed into the wall
      const cavity = clamp01((local - rads[at]) / 7.0);
      const t = r / rows;
      const y = ys[at];
      const x = Math.cos((s / segs) * TAU) * rads[at];
      const z = Math.sin((s / segs) * TAU) * rads[at];

      strataColor(x, y, z, 15, c);
      // dark at the foot, dark in cavities; the crown catches light but is
      // capped, or the skyline dissolves into the haze
      const ao = clamp01(0.26 + Math.sqrt(t) * 0.62)
               * (1 - cavity * 0.62)
               * clamp01(0.97 - gullies[at] * 0.30);
      c.multiplyScalar(Math.min(ao, 0.80));
      cols.push(c.r, c.g, c.b);
      emis.push(0);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * row + s, b = a + 1, d = a + row, e = d + 1;
      // (a,b,d) is the order whose face normal points into the arena
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3));
  geo.setAttribute('aEmit', new THREE.Float32BufferAttribute(emis, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.name = 'canyon';
  return geo;
}

/** Distant flat-topped mesas. Same erosion, coarser, and mostly eaten by haze. */
export function buildMesaBelt(seed = 21) {
  const rnd = mulberry(seed);
  const parts = [];
  for (let i = 0; i < 30; i++) {
    const geo = buildRock(seed * 31 + i, {
      detail: 2,
      rough: 0.30,
      tall: 0.42 + rnd() * 0.5,
      wide: 1.0,
    });
    const a = rnd() * TAU;
    const r = 150 + rnd() * 230;
    const s = 26 + rnd() * 46;
    geo.scale(s, s * (0.5 + rnd() * 0.55), s * (0.7 + rnd() * 0.6));
    geo.rotateY(rnd() * TAU);
    geo.translate(Math.cos(a) * r, -3, Math.sin(a) * r);
    parts.push(geo);
  }
  const merged = mergeGeometries(parts);
  merged.name = 'mesas';
  return merged;
}

/** Minimal merge — three's BufferGeometryUtils is an addon, absent from UMD. */
export function mergeGeometries(list) {
  let vCount = 0, iCount = 0;
  for (const g of list) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const emi = new Float32Array(vCount);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, nn = g.attributes.normal;
    const cc = g.attributes.aColor, ee = g.attributes.aEmit;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      nrm[(vo + i) * 3] = nn.getX(i); nrm[(vo + i) * 3 + 1] = nn.getY(i); nrm[(vo + i) * 3 + 2] = nn.getZ(i);
      col[(vo + i) * 3] = cc.getX(i); col[(vo + i) * 3 + 1] = cc.getY(i); col[(vo + i) * 3 + 2] = cc.getZ(i);
      emi[vo + i] = ee.getX(i);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
    else for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
    io += g.index ? g.index.count : p.count;
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aEmit', new THREE.BufferAttribute(emi, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * A dead desert tree. Grown, not stacked: a recursive spine walker bends a
 * tapering tube through space and forks it, so every limb is a continuous
 * surface that flows out of its parent.
 */
export function buildBranchTree(seed = 0) {
  const rnd = mulberry(seed * 977 + 13);
  const parts = [];
  const h = 4.6 + rnd() * 2.6;

  const grow = (from, dir, len, rad, depth) => {
    const steps = depth === 0 ? 7 : 5;
    const spine = [from.clone()];
    const radii = [rad];
    const d = dir.clone().normalize();
    const cur = from.clone();
    // gravity plus a wandering bias: straight limbs read as pipes
    const bend = new THREE.Vector3((rnd() - 0.5) * 0.5, -0.16 - rnd() * 0.2, (rnd() - 0.5) * 0.5);
    for (let i = 1; i <= steps; i++) {
      d.addScaledVector(bend, 1 / steps).normalize();
      cur.addScaledVector(d, len / steps);
      spine.push(cur.clone());
      radii.push(rad * Math.pow(1 - i / (steps + 1.35), 0.85));
    }
    parts.push(sweep(spine, radii, depth === 0 ? 9 : 6));
    if (depth >= 2 || len < 0.7) return;
    const forks = depth === 0 ? 3 : (rnd() < 0.62 ? 2 : 1);
    for (let f = 0; f < forks; f++) {
      // fork from partway up the parent, not from its tip, so the crown fills
      const at = Math.floor(steps * (0.45 + rnd() * 0.5));
      const a = (f / forks) * TAU + rnd() * 1.4;
      const out = new THREE.Vector3(Math.cos(a), 0.55 + rnd() * 0.7, Math.sin(a)).normalize();
      out.lerp(d, 0.34).normalize();
      grow(spine[Math.min(at, spine.length - 1)], out, len * (0.52 + rnd() * 0.22), radii[at] * 0.74, depth + 1);
    }
  };

  grow(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((rnd() - 0.5) * 0.3, 1, (rnd() - 0.5) * 0.3), h, 0.34 + rnd() * 0.12, 0);
  for (const g of parts) paint(g, PALETTE.timberDark, { tip: PALETTE.timber, floor: 0.5, grain: 0.22 });
  // a small root flare so the trunk enters the ground instead of stopping at it
  const flare = buildRock(seed * 5 + 3, { detail: 1, rough: 0.5, tall: 0.35, wide: 1.0 });
  flare.scale(0.95, 0.55, 0.95);
  flare.translate(0, -0.05, 0);
  parts.push(flare);

  const geo = mergeGeometries(parts);
  geo.name = 'dead-tree';
  return { geometry: geo, radius: 0.7, height: h };
}

/**
 * Saguaro. Ribbed swept tubes with rounded crowns — the flutes are what make a
 * cactus read as a cactus rather than as a green cylinder.
 */
export function buildSaguaro(seed = 0) {
  const rnd = mulberry(seed * 613 + 41);
  const parts = [];
  const h = 3.4 + rnd() * 2.4;

  const limb = (from, dir, len, rad) => {
    const steps = 8;
    const spine = [from.clone()];
    const radii = [rad * 0.82];
    const d = dir.clone().normalize();
    const cur = from.clone();
    // arms sweep from horizontal to vertical, which is the saguaro signature
    const curl = new THREE.Vector3(-d.x * 0.5, 0.75, -d.z * 0.5);
    for (let i = 1; i <= steps; i++) {
      d.addScaledVector(curl, 1.15 / steps).normalize();
      cur.addScaledVector(d, len / steps);
      spine.push(cur.clone());
      // full width most of the way, then a domed tip
      radii.push(rad * (i > steps - 2 ? 0.62 : 1) * (i === steps ? 0.42 : 1));
    }
    parts.push(sweep(spine, radii, 12, 0.30));
  };

  limb(new THREE.Vector3(0, -0.25, 0), new THREE.Vector3((rnd() - 0.5) * 0.12, 1, (rnd() - 0.5) * 0.12), h, 0.44);
  const arms = 1 + Math.floor(rnd() * 2.4);
  for (let i = 0; i < arms; i++) {
    const a = rnd() * TAU;
    const y = h * (0.34 + rnd() * 0.26);
    limb(new THREE.Vector3(Math.cos(a) * 0.28, y, Math.sin(a) * 0.28),
      new THREE.Vector3(Math.cos(a), 0.22, Math.sin(a)), 1.1 + rnd() * 0.9, 0.26);
  }
  for (const g of parts) paint(g, PALETTE.scrub, { tip: PALETTE.sage, floor: 0.62, grain: 0.14 });
  const geo = mergeGeometries(parts);
  geo.name = 'saguaro';
  return { geometry: geo, radius: 0.8, height: h };
}

/** A tuft of dry brush: a few splayed, tapering stems off one crown. */
export function buildScrub(seed = 0) {
  const rnd = mulberry(seed * 311 + 7);
  const parts = [];
  const stems = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * TAU + rnd() * 0.6;
    const tilt = 0.5 + rnd() * 0.7;
    const len = 0.5 + rnd() * 0.55;
    const spine = [], radii = [];
    const steps = 4;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      // arcs outward then flops over, the way dead brush actually sits
      spine.push(new THREE.Vector3(
        Math.cos(a) * tilt * len * t * 1.5,
        len * (t * 1.5 - t * t * 0.85),
        Math.sin(a) * tilt * len * t * 1.5));
      radii.push(0.05 * (1 - t * 0.8));
    }
    parts.push(sweep(spine, radii, 4));
  }
  for (const g of parts) paint(g, PALETTE.sage, { tip: PALETTE.cloth, floor: 0.55, grain: 0.3 });
  const geo = mergeGeometries(parts);
  geo.name = 'scrub';
  return geo;
}

/** A single loose stone for the scatter layer. Cheap: one instanced geometry. */
export function buildPebble(seed = 0) {
  return buildRock(seed * 97 + 5, { detail: 1, rough: 0.5, tall: 0.62 + (seed % 3) * 0.12, wide: 1 });
}
