/**
 * models.js — every mesh in the game is assembled here from parametric
 * primitives, merged down to a single non-indexed BufferGeometry per model so
 * each entity costs exactly one draw call.
 *
 * Two custom attributes ride along with position/normal:
 *   aColor : vec3  per-vertex albedo (lets one material paint a whole model)
 *   aEmit  : float per-vertex emissive strength (the neon)
 */
import { TAU } from '../core/util.js';

export const PALETTE = {
  hullDark: 0x1a2440,
  hullMid: 0x36486e,
  hullLite: 0x7793c2,
  hullWhite: 0xc3d6f2,
  cyan: 0x46e6ff,
  cyanDeep: 0x1c8fb5,
  magenta: 0xff3ea5,
  amber: 0xffb347,
  lime: 0x7dff9e,
  violet: 0xa06bff,
  voidDark: 0x241a42,
  voidMid: 0x3d2a68,
  voidLite: 0x6a49ab,
  rust: 0x6b3a2a,
  bone: 0xd8cfc0,
};

/** Accumulates transformed primitives into one flat geometry. */
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.emi = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /**
   * add(geometry, { pos:[x,y,z], rot:[x,y,z], scale:number|[x,y,z],
   *                 color:hex, emit:number, flat:boolean })
   */
  add(geo, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    const p = o.pos || [0, 0, 0];
    const r = o.rot || [0, 0, 0];
    let s = o.scale === undefined ? 1 : o.scale;
    if (typeof s === 'number') s = [s, s, s];
    this._e.set(r[0], r[1], r[2]);
    this._q.setFromEuler(this._e);
    this._v.set(p[0], p[1], p[2]);
    this._s.set(s[0], s[1], s[2]);
    this._m.compose(this._v, this._q, this._s);
    g.applyMatrix4(this._m);
    if (o.flat !== false) g.computeVertexNormals();

    const posAttr = g.getAttribute('position');
    const nrmAttr = g.getAttribute('normal');
    const n = posAttr.count;
    // Color.set() already lands in the renderer's linear working space
    // (ColorManagement is on by default), so these components are used as-is.
    this._c.set(o.color === undefined ? 0xffffff : o.color);
    const emit = o.emit === undefined ? 0 : o.emit;
    const lr = this._c.r, lg = this._c.g, lb = this._c.b;
    for (let i = 0; i < n; i++) {
      this.pos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      this.nrm.push(nrmAttr.getX(i), nrmAttr.getY(i), nrmAttr.getZ(i));
      this.col.push(lr, lg, lb);
      this.emi.push(emit);
    }
    g.dispose();
    return this;
  }

  /** Convenience: mirror the last-added part across X (wings, nacelles, legs). */
  addMirrored(geo, o = {}) {
    this.add(geo, o);
    const p = (o.pos || [0, 0, 0]).slice();
    const r = (o.rot || [0, 0, 0]).slice();
    p[0] = -p[0];
    r[1] = -r[1];
    r[2] = -r[2];
    this.add(geo, { ...o, pos: p, rot: r });
    return this;
  }

  /**
   * build(name, faceZ)
   * Parts are authored with the nose toward -Z because that reads naturally
   * while sketching; three.js points objects along +Z, so any model that has a
   * facing direction is spun 180 degrees here, once, at build time.
   */
  build(name = 'model', faceZ = false) {
    if (faceZ) {
      const c = Math.cos(Math.PI), s = Math.sin(Math.PI);
      for (let i = 0; i < this.pos.length; i += 3) {
        const x = this.pos[i], z = this.pos[i + 2];
        this.pos[i] = x * c + z * s;
        this.pos[i + 2] = -x * s + z * c;
        const nx = this.nrm[i], nz = this.nrm[i + 2];
        this.nrm[i] = nx * c + nz * s;
        this.nrm[i + 2] = -nx * s + nz * c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emi, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.name = name;
    return g;
  }
}

// Shared primitive instances — built once, cloned by the builder as needed.
const P = {};
function prim(key, make) { if (!P[key]) P[key] = make(); return P[key]; }
const box = () => prim('box', () => new THREE.BoxGeometry(1, 1, 1));
const cyl = (seg) => prim('cyl' + seg, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1));
const cone = (seg) => prim('cone' + seg, () => new THREE.ConeGeometry(0.5, 1, seg, 1));
const sph = (w, h) => prim(`sph${w}_${h}`, () => new THREE.SphereGeometry(0.5, w, h));
const ico = (d) => prim('ico' + d, () => new THREE.IcosahedronGeometry(0.5, d));
const oct = (d) => prim('oct' + d, () => new THREE.OctahedronGeometry(0.5, d));
const tet = () => prim('tet', () => new THREE.TetrahedronGeometry(0.5));
const tor = (r, t, rs, ts) => prim(`tor${r}_${t}_${rs}_${ts}`, () => new THREE.TorusGeometry(r, t, rs, ts));
const tap = (rt, rb, seg) => prim(`tap${rt}_${rb}_${seg}`, () => new THREE.CylinderGeometry(rt, rb, 1, seg, 1));

/** Wedge/prism used all over the ship hulls (a box with a tapered nose). */
function wedgeGeometry(w, h, l, noseScale = 0.25) {
  const hw = w / 2, hh = h / 2, hl = l / 2, n = noseScale;
  const v = [
    [-hw, -hh, hl], [hw, -hh, hl], [hw, hh, hl], [-hw, hh, hl],           // tail face
    [-hw * n, -hh * n, -hl], [hw * n, -hh * n, -hl], [hw * n, hh * n, -hl], [-hw * n, hh * n, -hl], // nose face
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3],
    [5, 4, 7], [5, 7, 6],
    [1, 5, 6], [1, 6, 2],
    [4, 0, 3], [4, 3, 7],
    [3, 2, 6], [3, 6, 7],
    [4, 5, 1], [4, 1, 0],
  ];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(v[i][0], v[i][1], v[i][2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Long tapered spike (horns, antennae, boss spines). */
function spikeGeometry(len, base, sides = 4) {
  const g = new THREE.ConeGeometry(base, len, sides, 1);
  return g;
}

// ======================================================================
//  PLAYER CHASSIS
// ======================================================================
/**
 * Ships share a construction grammar (fuselage + canopy + wings + nacelles +
 * hover pads) with per-chassis proportions, so all three read as one fleet.
 */
export function buildShip(kind = 'striker') {
  const b = new MeshBuilder();
  const dark = PALETTE.hullDark, mid = PALETTE.hullMid, lite = PALETTE.hullLite;

  const spec = {
    striker: { len: 3.0, wid: 1.05, hei: 0.62, wing: 1.35, sweep: 0.55, nac: 2, glow: PALETTE.cyan },
    bastion: { len: 2.9, wid: 1.5, hei: 0.86, wing: 1.15, sweep: 0.28, nac: 1, glow: 0x63b4ff },
    phantom: { len: 3.35, wid: 0.82, hei: 0.5, wing: 1.5, sweep: 0.85, nac: 3, glow: 0xc98bff },
  }[kind] || {};

  // --- fuselage ---
  b.add(wedgeGeometry(spec.wid, spec.hei, spec.len, 0.22), { pos: [0, 0, -0.1], color: mid });
  b.add(wedgeGeometry(spec.wid * 0.72, spec.hei * 0.55, spec.len * 0.55, 0.5), { pos: [0, spec.hei * 0.42, -spec.len * 0.1], color: lite });
  // canopy
  b.add(sph(8, 6), {
    pos: [0, spec.hei * 0.55, -spec.len * 0.16],
    scale: [spec.wid * 0.44, spec.hei * 0.5, spec.len * 0.3],
    color: spec.glow, emit: 1.5, flat: false,
  });
  // nose lance emitter
  b.add(cyl(6), { pos: [0, 0, -spec.len * 0.52], rot: [Math.PI / 2, 0, 0], scale: [0.20, 0.55, 0.20], color: PALETTE.hullWhite });
  b.add(cyl(6), { pos: [0, 0, -spec.len * 0.72], rot: [Math.PI / 2, 0, 0], scale: [0.12, 0.4, 0.12], color: spec.glow, emit: 2.6 });

  // --- wings ---
  const wingLen = spec.wing;
  b.addMirrored(wedgeGeometry(wingLen, 0.13, 1.5, 0.55), {
    pos: [spec.wid * 0.5 + wingLen * 0.42, -0.02, spec.len * 0.06],
    rot: [0, -spec.sweep * 0.55, -0.16],
    color: mid,
  });
  b.addMirrored(box(), {
    pos: [spec.wid * 0.5 + wingLen * 0.82, 0.02, spec.len * 0.1],
    rot: [0, -spec.sweep * 0.55, -0.16],
    scale: [0.10, 0.09, 1.1],
    color: spec.glow, emit: 2.2,
  });
  // wingtip fins
  b.addMirrored(wedgeGeometry(0.1, 0.5, 0.8, 0.4), {
    pos: [spec.wid * 0.5 + wingLen * 0.94, 0.22, spec.len * 0.16],
    rot: [0, -spec.sweep * 0.4, 0.1],
    color: lite,
  });

  // --- engines ---
  const nacOffsets = spec.nac === 1 ? [0] : spec.nac === 2 ? [-0.46, 0.46] : [-0.58, 0, 0.58];
  for (const ox of nacOffsets) {
    const w = spec.nac === 1 ? 0.62 : 0.3;
    b.add(cyl(8), { pos: [ox, 0.02, spec.len * 0.46], rot: [Math.PI / 2, 0, 0], scale: [w, 0.85, w], color: dark });
    b.add(tor(0.5, 0.12, 6, 12), { pos: [ox, 0.02, spec.len * 0.62], rot: [0, 0, 0], scale: w * 1.05, color: spec.glow, emit: 2.8, flat: false });
    b.add(cyl(8), { pos: [ox, 0.02, spec.len * 0.60], rot: [Math.PI / 2, 0, 0], scale: [w * 0.72, 0.16, w * 0.72], color: 0xffffff, emit: 3.2 });
  }

  // --- dorsal fin + armour detail ---
  b.add(wedgeGeometry(0.09, 0.62, 1.1, 0.35), { pos: [0, spec.hei * 0.75, spec.len * 0.3], color: lite });
  b.add(box(), { pos: [0, spec.hei * 0.92, spec.len * 0.3], scale: [0.06, 0.05, 0.9], color: spec.glow, emit: 2.4 });
  if (kind === 'bastion') {
    b.addMirrored(wedgeGeometry(0.34, 0.5, 1.9, 0.6), { pos: [spec.wid * 0.62, 0.06, 0], rot: [0, 0, -0.25], color: lite });
    b.addMirrored(box(), { pos: [spec.wid * 0.62, 0.3, -0.2], scale: [0.09, 0.09, 1.3], color: spec.glow, emit: 2.0 });
  }
  if (kind === 'phantom') {
    b.addMirrored(wedgeGeometry(0.08, 0.34, 1.4, 0.3), { pos: [spec.wid * 0.34, -0.24, spec.len * 0.24], rot: [0, 0, 0.5], color: mid });
  }

  // --- hover pads (belly) ---
  for (const [px, pz] of [[-0.55, -0.5], [0.55, -0.5], [-0.62, 0.7], [0.62, 0.7]]) {
    b.add(cyl(6), { pos: [px, -spec.hei * 0.5, pz], scale: [0.30, 0.10, 0.30], color: dark });
    b.add(cyl(6), { pos: [px, -spec.hei * 0.58, pz], scale: [0.22, 0.05, 0.22], color: spec.glow, emit: 2.2 });
  }

  const geo = b.build('ship-' + kind, true);
  return { geometry: geo, glow: spec.glow, length: spec.len };
}

// ======================================================================
//  ENEMY CONSTRUCTS  (shared void-machine language: dark chitin + hot core)
// ======================================================================
const VOID_BODY = PALETTE.voidDark;
const VOID_PLATE = PALETTE.voidMid;
const VOID_TRIM = PALETTE.voidLite;

export function buildSkitter() {
  const b = new MeshBuilder();
  b.add(oct(0), { scale: [1.05, 0.72, 1.25], color: VOID_PLATE });
  b.add(oct(0), { pos: [0, 0.18, 0], scale: [0.62, 0.5, 0.7], color: VOID_BODY });
  b.add(sph(8, 6), { pos: [0, 0.05, -0.5], scale: 0.36, color: PALETTE.magenta, emit: 3.0, flat: false });
  // four splayed legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(box(), {
        pos: [sx * 0.48, -0.24, sz * 0.42], rot: [sz * 0.5, 0, -sx * 0.85],
        scale: [0.09, 0.62, 0.09], color: VOID_TRIM,
      });
      b.add(box(), {
        pos: [sx * 0.72, -0.52, sz * 0.62], rot: [sz * 0.9, 0, -sx * 0.3],
        scale: [0.07, 0.42, 0.07], color: VOID_BODY,
      });
    }
  }
  b.add(box(), { pos: [0, 0.34, 0], scale: [0.06, 0.06, 1.0], color: PALETTE.magenta, emit: 2.0 });
  return { geometry: b.build('skitter', true), radius: 0.72 };
}

export function buildDrone() {
  const b = new MeshBuilder();
  b.add(cyl(6), { rot: [0, 0.5, 0], scale: [1.5, 0.42, 1.5], color: VOID_PLATE });
  b.add(cyl(6), { pos: [0, 0.26, 0], rot: [0, 0.5, 0], scale: [0.95, 0.3, 0.95], color: VOID_BODY });
  b.add(tor(0.5, 0.07, 6, 18), { pos: [0, 0.02, 0], rot: [Math.PI / 2, 0, 0], scale: 2.05, color: PALETTE.magenta, emit: 2.4, flat: false });
  b.add(sph(10, 8), { pos: [0, 0.02, -0.55], scale: 0.44, color: PALETTE.magenta, emit: 3.2, flat: false });
  // barrel
  b.add(cyl(6), { pos: [0, -0.12, -0.72], rot: [Math.PI / 2, 0, 0], scale: [0.16, 0.7, 0.16], color: VOID_TRIM });
  b.add(cyl(6), { pos: [0, -0.12, -1.02], rot: [Math.PI / 2, 0, 0], scale: [0.1, 0.2, 0.1], color: PALETTE.magenta, emit: 3.0 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    b.add(box(), { pos: [Math.cos(a) * 0.78, -0.2, Math.sin(a) * 0.78], rot: [0, -a, 0.4], scale: [0.1, 0.44, 0.1], color: VOID_TRIM });
  }
  return { geometry: b.build('drone', true), radius: 0.95 };
}

export function buildSentinel() {
  const b = new MeshBuilder();
  b.add(wedgeGeometry(1.5, 1.35, 2.1, 0.45), { pos: [0, 1.35, 0], color: VOID_PLATE });
  b.add(box(), { pos: [0, 1.95, -0.35], scale: [1.05, 0.42, 1.05], color: VOID_BODY });
  b.add(cyl(8), { pos: [0, 1.45, -1.1], rot: [Math.PI / 2, 0, 0], scale: [0.5, 1.0, 0.5], color: VOID_TRIM });
  b.add(tor(0.5, 0.1, 6, 14), { pos: [0, 1.45, -1.5], rot: [0, 0, 0], scale: 1.1, color: PALETTE.magenta, emit: 2.6, flat: false });
  b.add(sph(10, 8), { pos: [0, 1.45, -1.62], scale: 0.5, color: 0xff6ec7, emit: 3.4, flat: false });
  // three heavy legs
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI / 2;
    const cx = Math.cos(a) * 0.72, cz = Math.sin(a) * 0.72;
    b.add(box(), { pos: [cx, 0.92, cz], rot: [cz * 0.5, -a, -cx * 0.5], scale: [0.24, 1.0, 0.24], color: VOID_TRIM });
    b.add(box(), { pos: [cx * 1.7, 0.3, cz * 1.7], rot: [-cz * 0.6, -a, cx * 0.6], scale: [0.2, 0.8, 0.2], color: VOID_BODY });
    b.add(box(), { pos: [cx * 2.1, 0.06, cz * 2.1], scale: [0.42, 0.14, 0.42], color: VOID_PLATE });
  }
  b.add(box(), { pos: [0, 2.2, 0.2], scale: [0.08, 0.08, 1.4], color: PALETTE.magenta, emit: 2.2 });
  return { geometry: b.build('sentinel', true), radius: 1.35 };
}

export function buildLancer() {
  const b = new MeshBuilder();
  b.add(wedgeGeometry(1.7, 0.95, 3.1, 0.2), { pos: [0, 0.55, 0], color: VOID_PLATE });
  b.add(wedgeGeometry(1.15, 0.5, 2.0, 0.35), { pos: [0, 1.05, -0.3], color: VOID_BODY });
  // ram horn
  b.add(spikeGeometry(1.5, 0.22, 4), { pos: [0, 0.5, -1.9], rot: [-Math.PI / 2, 0, Math.PI / 4], color: PALETTE.bone });
  b.addMirrored(spikeGeometry(1.0, 0.16, 4), { pos: [0.45, 0.62, -1.55], rot: [-Math.PI / 2, 0, 0.3], color: PALETTE.bone });
  b.add(sph(10, 8), { pos: [0, 0.95, -0.95], scale: 0.42, color: PALETTE.amber, emit: 3.0, flat: false });
  b.addMirrored(box(), { pos: [0.85, 0.5, 0.35], scale: [0.16, 0.7, 1.5], color: VOID_TRIM });
  // rear boosters
  b.addMirrored(cyl(6), { pos: [0.45, 0.55, 1.5], rot: [Math.PI / 2, 0, 0], scale: [0.42, 0.7, 0.42], color: VOID_BODY });
  b.addMirrored(cyl(6), { pos: [0.45, 0.55, 1.82], rot: [Math.PI / 2, 0, 0], scale: [0.3, 0.16, 0.3], color: PALETTE.amber, emit: 3.2 });
  // legs
  for (const sx of [-1, 1]) {
    b.add(box(), { pos: [sx * 0.7, 0.24, -0.5], rot: [0, 0, -sx * 0.6], scale: [0.14, 0.7, 0.14], color: VOID_TRIM });
    b.add(box(), { pos: [sx * 0.7, 0.24, 0.9], rot: [0, 0, -sx * 0.6], scale: [0.14, 0.7, 0.14], color: VOID_TRIM });
  }
  return { geometry: b.build('lancer', true), radius: 1.25 };
}

export function buildSeeder() {
  const b = new MeshBuilder();
  b.add(sph(10, 6), { pos: [0, 0.55, 0], scale: [2.0, 1.1, 2.0], color: VOID_PLATE, flat: false });
  b.add(cyl(8), { pos: [0, 0.2, 0], scale: [2.05, 0.4, 2.05], color: VOID_BODY });
  b.add(tor(0.5, 0.09, 6, 16), { pos: [0, 0.42, 0], rot: [Math.PI / 2, 0, 0], scale: 2.2, color: PALETTE.amber, emit: 2.2, flat: false });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    b.add(cyl(6), {
      pos: [Math.cos(a) * 0.5, 1.05, Math.sin(a) * 0.5], rot: [Math.cos(a) * 0.32, 0, -Math.sin(a) * 0.32],
      scale: [0.26, 0.9, 0.26], color: VOID_TRIM,
    });
    b.add(cyl(6), {
      pos: [Math.cos(a) * 0.62, 1.45, Math.sin(a) * 0.62], rot: [Math.cos(a) * 0.32, 0, -Math.sin(a) * 0.32],
      scale: [0.2, 0.14, 0.2], color: PALETTE.amber, emit: 3.0,
    });
  }
  b.add(sph(8, 6), { pos: [0, 1.0, -0.9], scale: 0.34, color: PALETTE.amber, emit: 3.0, flat: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    b.add(box(), { pos: [Math.cos(a) * 0.95, 0.12, Math.sin(a) * 0.95], rot: [0, -a, 0.35], scale: [0.16, 0.5, 0.16], color: VOID_TRIM });
  }
  return { geometry: b.build('seeder', true), radius: 1.15 };
}

export function buildSplitter() {
  const b = new MeshBuilder();
  b.add(ico(0), { scale: 2.0, color: VOID_PLATE });
  b.add(ico(0), { scale: 1.45, rot: [0.6, 0.4, 0], color: VOID_BODY });
  b.add(sph(10, 8), { scale: 0.9, color: PALETTE.violet, emit: 2.6, flat: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    b.add(box(), { pos: [Math.cos(a) * 0.72, Math.sin(i * 1.7) * 0.4, Math.sin(a) * 0.72], rot: [0, -a, 0], scale: [0.9, 0.07, 0.07], color: PALETTE.violet, emit: 2.4 });
  }
  return { geometry: b.build('splitter'), radius: 1.0 };
}

/** Small autonomous helper the player can unlock as a module. */
export function buildGuardian() {
  const b = new MeshBuilder();
  b.add(oct(0), { scale: 0.55, color: PALETTE.hullMid });
  b.add(tor(0.5, 0.08, 5, 12), { rot: [Math.PI / 2, 0, 0], scale: 0.8, color: PALETTE.cyan, emit: 2.6, flat: false });
  b.add(sph(8, 6), { pos: [0, 0, -0.3], scale: 0.2, color: PALETTE.cyan, emit: 3.2, flat: false });
  return { geometry: b.build('guardian', true), radius: 0.4 };
}

// ======================================================================
//  BOSSES — built as part lists so the sim can animate sub-assemblies
// ======================================================================
export function buildWarden() {
  const core = new MeshBuilder();
  core.add(oct(0), { scale: 4.4, color: VOID_PLATE });
  core.add(oct(0), { scale: 3.0, rot: [0.4, 0.4, 0], color: VOID_BODY });
  core.add(sph(12, 10), { scale: 2.2, color: PALETTE.magenta, emit: 2.4, flat: false });
  core.add(tor(0.5, 0.06, 6, 24), { rot: [Math.PI / 2, 0, 0], scale: 6.4, color: PALETTE.magenta, emit: 2.0, flat: false });

  const ring = new MeshBuilder();
  ring.add(tor(0.5, 0.055, 8, 32), { rot: [Math.PI / 2, 0, 0], scale: 8.0, color: VOID_TRIM });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    ring.add(wedgeGeometry(0.9, 0.5, 1.6, 0.4), { pos: [Math.cos(a) * 4.0, 0, Math.sin(a) * 4.0], rot: [0, -a + Math.PI / 2, 0], color: VOID_PLATE });
    ring.add(box(), { pos: [Math.cos(a) * 4.5, 0, Math.sin(a) * 4.5], rot: [0, -a, 0], scale: [0.5, 0.1, 0.1], color: PALETTE.magenta, emit: 2.6 });
  }

  const plate = new MeshBuilder();
  plate.add(wedgeGeometry(2.2, 0.55, 3.0, 0.5), { color: VOID_PLATE });
  plate.add(box(), { pos: [0, 0.34, 0], scale: [1.4, 0.1, 2.0], color: PALETTE.cyan, emit: 2.2 });
  plate.add(oct(0), { pos: [0, 0.3, -1.2], scale: 0.7, color: PALETTE.cyan, emit: 2.6 });

  const turret = new MeshBuilder();
  turret.add(cyl(6), { rot: [Math.PI / 2, 0, 0], scale: [0.5, 1.4, 0.5], color: VOID_BODY });
  turret.add(sph(8, 6), { pos: [0, 0, -0.8], scale: 0.5, color: PALETTE.magenta, emit: 3.2, flat: false });

  return {
    core: core.build('warden-core', true),
    ring: ring.build('warden-ring'),
    plate: plate.build('warden-plate', true),
    turret: turret.build('warden-turret', true),
    radius: 4.6,
  };
}

export function buildHarrower() {
  const core = new MeshBuilder();
  core.add(wedgeGeometry(4.0, 2.4, 9.0, 0.25), { pos: [0, 0, 0], color: VOID_PLATE });
  core.add(wedgeGeometry(2.6, 1.2, 6.0, 0.4), { pos: [0, 1.2, -0.6], color: VOID_BODY });
  core.add(sph(12, 10), { pos: [0, 0.9, -2.6], scale: 1.7, color: 0xff5ab0, emit: 3.0, flat: false });
  core.add(box(), { pos: [0, 1.75, 0], scale: [0.12, 0.12, 6.5], color: PALETTE.magenta, emit: 2.4 });
  for (let i = 0; i < 5; i++) {
    core.add(wedgeGeometry(2.6 - i * 0.35, 0.9, 1.4, 0.7), { pos: [0, 0.1, 3.6 + i * 1.15], color: i % 2 ? VOID_BODY : VOID_TRIM });
  }
  core.add(spikeGeometry(3.0, 0.5, 5), { pos: [0, 0.2, -5.4], rot: [-Math.PI / 2, 0, 0], color: PALETTE.bone });

  const arm = new MeshBuilder();
  arm.add(box(), { pos: [0, 0, 1.6], scale: [0.7, 0.5, 4.4], color: VOID_PLATE });
  arm.add(cyl(6), { pos: [0, 0, -0.9], rot: [Math.PI / 2, 0, 0], scale: [1.0, 1.6, 1.0], color: VOID_BODY });
  arm.add(tor(0.5, 0.1, 6, 16), { pos: [0, 0, -1.7], scale: 2.0, color: PALETTE.magenta, emit: 2.8, flat: false });
  arm.add(sph(10, 8), { pos: [0, 0, -1.85], scale: 0.8, color: 0xffa8d8, emit: 3.4, flat: false });

  return { core: core.build('harrower-core', true), arm: arm.build('harrower-arm', true), radius: 4.2 };
}

export function buildMaw() {
  const core = new MeshBuilder();
  core.add(ico(1), { scale: 8.0, color: VOID_BODY });
  core.add(ico(0), { scale: 6.6, rot: [0.5, 0.3, 0.2], color: VOID_PLATE });
  core.add(sph(16, 12), { scale: 4.6, color: 0xff2f8f, emit: 2.2, flat: false });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU;
    const y = Math.sin(i * 2.4) * 2.4;
    const r = Math.sqrt(Math.max(0.1, 16 - y * y * 0.6));
    core.add(spikeGeometry(2.4, 0.34, 4), {
      pos: [Math.cos(a) * r, y, Math.sin(a) * r],
      rot: [Math.PI / 2 - Math.atan2(y, r) * 0.6, -a, 0],
      color: i % 3 === 0 ? PALETTE.bone : VOID_TRIM,
    });
  }

  const jaw = new MeshBuilder();
  jaw.add(wedgeGeometry(5.0, 1.4, 5.0, 0.35), { rot: [0.2, 0, 0], color: VOID_PLATE });
  for (let i = 0; i < 5; i++) {
    jaw.add(spikeGeometry(1.5, 0.26, 4), { pos: [-1.8 + i * 0.9, -0.3, -2.0], rot: [-Math.PI * 0.62, 0, 0], color: PALETTE.bone });
  }
  jaw.add(box(), { pos: [0, 0.6, 0.4], scale: [3.6, 0.1, 0.14], color: PALETTE.magenta, emit: 2.6 });

  const eye = new MeshBuilder();
  eye.add(sph(12, 10), { scale: 1.3, color: 0xffe36e, emit: 3.4, flat: false });
  eye.add(tor(0.5, 0.12, 6, 14), { rot: [Math.PI / 2, 0, 0], scale: 2.0, color: PALETTE.amber, emit: 2.4, flat: false });

  return { core: core.build('maw-core', true), jaw: jaw.build('maw-jaw', true), eye: eye.build('maw-eye'), radius: 7.2 };
}

// ======================================================================
//  WORLD PROPS
// ======================================================================
export function buildPillar(seed = 0) {
  const b = new MeshBuilder();
  const h = 5.2 + (seed % 3) * 1.4;
  b.add(tap(0.62, 0.95, 6), { pos: [0, h / 2, 0], scale: [2.0, h, 2.0], color: PALETTE.hullDark });
  b.add(cyl(6), { pos: [0, 0.35, 0], scale: [2.5, 0.7, 2.5], color: PALETTE.hullMid });
  b.add(cyl(6), { pos: [0, h + 0.2, 0], scale: [1.5, 0.5, 1.5], color: PALETTE.hullMid });
  for (let i = 0; i < 3; i++) {
    b.add(tor(0.5, 0.035, 5, 12), { pos: [0, 1.2 + i * (h / 3.4), 0], rot: [Math.PI / 2, 0, 0], scale: 1.9 - i * 0.16, color: PALETTE.cyan, emit: 2.0, flat: false });
  }
  b.add(oct(0), { pos: [0, h + 0.85, 0], scale: 0.9, color: PALETTE.cyan, emit: 2.6 });
  return { geometry: b.build('pillar'), radius: 1.15, height: h };
}

export function buildStabilizer() {
  const base = new MeshBuilder();
  base.add(cyl(8), { pos: [0, 0.4, 0], scale: [7.0, 0.8, 7.0], color: PALETTE.hullDark });
  base.add(cyl(8), { pos: [0, 0.9, 0], scale: [5.6, 0.5, 5.6], color: PALETTE.hullMid });
  base.add(tor(0.5, 0.05, 6, 32), { pos: [0, 1.2, 0], rot: [Math.PI / 2, 0, 0], scale: 11.0, color: PALETTE.cyan, emit: 2.2, flat: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    base.add(wedgeGeometry(0.7, 1.6, 2.4, 0.4), { pos: [Math.cos(a) * 2.4, 1.6, Math.sin(a) * 2.4], rot: [0, -a, 0.28], color: PALETTE.hullMid });
  }
  const crystal = new MeshBuilder();
  crystal.add(oct(0), { scale: [1.7, 3.4, 1.7], color: PALETTE.cyan, emit: 2.4 });
  crystal.add(oct(0), { scale: [1.0, 2.2, 1.0], rot: [0, 0.8, 0], color: 0xffffff, emit: 2.8 });
  const ring = new MeshBuilder();
  ring.add(tor(0.5, 0.04, 6, 28), { rot: [Math.PI / 2, 0, 0], scale: 5.2, color: PALETTE.cyan, emit: 2.4, flat: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    ring.add(box(), { pos: [Math.cos(a) * 2.6, 0, Math.sin(a) * 2.6], rot: [0, -a, 0], scale: [0.5, 0.14, 0.14], color: 0xffffff, emit: 2.6 });
  }
  return { base: base.build('stab-base'), crystal: crystal.build('stab-crystal'), ring: ring.build('stab-ring') };
}

export function buildShard() {
  const b = new MeshBuilder();
  b.add(oct(0), { scale: [0.42, 0.75, 0.42], color: PALETTE.cyan, emit: 2.8 });
  b.add(oct(0), { scale: [0.7, 1.15, 0.7], color: PALETTE.cyanDeep, emit: 1.0 });
  return { geometry: b.build('shard'), radius: 0.5 };
}

export function buildOrb(color = PALETTE.lime) {
  const b = new MeshBuilder();
  b.add(ico(1), { scale: 0.8, color, emit: 2.6, flat: false });
  b.add(tor(0.5, 0.08, 5, 12), { rot: [Math.PI / 2, 0, 0], scale: 1.3, color, emit: 2.0, flat: false });
  b.add(tor(0.5, 0.08, 5, 12), { rot: [0, 0, Math.PI / 2], scale: 1.3, color, emit: 2.0, flat: false });
  return { geometry: b.build('orb'), radius: 0.6 };
}

export function buildBolt(color = PALETTE.cyan, len = 1.0) {
  const b = new MeshBuilder();
  b.add(oct(0), { scale: [0.24, 0.24, len], color: 0xffffff, emit: 3.4 });
  b.add(oct(0), { scale: [0.44, 0.44, len * 1.5], color, emit: 2.2 });
  return { geometry: b.build('bolt'), radius: 0.3 };
}

export function buildMortarShell() {
  const b = new MeshBuilder();
  b.add(ico(0), { scale: 0.75, color: PALETTE.amber, emit: 2.4 });
  b.add(ico(0), { scale: 1.1, rot: [0.5, 0.3, 0], color: 0x7a4a1a, emit: 0.6 });
  return { geometry: b.build('shell'), radius: 0.45 };
}

export function buildMine() {
  const b = new MeshBuilder();
  b.add(sph(8, 6), { scale: 0.9, color: VOID_BODY });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    b.add(spikeGeometry(0.5, 0.12, 4), { pos: [Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45], rot: [Math.PI / 2, 0, -a + Math.PI / 2], color: VOID_TRIM });
  }
  b.add(sph(8, 6), { scale: 0.55, color: PALETTE.magenta, emit: 3.0, flat: false });
  return { geometry: b.build('mine'), radius: 0.55 };
}

/** Chunky debris used by the destruction VFX. */
export function buildDebris(seed = 1) {
  const b = new MeshBuilder();
  const r = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  for (let i = 0; i < 3; i++) {
    b.add(tet(), {
      pos: [(r(i) - 0.5) * 0.5, (r(i + 5) - 0.5) * 0.5, (r(i + 9) - 0.5) * 0.5],
      rot: [r(i + 1) * 6.2, r(i + 2) * 6.2, r(i + 3) * 6.2],
      scale: 0.35 + r(i + 4) * 0.5,
      color: i === 0 ? PALETTE.hullMid : PALETTE.hullDark,
    });
  }
  return { geometry: b.build('debris'), radius: 0.4 };
}

/** Rift portal frame that opens before a wave spawns. */
export function buildRiftFrame() {
  const b = new MeshBuilder();
  b.add(tor(0.5, 0.045, 6, 26), { rot: [Math.PI / 2, 0, 0], scale: 5.0, color: PALETTE.violet, emit: 2.6, flat: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    b.add(spikeGeometry(1.1, 0.16, 4), { pos: [Math.cos(a) * 2.5, 0.1, Math.sin(a) * 2.5], rot: [Math.PI / 2, 0, -a + Math.PI / 2], color: PALETTE.voidLite, emit: 0.6 });
  }
  return { geometry: b.build('rift-frame'), radius: 2.6 };
}
