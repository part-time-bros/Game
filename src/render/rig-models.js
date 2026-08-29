/**
 * rig-models.js — the animated cast.
 *
 * Every model here is a bone hierarchy plus authored clips: legs that actually
 * step, wings that fold on a dash, barrels that recoil, jaws that open. Parts
 * are authored in their own bone's local space (see rig.js), so a leg is just
 * "a box hanging below the hip bone" and the animation does the rest.
 *
 * Bone budget is 18; every rig here fits comfortably under it.
 */
import { TAU } from '../core/util.js';
import { RigBuilder, Clip, compileClips } from './rig.js';
import { PALETTE, PRIM } from './models.js';

const VOID_BODY = PALETTE.voidDark;
const VOID_PLATE = PALETTE.voidMid;
const VOID_TRIM = PALETTE.voidLite;

/** Build once, share the geometry + skeleton + compiled clips across instances. */
function pack(builder, clips, name, extra = {}) {
  const { geometry, skeleton } = builder.build(name);
  return { geometry, skeleton, clips: compileClips(skeleton, clips), ...extra };
}

// ======================================================================
//  PLAYER CHASSIS
// ======================================================================
const SHIP_SPEC = {
  striker: { len: 3.0, wid: 1.05, hei: 0.62, wing: 1.35, sweep: 0.5, nac: 2, glow: PALETTE.cyan },
  bastion: { len: 2.9, wid: 1.5, hei: 0.86, wing: 1.15, sweep: 0.26, nac: 1, glow: 0x63b4ff },
  phantom: { len: 3.35, wid: 0.82, hei: 0.5, wing: 1.5, sweep: 0.8, nac: 3, glow: 0xc98bff },
};

export function buildRiggedShip(kind = 'striker') {
  const sp = SHIP_SPEC[kind] || SHIP_SPEC.striker;
  const dark = PALETTE.hullDark, mid = PALETTE.hullMid, lite = PALETTE.hullLite;
  const r = new RigBuilder();

  r.addBone('root');
  r.addBone('hull', 'root');
  r.addBone('nose', 'hull', [0, 0, -sp.len * 0.52]);
  r.addBone('canopy', 'hull', [0, sp.hei * 0.55, -sp.len * 0.16]);
  r.addBone('wingL', 'hull', [sp.wid * 0.5, -0.02, sp.len * 0.06], [0, -sp.sweep * 0.55, -0.16]);
  r.addBone('wingR', 'hull', [-sp.wid * 0.5, -0.02, sp.len * 0.06], [0, sp.sweep * 0.55, 0.16]);
  r.addBone('nacL', 'hull', [sp.nac === 1 ? 0 : 0.46, 0.02, sp.len * 0.46]);
  r.addBone('nacR', 'hull', [sp.nac === 1 ? 0 : -0.46, 0.02, sp.len * 0.46]);
  r.addBone('nacC', 'hull', [0, 0.02, sp.len * 0.5]);
  r.addBone('fin', 'hull', [0, sp.hei * 0.75, sp.len * 0.3]);
  r.addBone('gearL', 'hull', [0.58, -sp.hei * 0.5, -0.5]);
  r.addBone('gearR', 'hull', [-0.58, -sp.hei * 0.5, -0.5]);
  r.addBone('gearBL', 'hull', [0.62, -sp.hei * 0.5, 0.7]);
  r.addBone('gearBR', 'hull', [-0.62, -sp.hei * 0.5, 0.7]);

  // --- fuselage ---
  r.part(PRIM.wedge(sp.wid, sp.hei, sp.len, 0.22), { bone: 'hull', pos: [0, 0, -0.1], color: mid });
  r.part(PRIM.wedge(sp.wid * 0.72, sp.hei * 0.55, sp.len * 0.55, 0.5), { bone: 'hull', pos: [0, sp.hei * 0.42, -sp.len * 0.1], color: lite });
  // spine greebles: small hard-surface detail reads as machined at this scale
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.box(), { bone: 'hull', pos: [0, sp.hei * 0.5, -sp.len * 0.2 + i * 0.42], scale: [sp.wid * 0.5, 0.05, 0.1], color: dark });
  }
  r.part(PRIM.sph(8, 6), { bone: 'canopy', scale: [sp.wid * 0.44, sp.hei * 0.5, sp.len * 0.3], color: sp.glow, emit: 1.6, flat: false });
  r.part(PRIM.tor(0.5, 0.06, 5, 12), { bone: 'canopy', rot: [Math.PI / 2, 0, 0], scale: sp.wid * 0.95, color: lite, flat: false });

  // --- nose lance ---
  r.part(PRIM.cyl(6), { bone: 'nose', rot: [Math.PI / 2, 0, 0], scale: [0.2, 0.55, 0.2], color: PALETTE.hullWhite });
  r.part(PRIM.cyl(6), { bone: 'nose', pos: [0, 0, -0.2], rot: [Math.PI / 2, 0, 0], scale: [0.12, 0.4, 0.12], color: sp.glow, emit: 2.8 });
  r.part(PRIM.tor(0.5, 0.09, 5, 10), { bone: 'nose', pos: [0, 0, -0.08], scale: 0.42, color: sp.glow, emit: 2.2, flat: false });

  // --- wings ---
  for (const [bone, s] of [['wingL', 1], ['wingR', -1]]) {
    r.part(PRIM.wedge(sp.wing, 0.13, 1.5, 0.55), { bone, pos: [s * sp.wing * 0.42, 0, 0], color: mid });
    r.part(PRIM.box(), { bone, pos: [s * sp.wing * 0.82, 0.04, 0.1], scale: [0.1, 0.09, 1.1], color: sp.glow, emit: 2.4 });
    r.part(PRIM.wedge(0.1, 0.5, 0.8, 0.4), { bone, pos: [s * sp.wing * 0.94, 0.22, 0.16], rot: [0, 0, s * 0.12], color: lite });
    r.part(PRIM.box(), { bone, pos: [s * sp.wing * 0.55, -0.08, -0.3], scale: [0.24, 0.1, 0.5], color: dark });
    if (kind === 'bastion') {
      r.part(PRIM.wedge(0.34, 0.5, 1.9, 0.6), { bone, pos: [s * 0.2, 0.08, 0], rot: [0, 0, -s * 0.25], color: lite });
    }
  }

  // --- engines ---
  const nacelles = sp.nac === 1 ? ['nacL'] : sp.nac === 2 ? ['nacL', 'nacR'] : ['nacL', 'nacR', 'nacC'];
  for (const bone of nacelles) {
    const w = sp.nac === 1 ? 0.62 : 0.3;
    r.part(PRIM.cyl(8), { bone, rot: [Math.PI / 2, 0, 0], scale: [w, 0.85, w], color: dark });
    r.part(PRIM.tor(0.5, 0.12, 6, 12), { bone, pos: [0, 0, 0.16], scale: w * 1.05, color: sp.glow, emit: 3.0, flat: false });
    r.part(PRIM.cyl(8), { bone, pos: [0, 0, 0.14], rot: [Math.PI / 2, 0, 0], scale: [w * 0.72, 0.16, w * 0.72], color: 0xffffff, emit: 3.4 });
    r.part(PRIM.box(), { bone, pos: [0, w * 0.75, -0.1], scale: [w * 0.4, 0.08, 0.7], color: lite });
  }

  // --- dorsal fin ---
  r.part(PRIM.wedge(0.09, 0.62, 1.1, 0.35), { bone: 'fin', color: lite });
  r.part(PRIM.box(), { bone: 'fin', pos: [0, 0.17, 0], scale: [0.06, 0.05, 0.9], color: sp.glow, emit: 2.6 });

  // --- hover gear ---
  for (const bone of ['gearL', 'gearR', 'gearBL', 'gearBR']) {
    r.part(PRIM.cyl(6), { bone, scale: [0.3, 0.1, 0.3], color: dark });
    r.part(PRIM.cyl(6), { bone, pos: [0, -0.09, 0], scale: [0.22, 0.05, 0.22], color: sp.glow, emit: 2.4 });
    r.part(PRIM.box(), { bone, pos: [0, 0.06, 0], scale: [0.1, 0.16, 0.1], color: PALETTE.hullWhite });
  }

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 2.6);
      c.swing('wingL', 'z', 0.05);
      c.swing('wingR', 'z', -0.05);
      c.swing('fin', 'x', 0.03, 0.25);
      c.track('gearL', 'pos', [[0, 0, 0, 0], [1.3, 0, -0.05, 0], [2.6, 0, 0, 0]]);
      c.track('gearBR', 'pos', [[0, 0, -0.05, 0], [1.3, 0, 0, 0], [2.6, 0, -0.05, 0]]);
      return c;
    })(),
    cruise: (() => {
      const c = new Clip('cruise', 1.5);
      c.track('wingL', 'rot', [[0, 0, -0.13, -0.06], [0.75, 0, -0.16, -0.02], [1.5, 0, -0.13, -0.06]]);
      c.track('wingR', 'rot', [[0, 0, 0.13, 0.06], [0.75, 0, 0.16, 0.02], [1.5, 0, 0.13, 0.06]]);
      c.track('nacL', 'rot', [[0, 0.05, 0, 0], [0.75, -0.03, 0, 0], [1.5, 0.05, 0, 0]]);
      c.track('nacR', 'rot', [[0, 0.05, 0, 0], [0.75, -0.03, 0, 0], [1.5, 0.05, 0, 0]]);
      return c;
    })(),
    dash: (() => {
      const c = new Clip('dash', 0.42, { loop: false });
      c.track('wingL', 'rot', [[0, 0, 0, 0], [0.1, 0, -0.6, -0.34], [0.42, 0, -0.42, -0.2]]);
      c.track('wingR', 'rot', [[0, 0, 0, 0], [0.1, 0, 0.6, 0.34], [0.42, 0, 0.42, 0.2]]);
      c.track('nacL', 'scale', [[0, 1, 1, 1], [0.1, 1.25, 1.25, 1.5], [0.42, 1, 1, 1]]);
      c.track('nacR', 'scale', [[0, 1, 1, 1], [0.1, 1.25, 1.25, 1.5], [0.42, 1, 1, 1]]);
      c.track('hull', 'rot', [[0, 0, 0, 0], [0.1, -0.16, 0, 0], [0.42, 0, 0, 0]]);
      c.track('gearL', 'pos', [[0, 0, 0, 0], [0.12, 0, 0.14, 0], [0.42, 0, 0.14, 0]]);
      c.track('gearR', 'pos', [[0, 0, 0, 0], [0.12, 0, 0.14, 0], [0.42, 0, 0.14, 0]]);
      c.track('gearBL', 'pos', [[0, 0, 0, 0], [0.12, 0, 0.14, 0], [0.42, 0, 0.14, 0]]);
      c.track('gearBR', 'pos', [[0, 0, 0, 0], [0.12, 0, 0.14, 0], [0.42, 0, 0.14, 0]]);
      return c;
    })(),
    overdrive: (() => {
      const c = new Clip('overdrive', 1.1);
      c.track('wingL', 'rot', [[0, 0, -0.3, -0.3], [0.55, 0, -0.36, -0.24], [1.1, 0, -0.3, -0.3]]);
      c.track('wingR', 'rot', [[0, 0, 0.3, 0.3], [0.55, 0, 0.36, 0.24], [1.1, 0, 0.3, 0.3]]);
      c.track('nacL', 'scale', [[0, 1.15, 1.15, 1.3], [0.55, 1.3, 1.3, 1.5], [1.1, 1.15, 1.15, 1.3]]);
      c.track('nacR', 'scale', [[0, 1.15, 1.15, 1.3], [0.55, 1.3, 1.3, 1.5], [1.1, 1.15, 1.15, 1.3]]);
      return c;
    })(),
  };

  return pack(r, clips, 'ship-' + kind, { glow: sp.glow, length: sp.len });
}

// ======================================================================
//  SKITTER — four-legged rusher
// ======================================================================
export function buildRiggedSkitter() {
  const r = new RigBuilder();
  r.addBone('root');
  // Bind pose convention across the cast: the rig origin is the deck contact
  // point, so a walker's feet land at y = 0 and `hover` stays 0 for them.
  r.addBone('body', 'root', [0, 0.86, 0]);
  r.addBone('head', 'body', [0, 0.04, -0.5]);
  const legs = [
    ['FL', 1, -1], ['FR', -1, -1], ['BL', 1, 1], ['BR', -1, 1],
  ];
  for (const [id, sx, sz] of legs) {
    r.addBone('leg' + id, 'body', [sx * 0.42, -0.10, sz * 0.38], [sz * 0.22, 0, sx * 1.15]);
    r.addBone('leg' + id + 'b', 'leg' + id, [0, -0.56, 0], [0, 0, -sx * 1.15]);
  }

  r.part(PRIM.oct(0), { bone: 'body', scale: [1.05, 0.72, 1.25], color: VOID_PLATE });
  r.part(PRIM.oct(0), { bone: 'body', pos: [0, 0.18, 0], scale: [0.62, 0.5, 0.7], color: VOID_BODY });
  r.part(PRIM.box(), { bone: 'body', pos: [0, 0.34, 0], scale: [0.06, 0.06, 1.0], color: PALETTE.magenta, emit: 2.2 });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'body', pos: [0, 0.26, -0.3 + i * 0.3], scale: [0.5 - i * 0.1, 0.05, 0.08], color: VOID_TRIM });
  }
  r.part(PRIM.sph(8, 6), { bone: 'head', scale: 0.36, color: PALETTE.magenta, emit: 3.2, flat: false });
  r.part(PRIM.tor(0.5, 0.1, 5, 10), { bone: 'head', rot: [Math.PI / 2, 0, 0], scale: 0.5, color: VOID_TRIM, flat: false });

  for (const [id] of legs) {
    r.part(PRIM.box(), { bone: 'leg' + id, pos: [0, -0.28, 0], scale: [0.14, 0.58, 0.14], color: VOID_TRIM });
    r.part(PRIM.oct(0), { bone: 'leg' + id, scale: 0.24, color: VOID_BODY });
    r.part(PRIM.oct(0), { bone: 'leg' + id + 'b', scale: 0.2, color: VOID_TRIM });
    r.part(PRIM.box(), { bone: 'leg' + id + 'b', pos: [0, -0.28, 0], scale: [0.11, 0.56, 0.11], color: VOID_BODY });
    r.part(PRIM.spike(0.26, 0.08, 4), { bone: 'leg' + id + 'b', pos: [0, -0.6, 0], rot: [Math.PI, 0, 0], color: PALETTE.bone });
  }

  // diagonal gait: FL+BR swing together, FR+BL oppose
  const gait = (c, phase) => {
    for (const [id, , ] of legs) {
      const p = (id === 'FL' || id === 'BR') ? phase : phase + 0.5;
      c.swing('leg' + id, 'x', 0.55, p);
      c.swing('leg' + id + 'b', 'x', -0.42, p + 0.12);
    }
    return c;
  };

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 2.0);
      c.swing('body', 'y', 0.06);
      c.track('body', 'pos', [[0, 0, 0, 0], [1, 0, 0.06, 0], [2, 0, 0, 0]]);
      for (const [id] of legs) c.swing('leg' + id, 'x', 0.08, id === 'FL' ? 0 : 0.3);
      return c;
    })(),
    scuttle: (() => {
      const c = new Clip('scuttle', 0.42);
      gait(c, 0);
      c.track('body', 'pos', [[0, 0, 0, 0], [0.11, 0, 0.09, 0], [0.21, 0, 0, 0], [0.32, 0, 0.09, 0], [0.42, 0, 0, 0]]);
      c.swing('body', 'z', 0.12, 0.25);
      c.swing('head', 'x', 0.1, 0.5);
      return c;
    })(),
    lunge: (() => {
      const c = new Clip('lunge', 0.55, { loop: false });
      c.track('body', 'pos', [[0, 0, 0, 0], [0.12, 0, -0.14, 0.2], [0.22, 0, 0.12, -0.34], [0.55, 0, 0, 0]]);
      c.track('body', 'rot', [[0, 0, 0, 0], [0.12, 0.34, 0, 0], [0.24, -0.28, 0, 0], [0.55, 0, 0, 0]]);
      for (const [id] of legs) {
        c.track('leg' + id, 'rot', [[0, 0, 0, 0], [0.12, 0.8, 0, 0], [0.26, -0.7, 0, 0], [0.55, 0, 0, 0]]);
        c.track('leg' + id + 'b', 'rot', [[0, 0, 0, 0], [0.12, -1.1, 0, 0], [0.26, 0.5, 0, 0], [0.55, 0, 0, 0]]);
      }
      c.track('head', 'scale', [[0, 1, 1, 1], [0.2, 1.5, 1.5, 1.5], [0.55, 1, 1, 1]]);
      return c;
    })(),
  };
  return pack(r, clips, 'skitter', { radius: 0.85 });
}

// ======================================================================
//  DRONE — hovering gunnery platform
// ======================================================================
export function buildRiggedDrone() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('body', 'root');
  r.addBone('ring', 'body');
  r.addBone('barrel', 'body', [0, -0.12, -0.72]);
  r.addBone('eye', 'body', [0, 0.02, -0.55]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    r.addBone('fin' + i, 'body', [Math.cos(a) * 0.78, -0.2, Math.sin(a) * 0.78], [0, -a, 0.4]);
  }

  r.part(PRIM.cyl(6), { bone: 'body', rot: [0, 0.5, 0], scale: [1.5, 0.42, 1.5], color: VOID_PLATE });
  r.part(PRIM.cyl(6), { bone: 'body', pos: [0, 0.26, 0], rot: [0, 0.5, 0], scale: [0.95, 0.3, 0.95], color: VOID_BODY });
  r.part(PRIM.cyl(6), { bone: 'body', pos: [0, 0.44, 0], rot: [0, 0.5, 0], scale: [0.5, 0.16, 0.5], color: VOID_TRIM });
  r.part(PRIM.tor(0.5, 0.07, 6, 18), { bone: 'ring', rot: [Math.PI / 2, 0, 0], scale: 2.05, color: PALETTE.magenta, emit: 2.6, flat: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    r.part(PRIM.box(), { bone: 'ring', pos: [Math.cos(a) * 1.02, 0, Math.sin(a) * 1.02], rot: [0, -a, 0], scale: [0.16, 0.1, 0.1], color: VOID_TRIM });
  }
  r.part(PRIM.sph(10, 8), { bone: 'eye', scale: 0.44, color: PALETTE.magenta, emit: 3.4, flat: false });
  r.part(PRIM.cyl(6), { bone: 'barrel', rot: [Math.PI / 2, 0, 0], scale: [0.16, 0.7, 0.16], color: VOID_TRIM });
  r.part(PRIM.cyl(6), { bone: 'barrel', pos: [0, 0, -0.3], rot: [Math.PI / 2, 0, 0], scale: [0.1, 0.2, 0.1], color: PALETTE.magenta, emit: 3.0 });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'fin' + i, pos: [0, -0.22, 0], scale: [0.1, 0.44, 0.1], color: VOID_TRIM });
    r.part(PRIM.box(), { bone: 'fin' + i, pos: [0, -0.44, 0], scale: [0.16, 0.06, 0.16], color: PALETTE.magenta, emit: 1.8 });
  }

  const clips = {
    hover: (() => {
      const c = new Clip('hover', 2.2);
      c.track('body', 'pos', [[0, 0, 0, 0], [1.1, 0, 0.1, 0], [2.2, 0, 0, 0]]);
      for (let i = 0; i < 3; i++) c.swing('fin' + i, 'z', 0.22, i / 3);
      c.swing('body', 'x', 0.05, 0.3);
      return c;
    })(),
    fire: (() => {
      const c = new Clip('fire', 0.36, { loop: false });
      c.track('barrel', 'pos', [[0, 0, 0, 0], [0.05, 0, 0, 0.26], [0.36, 0, 0, 0]]);
      c.track('eye', 'scale', [[0, 1, 1, 1], [0.05, 1.5, 1.5, 1.5], [0.36, 1, 1, 1]]);
      c.track('body', 'rot', [[0, 0, 0, 0], [0.05, -0.14, 0, 0], [0.36, 0, 0, 0]]);
      for (let i = 0; i < 3; i++) c.track('fin' + i, 'rot', [[0, 0, 0, 0], [0.06, 0, 0, -0.3], [0.36, 0, 0, 0]]);
      return c;
    })(),
  };
  return pack(r, clips, 'drone', { radius: 1.0 });
}

// ======================================================================
//  SPLITTER — unstable lattice
// ======================================================================
export function buildRiggedSplitter() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('core', 'root');
  for (let i = 0; i < 3; i++) r.addBone('shell' + i, 'root', [0, 0, 0], [i * 0.9, i * 1.4, i * 0.6]);

  r.part(PRIM.sph(10, 8), { bone: 'core', scale: 0.9, color: PALETTE.violet, emit: 2.8, flat: false });
  r.part(PRIM.ico(0), { bone: 'core', scale: 1.2, rot: [0.4, 0.3, 0], color: VOID_BODY });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.ico(0), { bone: 'shell' + i, scale: [2.0, 0.5, 2.0], color: i === 0 ? VOID_PLATE : VOID_BODY });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + i;
      r.part(PRIM.box(), {
        bone: 'shell' + i, pos: [Math.cos(a) * 0.72, 0, Math.sin(a) * 0.72], rot: [0, -a, 0],
        scale: [0.8, 0.06, 0.06], color: PALETTE.violet, emit: 2.4,
      });
    }
  }

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 3.0);
      for (let i = 0; i < 3; i++) {
        c.track('shell' + i, 'rot', [[0, 0, 0, 0], [1.5, 0.5 + i * 0.2, 1.2, 0.3], [3.0, 0, 0, 0]]);
      }
      c.track('core', 'scale', [[0, 1, 1, 1], [1.5, 1.16, 1.16, 1.16], [3.0, 1, 1, 1]]);
      return c;
    })(),
    strain: (() => {
      const c = new Clip('strain', 0.5);
      for (let i = 0; i < 3; i++) {
        c.track('shell' + i, 'pos', [[0, 0, 0, 0], [0.25, (i - 1) * 0.3, 0.25, (1 - i) * 0.3], [0.5, 0, 0, 0]]);
      }
      c.track('core', 'scale', [[0, 1.2, 1.2, 1.2], [0.25, 1.45, 1.45, 1.45], [0.5, 1.2, 1.2, 1.2]]);
      return c;
    })(),
  };
  return pack(r, clips, 'splitter', { radius: 1.05 });
}

// ======================================================================
//  SEEDER — artillery frame
// ======================================================================
export function buildRiggedSeeder() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('hull', 'root', [0, 0.8, 0]);
  r.addBone('dome', 'hull', [0, 0.35, 0]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    r.addBone('barrel' + i, 'dome', [Math.cos(a) * 0.5, 0.5, Math.sin(a) * 0.5], [Math.cos(a) * 0.32, 0, -Math.sin(a) * 0.32]);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    r.addBone('leg' + i, 'hull', [Math.cos(a) * 0.95, -0.1, Math.sin(a) * 0.95], [0, -a, 0.35]);
  }

  r.part(PRIM.cyl(8), { bone: 'hull', scale: [2.05, 0.4, 2.05], color: VOID_BODY });
  r.part(PRIM.sph(10, 6), { bone: 'dome', scale: [2.0, 1.1, 2.0], color: VOID_PLATE, flat: false });
  r.part(PRIM.tor(0.5, 0.09, 6, 16), { bone: 'dome', pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0], scale: 2.2, color: PALETTE.amber, emit: 2.4, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'dome', pos: [0, 0.45, -0.9], scale: 0.34, color: PALETTE.amber, emit: 3.0, flat: false });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.cyl(6), { bone: 'barrel' + i, pos: [0, 0.3, 0], scale: [0.26, 0.9, 0.26], color: VOID_TRIM });
    r.part(PRIM.cyl(6), { bone: 'barrel' + i, pos: [0, 0.78, 0], scale: [0.2, 0.14, 0.2], color: PALETTE.amber, emit: 3.2 });
    r.part(PRIM.tor(0.5, 0.1, 5, 10), { bone: 'barrel' + i, pos: [0, 0.55, 0], rot: [Math.PI / 2, 0, 0], scale: 0.62, color: VOID_BODY, flat: false });
  }
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.box(), { bone: 'leg' + i, pos: [0, -0.24, 0], scale: [0.16, 0.5, 0.16], color: VOID_TRIM });
    r.part(PRIM.box(), { bone: 'leg' + i, pos: [0, -0.5, 0], scale: [0.3, 0.1, 0.3], color: VOID_PLATE });
  }

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 3.4);
      c.track('dome', 'rot', [[0, 0, 0, 0], [1.7, 0, 0.5, 0], [3.4, 0, 0, 0]]);
      c.track('hull', 'pos', [[0, 0, 0, 0], [1.7, 0, 0.05, 0], [3.4, 0, 0, 0]]);
      for (let i = 0; i < 4; i++) c.swing('leg' + i, 'z', 0.07, i / 4);
      return c;
    })(),
    fire: (() => {
      const c = new Clip('fire', 0.7, { loop: false });
      for (let i = 0; i < 3; i++) {
        const t = i * 0.06;
        c.track('barrel' + i, 'pos', [[0, 0, 0, 0], [t + 0.04, 0, -0.24, 0], [t + 0.36, 0, 0, 0], [0.7, 0, 0, 0]]);
      }
      c.track('hull', 'pos', [[0, 0, 0, 0], [0.08, 0, -0.14, 0], [0.5, 0, 0, 0], [0.7, 0, 0, 0]]);
      c.track('dome', 'scale', [[0, 1, 1, 1], [0.08, 1.08, 0.92, 1.08], [0.5, 1, 1, 1], [0.7, 1, 1, 1]]);
      return c;
    })(),
  };
  return pack(r, clips, 'seeder', { radius: 1.25 });
}

// ======================================================================
//  LANCER — armoured ram
// ======================================================================
export function buildRiggedLancer() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('body', 'root', [0, 0.95, 0]);
  r.addBone('horn', 'body', [0, -0.05, -1.5]);
  r.addBone('hornL', 'body', [0.45, 0.07, -1.3], [0, 0, 0.3]);
  r.addBone('hornR', 'body', [-0.45, 0.07, -1.3], [0, 0, -0.3]);
  r.addBone('eye', 'body', [0, 0.4, -0.95]);
  const legs = [['FL', 1, -0.5], ['FR', -1, -0.5], ['BL', 1, 0.9], ['BR', -1, 0.9]];
  for (const [id, sx, sz] of legs) r.addBone('leg' + id, 'body', [sx * 0.7, -0.3, sz], [0, 0, -sx * 0.6]);
  r.addBone('boostL', 'body', [0.45, 0, 1.5]);
  r.addBone('boostR', 'body', [-0.45, 0, 1.5]);

  r.part(PRIM.wedge(1.7, 0.95, 3.1, 0.2), { bone: 'body', color: VOID_PLATE });
  r.part(PRIM.wedge(1.15, 0.5, 2.0, 0.35), { bone: 'body', pos: [0, 0.5, -0.3], color: VOID_BODY });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'body', pos: [0, 0.76, -0.6 + i * 0.5], scale: [0.9 - i * 0.15, 0.06, 0.14], color: VOID_TRIM });
  }
  r.part(PRIM.spike(1.5, 0.22, 4), { bone: 'horn', rot: [-Math.PI / 2, 0, Math.PI / 4], color: PALETTE.bone });
  r.part(PRIM.spike(1.0, 0.16, 4), { bone: 'hornL', rot: [-Math.PI / 2, 0, 0.3], color: PALETTE.bone });
  r.part(PRIM.spike(1.0, 0.16, 4), { bone: 'hornR', rot: [-Math.PI / 2, 0, -0.3], color: PALETTE.bone });
  r.part(PRIM.sph(10, 8), { bone: 'eye', scale: 0.42, color: PALETTE.amber, emit: 3.2, flat: false });
  r.part(PRIM.box(), { bone: 'body', pos: [0.85, -0.05, 0.35], scale: [0.16, 0.7, 1.5], color: VOID_TRIM });
  r.part(PRIM.box(), { bone: 'body', pos: [-0.85, -0.05, 0.35], scale: [0.16, 0.7, 1.5], color: VOID_TRIM });
  for (const bone of ['boostL', 'boostR']) {
    r.part(PRIM.cyl(6), { bone, rot: [Math.PI / 2, 0, 0], scale: [0.42, 0.7, 0.42], color: VOID_BODY });
    r.part(PRIM.cyl(6), { bone, pos: [0, 0, 0.32], rot: [Math.PI / 2, 0, 0], scale: [0.3, 0.16, 0.3], color: PALETTE.amber, emit: 3.4 });
  }
  for (const [id] of legs) {
    r.part(PRIM.box(), { bone: 'leg' + id, pos: [0, -0.3, 0], scale: [0.16, 0.66, 0.16], color: VOID_TRIM });
    r.part(PRIM.box(), { bone: 'leg' + id, pos: [0, -0.62, 0], scale: [0.3, 0.12, 0.4], color: VOID_PLATE });
  }

  const clips = {
    prowl: (() => {
      const c = new Clip('prowl', 0.9);
      for (const [id] of legs) c.swing('leg' + id, 'x', 0.4, (id === 'FL' || id === 'BR') ? 0 : 0.5);
      c.track('body', 'pos', [[0, 0, 0, 0], [0.22, 0, 0.07, 0], [0.45, 0, 0, 0], [0.68, 0, 0.07, 0], [0.9, 0, 0, 0]]);
      c.swing('body', 'z', 0.06, 0.25);
      return c;
    })(),
    windup: (() => {
      const c = new Clip('windup', 0.85, { loop: false });
      c.track('body', 'pos', [[0, 0, 0, 0], [0.5, 0, -0.18, 0.55], [0.85, 0, -0.1, 0.3]]);
      c.track('body', 'rot', [[0, 0, 0, 0], [0.5, -0.2, 0, 0], [0.85, -0.14, 0, 0]]);
      c.track('hornL', 'rot', [[0, 0, 0, 0], [0.5, 0, 0, 0.5], [0.85, 0, 0, 0.42]]);
      c.track('hornR', 'rot', [[0, 0, 0, 0], [0.5, 0, 0, -0.5], [0.85, 0, 0, -0.42]]);
      c.track('eye', 'scale', [[0, 1, 1, 1], [0.5, 1.7, 1.7, 1.7], [0.85, 1.5, 1.5, 1.5]]);
      for (const [id] of legs) c.track('leg' + id, 'rot', [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [0.85, 0.35, 0, 0]]);
      return c;
    })(),
    charge: (() => {
      const c = new Clip('charge', 0.5);
      c.track('body', 'pos', [[0, 0, -0.1, 0.1], [0.25, 0, -0.05, -0.05], [0.5, 0, -0.1, 0.1]]);
      c.track('body', 'rot', [[0, 0.14, 0, 0], [0.25, 0.2, 0, 0], [0.5, 0.14, 0, 0]]);
      for (const [id] of legs) c.swing('leg' + id, 'x', 0.7, (id === 'FL' || id === 'BR') ? 0 : 0.5);
      c.track('boostL', 'scale', [[0, 1.3, 1.3, 1.6], [0.25, 1.1, 1.1, 1.3], [0.5, 1.3, 1.3, 1.6]]);
      c.track('boostR', 'scale', [[0, 1.3, 1.3, 1.6], [0.25, 1.1, 1.1, 1.3], [0.5, 1.3, 1.3, 1.6]]);
      return c;
    })(),
    stunned: (() => {
      const c = new Clip('stunned', 0.7);
      c.track('body', 'rot', [[0, 0.2, 0.1, 0.1], [0.35, 0.1, -0.1, -0.1], [0.7, 0.2, 0.1, 0.1]]);
      c.track('body', 'pos', [[0, 0, -0.2, 0], [0.35, 0, -0.14, 0], [0.7, 0, -0.2, 0]]);
      for (const [id] of legs) c.track('leg' + id, 'rot', [[0, 0.3, 0, 0], [0.35, 0.1, 0, 0], [0.7, 0.3, 0, 0]]);
      return c;
    })(),
  };
  return pack(r, clips, 'lancer', { radius: 1.35 });
}

// ======================================================================
//  SENTINEL — siege tripod
// ======================================================================
export function buildRiggedSentinel() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('hip', 'root', [0, 2.0, 0]);
  r.addBone('head', 'hip', [0, 0.5, -0.35]);
  r.addBone('emitter', 'head', [0, -0.05, -0.9]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI / 2;
    r.addBone('leg' + i, 'hip', [Math.cos(a) * 0.7, -0.35, Math.sin(a) * 0.7], [0, -a, 0.55]);
    r.addBone('leg' + i + 'b', 'leg' + i, [0, -0.95, 0], [0, 0, -0.95]);
  }

  r.part(PRIM.wedge(1.5, 1.35, 2.1, 0.45), { bone: 'hip', color: VOID_PLATE });
  r.part(PRIM.cyl(8), { bone: 'hip', pos: [0, 0.6, 0], scale: [1.0, 0.3, 1.0], color: VOID_TRIM });
  r.part(PRIM.box(), { bone: 'head', scale: [1.05, 0.42, 1.05], color: VOID_BODY });
  r.part(PRIM.box(), { bone: 'head', pos: [0, 0.26, 0.2], scale: [0.08, 0.08, 1.4], color: PALETTE.magenta, emit: 2.4 });
  r.part(PRIM.cyl(8), { bone: 'emitter', rot: [Math.PI / 2, 0, 0], scale: [0.5, 1.0, 0.5], color: VOID_TRIM });
  r.part(PRIM.tor(0.5, 0.1, 6, 14), { bone: 'emitter', pos: [0, 0, -0.4], scale: 1.1, color: PALETTE.magenta, emit: 2.8, flat: false });
  r.part(PRIM.sph(10, 8), { bone: 'emitter', pos: [0, 0, -0.52], scale: 0.5, color: 0xff6ec7, emit: 3.4, flat: false });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'leg' + i, pos: [0, -0.48, 0], scale: [0.24, 0.98, 0.24], color: VOID_TRIM });
    r.part(PRIM.oct(0), { bone: 'leg' + i, scale: 0.34, color: VOID_BODY });
    r.part(PRIM.box(), { bone: 'leg' + i + 'b', pos: [0, -0.4, 0], scale: [0.2, 0.82, 0.2], color: VOID_BODY });
    r.part(PRIM.box(), { bone: 'leg' + i + 'b', pos: [0, -0.82, 0], scale: [0.42, 0.14, 0.42], color: VOID_PLATE });
  }

  const clips = {
    walk: (() => {
      const c = new Clip('walk', 1.4);
      for (let i = 0; i < 3; i++) {
        c.swing('leg' + i, 'x', 0.42, i / 3);
        c.swing('leg' + i + 'b', 'x', -0.34, i / 3 + 0.14);
      }
      c.track('hip', 'pos', [[0, 0, 0, 0], [0.23, 0, 0.1, 0], [0.47, 0, 0, 0], [0.7, 0, 0.1, 0], [1.4, 0, 0, 0]]);
      c.swing('head', 'y', 0.06, 0.25);
      return c;
    })(),
    brace: (() => {
      const c = new Clip('brace', 1.05, { loop: false });
      for (let i = 0; i < 3; i++) {
        c.track('leg' + i, 'rot', [[0, 0, 0, 0], [0.5, 0, 0, 0.28], [1.05, 0, 0, 0.34]]);
        c.track('leg' + i + 'b', 'rot', [[0, 0, 0, 0], [0.5, 0, 0, -0.3], [1.05, 0, 0, -0.36]]);
      }
      c.track('hip', 'pos', [[0, 0, 0, 0], [0.5, 0, -0.22, 0], [1.05, 0, -0.28, 0]]);
      c.track('head', 'rot', [[0, 0, 0, 0], [0.5, -0.14, 0, 0], [1.05, -0.18, 0, 0]]);
      c.track('emitter', 'scale', [[0, 1, 1, 1], [0.6, 1.35, 1.35, 1.1], [1.05, 1.5, 1.5, 1.2]]);
      return c;
    })(),
    fire: (() => {
      const c = new Clip('fire', 0.45, { loop: false });
      c.track('emitter', 'pos', [[0, 0, 0, 0], [0.05, 0, 0, 0.3], [0.45, 0, 0, 0]]);
      c.track('emitter', 'scale', [[0, 1.5, 1.5, 1.2], [0.06, 1.9, 1.9, 1.0], [0.45, 1, 1, 1]]);
      c.track('hip', 'pos', [[0, 0, -0.28, 0], [0.06, 0, -0.34, 0.2], [0.45, 0, 0, 0]]);
      c.track('head', 'rot', [[0, -0.18, 0, 0], [0.06, 0.1, 0, 0], [0.45, 0, 0, 0]]);
      return c;
    })(),
  };
  return pack(r, clips, 'sentinel', { radius: 1.4 });
}

export const RIGGED_ENEMIES = {
  skitter: buildRiggedSkitter,
  drone: buildRiggedDrone,
  splitter: buildRiggedSplitter,
  seeder: buildRiggedSeeder,
  lancer: buildRiggedLancer,
  sentinel: buildRiggedSentinel,
};
