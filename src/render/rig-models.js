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

/** Build once, share the geometry + skeleton + compiled clips across instances. */
function pack(builder, clips, name, extra = {}) {
  // Everything with a front faces +Z; pass faceZ:false for radially symmetric
  // shapes that have no meaningful nose.
  const { faceZ, ...rest } = extra;
  const { geometry, skeleton } = builder.build(name, faceZ !== false);
  return { geometry, skeleton, clips: compileClips(skeleton, clips), ...rest };
}

// ======================================================================
//  PLAYER CHASSIS
// ======================================================================
// Warm iron and brass rather than cyan energy. The hulls themselves are still
// the sci-fi chassis — the rider and mount replace them in the cast pass — but
// the colour they throw into muzzle flash, tracers and the ground ring is what
// you actually see most of, so it moves first.
const SHIP_SPEC = {
  striker: { len: 3.0, wid: 1.05, hei: 0.62, wing: 1.35, sweep: 0.5, nac: 2, glow: PALETTE.ember },
  bastion: { len: 2.9, wid: 1.5, hei: 0.86, wing: 1.15, sweep: 0.26, nac: 1, glow: PALETTE.brass },
  phantom: { len: 3.35, wid: 0.82, hei: 0.5, wing: 1.5, sweep: 0.8, nac: 3, glow: 0xffd08a },
};

export function buildRiggedShip(kind = 'striker') {
  const sp = SHIP_SPEC[kind] || SHIP_SPEC.striker;
  const dark = PALETTE.ironDark, mid = PALETTE.iron, lite = PALETTE.timber;
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
  r.part(PRIM.sph(8, 6), { bone: 'canopy', scale: [sp.wid * 0.44, sp.hei * 0.5, sp.len * 0.3], color: sp.glow, emit: 0.54, flat: false });
  r.part(PRIM.tor(0.5, 0.06, 5, 12), { bone: 'canopy', rot: [Math.PI / 2, 0, 0], scale: sp.wid * 0.95, color: lite, flat: false });

  // --- nose lance ---
  r.part(PRIM.cyl(6), { bone: 'nose', rot: [Math.PI / 2, 0, 0], scale: [0.2, 0.55, 0.2], color: PALETTE.hullWhite });
  r.part(PRIM.cyl(6), { bone: 'nose', pos: [0, 0, -0.2], rot: [Math.PI / 2, 0, 0], scale: [0.12, 0.4, 0.12], color: sp.glow, emit: 0.95 });
  r.part(PRIM.tor(0.5, 0.09, 5, 10), { bone: 'nose', pos: [0, 0, -0.08], scale: 0.42, color: sp.glow, emit: 0.75, flat: false });

  // --- wings ---
  for (const [bone, s] of [['wingL', 1], ['wingR', -1]]) {
    r.part(PRIM.wedge(sp.wing, 0.13, 1.5, 0.55), { bone, pos: [s * sp.wing * 0.42, 0, 0], color: mid });
    r.part(PRIM.box(), { bone, pos: [s * sp.wing * 0.82, 0.04, 0.1], scale: [0.1, 0.09, 1.1], color: sp.glow, emit: 0.82 });
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
    r.part(PRIM.tor(0.5, 0.12, 6, 12), { bone, pos: [0, 0, 0.16], scale: w * 1.05, color: sp.glow, emit: 1.02, flat: false });
    r.part(PRIM.cyl(8), { bone, pos: [0, 0, 0.14], rot: [Math.PI / 2, 0, 0], scale: [w * 0.72, 0.16, w * 0.72], color: 0xffffff, emit: 1.16 });
    r.part(PRIM.box(), { bone, pos: [0, w * 0.75, -0.1], scale: [w * 0.4, 0.08, 0.7], color: lite });
  }

  // --- dorsal fin ---
  r.part(PRIM.wedge(0.09, 0.62, 1.1, 0.35), { bone: 'fin', color: lite });
  r.part(PRIM.box(), { bone: 'fin', pos: [0, 0.17, 0], scale: [0.06, 0.05, 0.9], color: sp.glow, emit: 0.88 });

  // --- hover gear ---
  for (const bone of ['gearL', 'gearR', 'gearBL', 'gearBR']) {
    r.part(PRIM.cyl(6), { bone, scale: [0.3, 0.1, 0.3], color: dark });
    r.part(PRIM.cyl(6), { bone, pos: [0, -0.09, 0], scale: [0.22, 0.05, 0.22], color: sp.glow, emit: 0.82 });
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
//  COYOTE — four-legged rusher
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

  // A lean, half-starved coyote. The bones already described a four-legged
  // scuttler with a diagonal gait and a lunge; only the flesh needed replacing.
  r.part(PRIM.sph(9, 7), { bone: 'body', scale: [0.62, 0.56, 0.98], color: PALETTE.hide, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'body', pos: [0, 0.02, 0.44], scale: [0.54, 0.52, 0.5], color: PALETTE.hideDark, flat: false });
  // ribs showing through the hide
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'body', pos: [0, 0.16, -0.18 + i * 0.24], scale: [0.5 - i * 0.05, 0.05, 0.06], color: PALETTE.hideLite });
  }
  // hackles down the spine
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.spike(0.2, 0.05, 3), { bone: 'body', pos: [0, 0.34, -0.3 + i * 0.24], rot: [-0.5, 0, 0], color: PALETTE.mane });
  }
  r.part(PRIM.cyl(6), { bone: 'body', pos: [0, 0.06, 0.72], rot: [1.15, 0, 0], scale: [0.12, 0.62, 0.12], color: PALETTE.mane });
  // head: skull, muzzle, ears, and the one glint that keeps it readable at range
  r.part(PRIM.sph(8, 6), { bone: 'head', scale: [0.3, 0.28, 0.34], color: PALETTE.hide, flat: false });
  r.part(PRIM.spike(0.42, 0.17, 5), { bone: 'head', pos: [0, -0.04, -0.16], rot: [-Math.PI / 2, 0, 0], color: PALETTE.hideDark });
  r.part(PRIM.spike(0.24, 0.1, 3), { bone: 'head', pos: [0.15, 0.22, 0.06], rot: [-0.3, 0, 0.35], color: PALETTE.hideDark });
  r.part(PRIM.spike(0.24, 0.1, 3), { bone: 'head', pos: [-0.15, 0.22, 0.06], rot: [-0.3, 0, -0.35], color: PALETTE.hideDark });
  r.part(PRIM.sph(6, 5), { bone: 'head', pos: [0.13, 0.06, -0.14], scale: 0.06, color: PALETTE.emberDim, emit: 1.5, flat: false });
  r.part(PRIM.sph(6, 5), { bone: 'head', pos: [-0.13, 0.06, -0.14], scale: 0.06, color: PALETTE.emberDim, emit: 1.5, flat: false });

  for (const [id] of legs) {
    r.part(PRIM.cyl(5), { bone: 'leg' + id, pos: [0, -0.26, 0], scale: [0.14, 0.54, 0.14], color: PALETTE.hide });
    r.part(PRIM.sph(6, 5), { bone: 'leg' + id, scale: 0.17, color: PALETTE.hide, flat: false });
    r.part(PRIM.sph(6, 5), { bone: 'leg' + id + 'b', scale: 0.13, color: PALETTE.hideDark, flat: false });
    r.part(PRIM.cyl(5), { bone: 'leg' + id + 'b', pos: [0, -0.28, 0], scale: [0.085, 0.56, 0.085], color: PALETTE.hideDark });
    r.part(PRIM.sph(6, 5), { bone: 'leg' + id + 'b', pos: [0, -0.58, -0.04], scale: [0.12, 0.08, 0.15], color: PALETTE.hideDark, flat: false });
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
  return pack(r, clips, 'skitter', { radius: 0.85, torso: 'body', limbs: ['legFL', 'legFR', 'legBL', 'legBR'] });
}

// ======================================================================
//  BUZZARD — circling standoff attacker
// ======================================================================
export function buildRiggedDrone() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('body', 'root');
  r.addBone('ring', 'body');
  r.addBone('barrel', 'body', [0, -0.12, -0.72]);
  r.addBone('eye', 'body', [0, 0.02, -0.55]);
  // The three hover fins become two wings and a tail. Keeping the `fin0..2`
  // names means every existing clip — the hover bob, the fire recoil, the
  // death tumble — still drives them without being rewritten.
  r.addBone('fin0', 'body', [0.5, 0.06, 0.1], [0, -0.18, 0.12]);   // left wing
  r.addBone('fin1', 'body', [-0.5, 0.06, 0.1], [0, 0.18, -0.12]);  // right wing
  r.addBone('fin2', 'body', [0, 0.0, 0.78], [0.25, 0, 0]);         // tail

  // Buzzard. Ragged, patient, and a nuisance from range — which is exactly the
  // behaviour the archetype already had.
  r.part(PRIM.sph(9, 7), { bone: 'body', scale: [0.38, 0.36, 0.72], color: PALETTE.feather, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'body', pos: [0, 0.14, 0.1], scale: [0.32, 0.26, 0.5], color: PALETTE.featherDark, flat: false });
  // bare neck and hooked head, the two things that say vulture and not hawk
  r.part(PRIM.cyl(6), { bone: 'body', pos: [0, 0.1, -0.42], rot: [1.25, 0, 0], scale: [0.11, 0.36, 0.11], color: PALETTE.hideLite });
  r.part(PRIM.sph(8, 6), { bone: 'eye', scale: [0.19, 0.18, 0.22], color: PALETTE.featherDark, flat: false });
  r.part(PRIM.spike(0.3, 0.11, 5), { bone: 'eye', pos: [0, -0.02, -0.12], rot: [-Math.PI / 2, 0, 0], color: PALETTE.beak });
  r.part(PRIM.sph(6, 5), { bone: 'eye', pos: [0.09, 0.06, -0.06], scale: 0.045, color: PALETTE.emberDim, emit: 1.4, flat: false });
  r.part(PRIM.sph(6, 5), { bone: 'eye', pos: [-0.09, 0.06, -0.06], scale: 0.045, color: PALETTE.emberDim, emit: 1.4, flat: false });
  // the ring bone still turns; it carries the ruff of feathers at the shoulders
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    r.part(PRIM.wedge(0.22, 0.05, 0.3, 0.5), {
      bone: 'ring', pos: [Math.cos(a) * 0.34, 0.16, Math.sin(a) * 0.34 - 0.1],
      rot: [0.4, -a, 0], color: PALETTE.featherLite,
    });
  }
  // it spits, rather than shoots: the barrel is the throat
  r.part(PRIM.cyl(6), { bone: 'barrel', rot: [Math.PI / 2, 0, 0], scale: [0.1, 0.3, 0.1], color: PALETTE.hideLite });
  // wings: a spar with three graded primaries each, so they read at silhouette
  for (const [i, sx] of [[0, 1], [1, -1]]) {
    r.part(PRIM.box(), { bone: 'fin' + i, pos: [sx * 0.5, 0, 0], scale: [1.05, 0.07, 0.34], color: PALETTE.feather });
    r.part(PRIM.wedge(0.5, 0.06, 0.62, 0.35), { bone: 'fin' + i, pos: [sx * 0.34, 0, 0.06], rot: [0, sx * 0.2, 0], color: PALETTE.featherDark });
    for (let k = 0; k < 3; k++) {
      r.part(PRIM.wedge(0.2, 0.045, 0.52 - k * 0.08, 0.6), {
        bone: 'fin' + i, pos: [sx * (0.86 + k * 0.16), 0, 0.12 + k * 0.1],
        rot: [0, sx * (0.3 + k * 0.14), 0], color: k === 1 ? PALETTE.featherLite : PALETTE.featherDark,
      });
    }
  }
  // tail fan
  for (let k = -1; k <= 1; k++) {
    r.part(PRIM.wedge(0.14, 0.05, 0.52, 0.7), { bone: 'fin2', pos: [k * 0.11, 0, 0.2], rot: [0, k * 0.22, 0], color: PALETTE.feather });
  }

  const clips = {
    hover: (() => {
      const c = new Clip('hover', 2.2);
      c.track('body', 'pos', [[0, 0, 0, 0], [1.1, 0, 0.1, 0], [2.2, 0, 0, 0]]);
      // wings beat together and out of phase with the body bob; the tail only trims
      c.swing('fin0', 'z', 0.30, 0);
      c.swing('fin1', 'z', -0.30, 0);
      c.swing('fin2', 'x', 0.10, 0.35);
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
  return pack(r, clips, 'drone', { radius: 1.0, torso: 'body', limbs: ['fin0', 'fin1', 'fin2'] });
}

// ======================================================================
//  POWDER KEG — rolling charge on a short fuse
// ======================================================================
export function buildRiggedSplitter() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('core', 'root');
  for (let i = 0; i < 3; i++) r.addBone('shell' + i, 'root', [0, 0, 0], [i * 0.9, i * 1.4, i * 0.6]);

  // A powder keg on a short fuse. It already wobbled, span and burst into two
  // smaller things — which is a keg, not a lattice.
  r.part(PRIM.cyl(10), { bone: 'core', scale: [1.0, 1.05, 1.0], color: PALETTE.kegWood });
  r.part(PRIM.cyl(10), { bone: 'core', scale: [0.92, 1.12, 0.92], color: PALETTE.timberDark });
  // staves, so it reads as coopered timber rather than a drum
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    r.part(PRIM.box(), {
      bone: 'core', pos: [Math.cos(a) * 0.48, 0, Math.sin(a) * 0.48], rot: [0, -a, 0],
      scale: [0.06, 1.0, 0.16], color: k % 2 ? PALETTE.kegWood : PALETTE.timber,
    });
  }
  // the fuse, lit — the one thing that has to glow, because it is the warning
  r.part(PRIM.cyl(5), { bone: 'core', pos: [0, 0.62, 0], rot: [0.3, 0, 0.2], scale: [0.05, 0.34, 0.05], color: PALETTE.cloth });
  r.part(PRIM.sph(6, 5), { bone: 'core', pos: [0.08, 0.8, 0.03], scale: 0.09, color: PALETTE.ember, emit: 3.4, flat: false });
  // the three shell bones become the iron hoops; they still turn
  for (let i = 0; i < 3; i++) {
    const y = -0.42 + i * 0.42;
    r.part(PRIM.tor(0.5, 0.055, 5, 14), {
      bone: 'shell' + i, pos: [0, y, 0], rot: [Math.PI / 2, 0, 0],
      scale: i === 1 ? 1.08 : 1.0, color: PALETTE.kegBand, flat: false,
    });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + i;
      r.part(PRIM.box(), {
        bone: 'shell' + i, pos: [Math.cos(a) * 0.52, y, Math.sin(a) * 0.52], rot: [0, -a, 0],
        scale: [0.09, 0.09, 0.09], color: PALETTE.iron,
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
  return pack(r, clips, 'splitter', { faceZ: false, radius: 1.05, torso: 'core', limbs: ['shell0', 'shell1', 'shell2'] });
}

// ======================================================================
//  MORTAR CART — lobbed shells from a timber bed
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

  // A mortar cart: a timber bed, a canvas hood over the shells, and a cluster
  // of stubby tubes. It lobbed shells before and it lobs shells now.
  r.part(PRIM.box(), { bone: 'hull', scale: [2.0, 0.34, 2.5], color: PALETTE.timber });
  r.part(PRIM.box(), { bone: 'hull', pos: [0, 0.2, 0], scale: [1.7, 0.24, 2.2], color: PALETTE.timberDark });
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.box(), { bone: 'hull', pos: [0, 0.1, -1.0 + i * 0.66], scale: [2.1, 0.1, 0.12], color: PALETTE.iron });
  }
  r.part(PRIM.sph(10, 6), { bone: 'dome', scale: [1.5, 0.85, 1.7], color: PALETTE.cloth, flat: false });
  r.part(PRIM.tor(0.5, 0.07, 6, 16), { bone: 'dome', pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0], scale: 1.7, color: PALETTE.iron, flat: false });
  // lantern on the driver's post: the tell that it is about to fire
  r.part(PRIM.box(), { bone: 'dome', pos: [0, 0.3, -0.78], scale: [0.2, 0.26, 0.2], color: PALETTE.ironDark });
  r.part(PRIM.sph(8, 6), { bone: 'dome', pos: [0, 0.3, -0.78], scale: 0.14, color: PALETTE.ember, emit: 3.0, flat: false });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.cyl(8), { bone: 'barrel' + i, pos: [0, 0.3, 0], scale: [0.28, 0.86, 0.28], color: PALETTE.gunmetal });
    r.part(PRIM.tor(0.5, 0.09, 5, 12), { bone: 'barrel' + i, pos: [0, 0.68, 0], rot: [Math.PI / 2, 0, 0], scale: 0.7, color: PALETTE.brass, flat: false });
    r.part(PRIM.tor(0.5, 0.1, 5, 10), { bone: 'barrel' + i, pos: [0, 0.4, 0], rot: [Math.PI / 2, 0, 0], scale: 0.66, color: PALETTE.ironDark, flat: false });
  }
  for (let i = 0; i < 4; i++) {
    // the four legs become the wheels and their axle stubs
    r.part(PRIM.cyl(6), { bone: 'leg' + i, pos: [0, -0.2, 0], scale: [0.12, 0.4, 0.12], color: PALETTE.iron });
    r.part(PRIM.tor(0.5, 0.1, 6, 14), { bone: 'leg' + i, pos: [0, -0.5, 0], rot: [0, Math.PI / 2, 0], scale: 1.1, color: PALETTE.timberDark, flat: false });
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI;
      r.part(PRIM.box(), { bone: 'leg' + i, pos: [0, -0.5, 0], rot: [a, Math.PI / 2, 0], scale: [0.05, 1.02, 0.05], color: PALETTE.timber });
    }
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
  return pack(r, clips, 'seeder', { radius: 1.25, torso: 'hull', limbs: ['leg0', 'leg1', 'leg2', 'leg3'] });
}

// ======================================================================
//  LONGHORN — winds up, then charges
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

  // A longhorn. The archetype winds up and crosses the arena in a heartbeat,
  // which is a charging steer with a different set of words on it.
  r.part(PRIM.sph(10, 8), { bone: 'body', scale: [0.82, 0.76, 1.72], color: PALETTE.steerHide, flat: false });
  // rump, and the shoulder hump that gives a steer its profile
  r.part(PRIM.sph(9, 7), { bone: 'body', pos: [0, 0.16, 0.72], scale: [0.74, 0.7, 0.66], color: PALETTE.steerHideDark, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'body', pos: [0, 0.52, -0.42], scale: [0.56, 0.36, 0.72], color: PALETTE.steerHideDark, flat: false });
  // neck, running down to the skull on the horn bone
  r.part(PRIM.cyl(7), { bone: 'body', pos: [0, 0.24, -1.0], rot: [1.35, 0, 0], scale: [0.4, 0.85, 0.44], color: PALETTE.steerHide });
  // skull and muzzle on the forward horn bone
  r.part(PRIM.sph(9, 7), { bone: 'horn', pos: [0, 0.1, 0.5], scale: [0.42, 0.42, 0.55], color: PALETTE.steerHide, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'horn', pos: [0, -0.02, 0.06], scale: [0.3, 0.26, 0.34], color: PALETTE.steerHideDark, flat: false });
  r.part(PRIM.sph(6, 5), { bone: 'horn', pos: [0.11, 0.02, -0.1], scale: 0.07, color: PALETTE.ironDark, flat: false });
  r.part(PRIM.sph(6, 5), { bone: 'horn', pos: [-0.11, 0.02, -0.1], scale: 0.07, color: PALETTE.ironDark, flat: false });
  // The horns are the whole silhouette, so they are big and they sweep: out
  // hard to the side, then forward, then up to a point.
  //
  // A spike points along +Y unrotated, and rotating +Y about Z by θ gives
  // (-sinθ, cosθ, 0) — so a *positive* θ swings it toward -X. The left horn
  // therefore needs a negative angle, which is the opposite of what reads
  // naturally and is why they came out crossed the first time.
  for (const [bone, sx] of [['hornL', 1], ['hornR', -1]]) {
    r.part(PRIM.spike(0.8, 0.22, 6), { bone, pos: [sx * 0.1, 0.16, 0.04], rot: [0, 0, -sx * (Math.PI / 2 - 0.2)], color: PALETTE.bone });
    r.part(PRIM.spike(0.66, 0.15, 6), { bone, pos: [sx * 0.86, 0.3, -0.06], rot: [0.45, 0, -sx * (Math.PI / 2 - 0.55)], color: PALETTE.bone });
    r.part(PRIM.spike(0.5, 0.1, 5), { bone, pos: [sx * 1.3, 0.56, -0.4], rot: [1.0, 0, -sx * 0.8], color: PALETTE.hideLite });
  }
  // a warning glint, kept small — it is the charge tell at distance
  r.part(PRIM.sph(8, 6), { bone: 'eye', pos: [0, -0.16, 0.2], scale: 0.14, color: PALETTE.emberDim, emit: 2.0, flat: false });
  // flanks
  r.part(PRIM.sph(8, 6), { bone: 'body', pos: [0.62, -0.1, 0.2], scale: [0.26, 0.55, 0.9], color: PALETTE.steerHideDark, flat: false });
  r.part(PRIM.sph(8, 6), { bone: 'body', pos: [-0.62, -0.1, 0.2], scale: [0.26, 0.55, 0.9], color: PALETTE.steerHideDark, flat: false });
  for (const bone of ['boostL', 'boostR']) {
    // the boosters become the haunches, and the dust they kick up
    r.part(PRIM.sph(8, 6), { bone, scale: [0.44, 0.52, 0.6], color: PALETTE.steerHide, flat: false });
    r.part(PRIM.cyl(5), { bone, pos: [0, -0.1, 0.3], rot: [1.3, 0, 0], scale: [0.08, 0.5, 0.08], color: PALETTE.mane });
  }
  for (const [id] of legs) {
    r.part(PRIM.cyl(6), { bone: 'leg' + id, pos: [0, -0.3, 0], scale: [0.17, 0.66, 0.17], color: PALETTE.steerHide });
    r.part(PRIM.cyl(6), { bone: 'leg' + id, pos: [0, -0.64, 0], scale: [0.2, 0.16, 0.24], color: PALETTE.ironDark });
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
  return pack(r, clips, 'lancer', { radius: 1.35, torso: 'body', limbs: ['legFL', 'legFR', 'legBL', 'legBR'] });
}

// ======================================================================
//  GATLING WALKER — a boiler on jointed legs
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

  // A gun platform walked out on jointed iron legs: a boiler, a stack, and a
  // Gatling. Weird-west by way of materials — riveted plate, brass and timber —
  // rather than by silhouette, because the archetype has to stay a tall
  // slow-moving thing that paints a line and then deletes it.
  r.part(PRIM.cyl(10), { bone: 'hip', rot: [Math.PI / 2, 0, 0], scale: [1.15, 1.9, 1.15], color: PALETTE.iron });
  r.part(PRIM.cyl(10), { bone: 'hip', pos: [0, 0, 0.5], rot: [Math.PI / 2, 0, 0], scale: [1.2, 0.4, 1.2], color: PALETTE.ironDark });
  // rivet bands around the boiler
  for (let k = 0; k < 3; k++) {
    r.part(PRIM.tor(0.5, 0.07, 6, 16), { bone: 'hip', pos: [0, 0, -0.6 + k * 0.6], scale: 1.28, color: PALETTE.ironDark, flat: false });
  }
  // firebox glow underneath — the weak point, and the only lit part
  r.part(PRIM.box(), { bone: 'hip', pos: [0, -0.5, -0.3], scale: [0.5, 0.3, 0.5], color: PALETTE.ironDark });
  r.part(PRIM.sph(8, 6), { bone: 'hip', pos: [0, -0.58, -0.3], scale: [0.3, 0.16, 0.3], color: PALETTE.ember, emit: 2.6, flat: false });
  // stack
  r.part(PRIM.cyl(8), { bone: 'hip', pos: [0.4, 0.85, 0.5], scale: [0.24, 1.0, 0.24], color: PALETTE.ironDark });
  r.part(PRIM.cyl(8), { bone: 'hip', pos: [0.4, 1.4, 0.5], scale: [0.36, 0.2, 0.36], color: PALETTE.iron });
  // gun mount
  r.part(PRIM.box(), { bone: 'head', scale: [1.0, 0.46, 0.9], color: PALETTE.gunmetal });
  r.part(PRIM.box(), { bone: 'head', pos: [0, 0.3, 0.1], scale: [0.7, 0.2, 0.6], color: PALETTE.timberDark });
  // Gatling: a ring of barrels around a brass hub
  r.part(PRIM.cyl(8), { bone: 'emitter', rot: [Math.PI / 2, 0, 0], scale: [0.34, 0.9, 0.34], color: PALETTE.brass });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU;
    r.part(PRIM.cyl(6), {
      bone: 'emitter', pos: [Math.cos(a) * 0.26, Math.sin(a) * 0.26, -0.1],
      rot: [Math.PI / 2, 0, 0], scale: [0.09, 1.1, 0.09], color: PALETTE.gunmetal,
    });
  }
  r.part(PRIM.tor(0.5, 0.09, 6, 14), { bone: 'emitter', pos: [0, 0, -0.4], scale: 0.9, color: PALETTE.ironDark, flat: false });
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.cyl(6), { bone: 'leg' + i, pos: [0, -0.48, 0], scale: [0.2, 0.98, 0.2], color: PALETTE.iron });
    r.part(PRIM.sph(7, 6), { bone: 'leg' + i, scale: 0.26, color: PALETTE.brass, flat: false });
    r.part(PRIM.cyl(6), { bone: 'leg' + i + 'b', pos: [0, -0.4, 0], scale: [0.16, 0.82, 0.16], color: PALETTE.ironDark });
    r.part(PRIM.box(), { bone: 'leg' + i + 'b', pos: [0, -0.84, 0], scale: [0.38, 0.16, 0.46], color: PALETTE.gunmetal });
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
  return pack(r, clips, 'sentinel', { radius: 1.4, torso: 'hip', limbs: ['leg0', 'leg1', 'leg2'] });
}

export const RIGGED_ENEMIES = {
  skitter: buildRiggedSkitter,
  drone: buildRiggedDrone,
  splitter: buildRiggedSplitter,
  seeder: buildRiggedSeeder,
  lancer: buildRiggedLancer,
  sentinel: buildRiggedSentinel,
};

// ======================================================================
//  BOSSES — one draw call each, fully articulated
// ======================================================================

/** THE WAGON FORT — a turning ring of wagons around a strongbox. */
export function buildRiggedWarden() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('core', 'root');
  r.addBone('halo', 'core');
  r.addBone('ring', 'root');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    r.addBone('plate' + i, 'ring', [Math.cos(a) * 5.6, 0, Math.sin(a) * 5.6], [0, -a + Math.PI / 2, 0]);
  }
  r.addBone('turretL', 'root', [4.4, -1.6, 0], [0, Math.PI / 2, 0]);
  r.addBone('turretR', 'root', [-4.4, -1.6, 0], [0, -Math.PI / 2, 0]);

  // THE WAGON FORT. The bones already described a hovering core inside a
  // turning ring of plates with two turrets — which is a circle of wagons with
  // a strongbox in the middle, drawn by nobody and holding its ground.
  r.part(PRIM.box(), { bone: 'core', scale: [4.6, 3.4, 5.4], color: PALETTE.timber });
  r.part(PRIM.box(), { bone: 'core', pos: [0, 1.9, 0], scale: [4.2, 0.7, 5.0], color: PALETTE.timberDark });
  // iron banding on the strongbox
  for (let i = 0; i < 3; i++) {
    r.part(PRIM.box(), { bone: 'core', pos: [0, -1.2 + i * 1.3, 0], scale: [4.8, 0.28, 5.6], color: PALETTE.ironDark });
  }
  r.part(PRIM.box(), { bone: 'core', pos: [0, 0.4, -2.75], scale: [1.6, 1.6, 0.3], color: PALETTE.brass });
  // strongbox lock: the weak point, and it glows because it has to be found
  r.part(PRIM.sph(10, 8), { bone: 'core', pos: [0, 0.4, -2.95], scale: 0.55, color: PALETTE.ember, emit: 2.8, flat: false });
  // rifle barrels bristling over the top
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    r.part(PRIM.cyl(6), {
      bone: 'core', pos: [Math.cos(a) * 2.0, 2.2, Math.sin(a) * 2.0],
      rot: [Math.PI / 2, -a + Math.PI / 2, 0], scale: [0.16, 2.4, 0.16], color: PALETTE.gunmetal,
    });
  }
  // dust thrown up as it turns, in place of the old energy halo
  r.part(PRIM.tor(0.5, 0.09, 6, 24), { bone: 'halo', rot: [Math.PI / 2, 0, 0], scale: 6.4, color: PALETTE.sand, flat: false });
  r.part(PRIM.tor(0.5, 0.06, 6, 20), { bone: 'halo', rot: [Math.PI / 2, 0, 0], scale: 5.4, color: PALETTE.dirt, flat: false });

  // the ring: a rope line strung between the wagons
  r.part(PRIM.tor(0.5, 0.045, 8, 32), { bone: 'ring', rot: [Math.PI / 2, 0, 0], scale: 11.2, color: PALETTE.cloth, flat: false });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    // hitching posts with a lantern on each
    r.part(PRIM.cyl(6), { bone: 'ring', pos: [Math.cos(a) * 5.6, 0.5, Math.sin(a) * 5.6], scale: [0.2, 1.8, 0.2], color: PALETTE.timberDark });
    r.part(PRIM.sph(8, 6), { bone: 'ring', pos: [Math.cos(a) * 5.6, 1.5, Math.sin(a) * 5.6], scale: 0.3, color: PALETTE.ember, emit: 2.2, flat: false });
  }
  // four wagons, one per plate bone
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.box(), { bone: 'plate' + i, scale: [2.4, 1.0, 3.4], color: PALETTE.timber });
    r.part(PRIM.box(), { bone: 'plate' + i, pos: [0, 0.7, 0], scale: [2.2, 0.5, 3.2], color: PALETTE.timberDark });
    // canvas tilt over the bed
    r.part(PRIM.cyl(8), { bone: 'plate' + i, pos: [0, 1.1, 0], rot: [Math.PI / 2, 0, 0], scale: [1.15, 3.0, 1.15], color: PALETTE.cloth });
    for (const sx of [1, -1]) {
      r.part(PRIM.tor(0.5, 0.12, 6, 14), { bone: 'plate' + i, pos: [sx * 1.25, -0.5, 1.0], rot: [0, Math.PI / 2, 0], scale: 2.0, color: PALETTE.timberDark, flat: false });
      r.part(PRIM.tor(0.5, 0.12, 6, 14), { bone: 'plate' + i, pos: [sx * 1.25, -0.5, -1.0], rot: [0, Math.PI / 2, 0], scale: 2.0, color: PALETTE.timberDark, flat: false });
    }
  }
  // two Gatlings on the flanks
  for (const bone of ['turretL', 'turretR']) {
    r.part(PRIM.box(), { bone, scale: [1.0, 0.9, 1.4], color: PALETTE.ironDark });
    r.part(PRIM.cyl(8), { bone, pos: [0, 0.2, -0.9], rot: [Math.PI / 2, 0, 0], scale: [0.42, 1.9, 0.42], color: PALETTE.brass });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      r.part(PRIM.cyl(6), {
        bone, pos: [Math.cos(a) * 0.3, 0.2 + Math.sin(a) * 0.3, -1.0],
        rot: [Math.PI / 2, 0, 0], scale: [0.1, 2.0, 0.1], color: PALETTE.gunmetal,
      });
    }
  }

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 4.0);
      c.track('core', 'pos', [[0, 0, 0, 0], [2, 0, 0.6, 0], [4, 0, 0, 0]]);
      c.swing('core', 'x', 0.08);
      for (let i = 0; i < 4; i++) {
        c.track('plate' + i, 'pos', [[0, 0, 0, 0], [2, 0, 0.9 * (i % 2 ? 1 : -1), 0], [4, 0, 0, 0]]);
        c.swing('plate' + i, 'z', 0.16, i / 4);
      }
      c.swing('turretL', 'x', 0.1, 0.2);
      c.swing('turretR', 'x', 0.1, 0.7);
      return c;
    })(),
    slam: (() => {
      const c = new Clip('slam', 2.0, { loop: false });
      c.track('core', 'pos', [[0, 0, 0, 0], [1.05, 0, 3.6, 0], [1.2, 0, -2.2, 0], [2.0, 0, 0, 0]]);
      c.track('core', 'scale', [[0, 1, 1, 1], [1.0, 0.86, 1.2, 0.86], [1.2, 1.3, 0.7, 1.3], [2.0, 1, 1, 1]]);
      for (let i = 0; i < 4; i++) {
        c.track('plate' + i, 'pos', [[0, 0, 0, 0], [1.0, 0, 2.0, -1.6], [1.25, 0, -0.8, 2.4], [2.0, 0, 0, 0]]);
        c.track('plate' + i, 'rot', [[0, 0, 0, 0], [1.0, -0.5, 0, 0], [1.25, 0.6, 0, 0], [2.0, 0, 0, 0]]);
      }
      return c;
    })(),
    barrage: (() => {
      const c = new Clip('barrage', 1.2);
      c.track('core', 'scale', [[0, 1, 1, 1], [0.15, 1.14, 1.14, 1.14], [0.6, 1, 1, 1], [1.2, 1, 1, 1]]);
      for (let i = 0; i < 4; i++) c.track('plate' + i, 'pos', [[0, 0, 0, 0], [0.6, 0, 0, -1.1], [1.2, 0, 0, 0]]);
      c.track('turretL', 'pos', [[0, 0, 0, 0], [0.1, 0, 0, 0.5], [0.5, 0, 0, 0], [1.2, 0, 0, 0]]);
      c.track('turretR', 'pos', [[0, 0, 0, 0], [0.3, 0, 0, 0.5], [0.7, 0, 0, 0], [1.2, 0, 0, 0]]);
      return c;
    })(),
    summon: (() => {
      const c = new Clip('summon', 1.4, { loop: false });
      for (let i = 0; i < 4; i++) {
        c.track('plate' + i, 'rot', [[0, 0, 0, 0], [0.5, 0, 0, -1.1], [1.0, 0, 0, -1.1], [1.4, 0, 0, 0]]);
        c.track('plate' + i, 'pos', [[0, 0, 0, 0], [0.5, 0, 1.4, 0], [1.0, 0, 1.4, 0], [1.4, 0, 0, 0]]);
      }
      c.track('core', 'scale', [[0, 1, 1, 1], [0.6, 1.24, 1.24, 1.24], [1.4, 1, 1, 1]]);
      return c;
    })(),
    rage: (() => {
      const c = new Clip('rage', 1.6, { loop: false });
      c.track('core', 'scale', [[0, 1, 1, 1], [0.2, 1.5, 1.5, 1.5], [0.8, 0.9, 0.9, 0.9], [1.6, 1, 1, 1]]);
      for (let i = 0; i < 4; i++) {
        c.track('plate' + i, 'pos', [[0, 0, 0, 0], [0.25, 0, 2.6, -2.6], [1.6, 0, 0, 0]]);
        c.track('plate' + i, 'rot', [[0, 0, 0, 0], [0.25, 1.2, 0.8, 0], [1.6, 0, 0, 0]]);
      }
      return c;
    })(),
  };
  return pack(r, clips, 'warden', { radius: 6.4 });
}

/** THE IRON HORSE — a locomotive: cowcatcher, side rods, and carriages behind. */
export function buildRiggedHarrower() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('core', 'root');
  r.addBone('spear', 'core', [0, 0.2, -5.4]);
  r.addBone('armL', 'core', [3.4, 0.4, -0.5]);
  r.addBone('armR', 'core', [-3.4, 0.4, -0.5]);
  r.addBone('tail0', 'core', [0, 0.1, 3.6]);
  r.addBone('tail1', 'tail0', [0, 0, 1.15]);
  r.addBone('tail2', 'tail1', [0, 0, 1.15]);
  r.addBone('tail3', 'tail2', [0, 0, 1.15]);

  // THE IRON HORSE. A long body with a spear out front, two side arms and a
  // four-segment tail behind it — a locomotive with a cowcatcher, side rods
  // and a string of carriages, and it was already the boss that charges.
  r.part(PRIM.cyl(10), { bone: 'core', rot: [Math.PI / 2, 0, 0], scale: [2.1, 8.4, 2.1], color: PALETTE.iron });
  r.part(PRIM.cyl(10), { bone: 'core', pos: [0, 0, -2.4], rot: [Math.PI / 2, 0, 0], scale: [2.35, 1.4, 2.35], color: PALETTE.ironDark });
  // boiler bands
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.tor(0.5, 0.1, 6, 20), { bone: 'core', pos: [0, 0, -1.6 + i * 1.7], rot: [0, 0, 0], scale: 4.6, color: PALETTE.ironDark, flat: false });
  }
  // cab at the back, timber and iron
  r.part(PRIM.box(), { bone: 'core', pos: [0, 1.5, 2.9], scale: [3.4, 3.0, 2.6], color: PALETTE.timberDark });
  r.part(PRIM.box(), { bone: 'core', pos: [0, 3.1, 2.9], scale: [3.8, 0.35, 3.0], color: PALETTE.iron });
  // smokestack and the firebox glare through the grate
  r.part(PRIM.cyl(8), { bone: 'core', pos: [0, 2.6, -2.6], scale: [0.55, 2.0, 0.55], color: PALETTE.ironDark });
  r.part(PRIM.cyl(8), { bone: 'core', pos: [0, 3.7, -2.6], scale: [0.95, 0.5, 0.95], color: PALETTE.gunmetal });
  r.part(PRIM.sph(12, 10), { bone: 'core', pos: [0, -0.3, -3.2], scale: [1.3, 1.1, 0.6], color: PALETTE.ember, emit: 2.8, flat: false });
  // headlamp
  r.part(PRIM.cyl(8), { bone: 'core', pos: [0, 1.6, -3.9], rot: [Math.PI / 2, 0, 0], scale: [0.55, 0.7, 0.55], color: PALETTE.brass });
  r.part(PRIM.sph(10, 8), { bone: 'core', pos: [0, 1.6, -4.2], scale: 0.42, color: 0xffe6a8, emit: 3.4, flat: false });

  // cowcatcher
  r.part(PRIM.wedge(3.4, 1.8, 2.4, 0.15), { bone: 'spear', pos: [0, -0.4, 0.8], color: PALETTE.ironDark });
  for (let k = -3; k <= 3; k++) {
    r.part(PRIM.box(), { bone: 'spear', pos: [k * 0.42, -0.4, 0.4], rot: [0.5, 0, 0], scale: [0.12, 2.4, 0.12], color: PALETTE.iron });
  }

  // side rods and driving wheels
  for (const [bone, s] of [['armL', 1], ['armR', -1]]) {
    r.part(PRIM.box(), { bone, pos: [0, 0, 1.6], scale: [0.5, 0.4, 5.6], color: PALETTE.gunmetal });
    r.part(PRIM.cyl(6), { bone, pos: [0, 0, -0.9], rot: [Math.PI / 2, 0, 0], scale: [1.0, 1.6, 1.0], color: PALETTE.ironDark });
    for (const z of [-1.2, 1.0, 3.0]) {
      r.part(PRIM.tor(0.5, 0.16, 6, 16), { bone, pos: [0, -0.5, z], rot: [0, Math.PI / 2, 0], scale: 3.0, color: PALETTE.ironDark, flat: false });
      for (let k = 0; k < 4; k++) {
        r.part(PRIM.box(), { bone, pos: [0, -0.5, z], rot: [(k / 4) * Math.PI, Math.PI / 2, 0], scale: [0.13, 2.8, 0.13], color: PALETTE.iron });
      }
    }
    r.part(PRIM.box(), { bone, pos: [s * 0.35, 0.7, 1.2], scale: [0.3, 1.4, 2.4], color: PALETTE.iron });
  }
  // carriages
  for (let i = 0; i < 4; i++) {
    r.part(PRIM.box(), { bone: 'tail' + i, scale: [2.9 - i * 0.28, 1.9, 1.1], color: i % 2 ? PALETTE.timberDark : PALETTE.timber });
    r.part(PRIM.box(), { bone: 'tail' + i, pos: [0, 1.05, 0], scale: [3.1 - i * 0.28, 0.22, 1.2], color: PALETTE.iron });
    for (const sx of [1, -1]) {
      r.part(PRIM.tor(0.5, 0.12, 6, 12), { bone: 'tail' + i, pos: [sx * (1.4 - i * 0.14), -0.9, 0], rot: [0, Math.PI / 2, 0], scale: 1.5, color: PALETTE.ironDark, flat: false });
    }
    r.part(PRIM.sph(8, 6), { bone: 'tail' + i, pos: [0, 0.4, -0.6], scale: 0.24, color: PALETTE.ember, emit: 1.8, flat: false });
  }

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 3.2);
      c.swing('core', 'z', 0.06);
      c.track('core', 'pos', [[0, 0, 0, 0], [1.6, 0, 0.5, 0], [3.2, 0, 0, 0]]);
      for (let i = 0; i < 4; i++) c.swing('tail' + i, 'y', 0.16, i * 0.12);
      c.swing('armL', 'y', 0.18, 0.1);
      c.swing('armR', 'y', -0.18, 0.1);
      return c;
    })(),
    sweep: (() => {
      const c = new Clip('sweep', 1.0, { loop: false });
      c.track('armL', 'rot', [[0, 0, 0, 0], [0.5, 0, -0.55, 0], [1.0, 0, -0.62, 0]]);
      c.track('armR', 'rot', [[0, 0, 0, 0], [0.5, 0, 0.55, 0], [1.0, 0, 0.62, 0]]);
      c.track('armL', 'pos', [[0, 0, 0, 0], [1.0, 0.5, 0, -0.8]]);
      c.track('armR', 'pos', [[0, 0, 0, 0], [1.0, -0.5, 0, -0.8]]);
      c.track('core', 'rot', [[0, 0, 0, 0], [1.0, -0.1, 0, 0]]);
      return c;
    })(),
    charge: (() => {
      const c = new Clip('charge', 0.8);
      c.track('core', 'rot', [[0, 0.16, 0, 0], [0.4, 0.22, 0, 0], [0.8, 0.16, 0, 0]]);
      c.track('armL', 'rot', [[0, 0, 0.5, 0], [0.8, 0, 0.5, 0]]);
      c.track('armR', 'rot', [[0, 0, -0.5, 0], [0.8, 0, -0.5, 0]]);
      for (let i = 0; i < 4; i++) c.swing('tail' + i, 'y', 0.34, i * 0.16);
      return c;
    })(),
    volley: (() => {
      const c = new Clip('volley', 0.7, { loop: false });
      c.track('core', 'pos', [[0, 0, 0, 0], [0.08, 0, 0, 0.8], [0.5, 0, 0, 0], [0.7, 0, 0, 0]]);
      c.track('armL', 'pos', [[0, 0, 0, 0], [0.08, 0, 0, 0.7], [0.5, 0, 0, 0], [0.7, 0, 0, 0]]);
      c.track('armR', 'pos', [[0, 0, 0, 0], [0.08, 0, 0, 0.7], [0.5, 0, 0, 0], [0.7, 0, 0, 0]]);
      return c;
    })(),
  };
  return pack(r, clips, 'harrower', { radius: 5.4 });
}

/** THE RATTLER — a coiled body that opens on a vulnerable eye. */
export function buildRiggedMaw() {
  const r = new RigBuilder();
  r.addBone('root');
  r.addBone('core', 'root');
  r.addBone('ring', 'root');
  r.addBone('jawT', 'root', [0, 2.6, -3.4]);
  r.addBone('jawB', 'root', [0, -2.6, -3.4]);
  r.addBone('eye', 'root', [0, 0, -4.2]);

  // THE RATTLER. A coiled body, a hinged jaw and one eye — which was already
  // what the bones described, once the neon came off it.
  r.part(PRIM.sph(16, 12), { bone: 'core', scale: [4.4, 3.6, 4.6], color: PALETTE.hideDark, flat: false });
  // banded scales down the coil
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const rr = 4.2 * Math.sin(0.35 + t * 2.4);
    r.part(PRIM.tor(0.5, 0.16, 6, 20), {
      bone: 'core', pos: [0, -2.6 + t * 5.4, 0], rot: [Math.PI / 2, 0, 0],
      scale: rr * 2.0, color: i % 2 ? PALETTE.hide : PALETTE.hideDark, flat: false,
    });
  }
  // belly plates, paler, the way a snake's underside is
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    r.part(PRIM.box(), {
      bone: 'core', pos: [Math.cos(a) * 3.9, -1.6, Math.sin(a) * 3.9],
      rot: [0, -a, 0.2], scale: [0.9, 0.16, 1.5], color: PALETTE.hideLite,
    });
  }
  // the rattle, on the turning ring — it is the telegraph, so it is the loud part
  r.part(PRIM.tor(0.5, 0.06, 6, 30), { bone: 'ring', rot: [Math.PI / 2, 0, 0], scale: 13.0, color: PALETTE.hideDark, flat: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    r.part(PRIM.cyl(7), {
      bone: 'ring', pos: [Math.cos(a) * 6.5, 0, Math.sin(a) * 6.5],
      rot: [Math.PI / 2, -a, 0], scale: [0.75, 1.1, 0.75], color: PALETTE.bone,
    });
  }
  // jaws: hide above, pale gum below, fangs on both
  for (const [bone, s] of [['jawT', 1], ['jawB', -1]]) {
    r.part(PRIM.wedge(5.0, 1.4, 5.0, 0.35), { bone, rot: [s * 0.2, 0, s > 0 ? 0 : Math.PI], color: s > 0 ? PALETTE.hide : PALETTE.hideLite });
    for (let i = 0; i < 5; i++) {
      const big = i === 0 || i === 4;
      r.part(PRIM.spike(big ? 2.3 : 1.4, big ? 0.32 : 0.22, 5), {
        bone, pos: [-1.8 + i * 0.9, s * -0.3, -2.0], rot: [s * -Math.PI * 0.62, 0, 0], color: PALETTE.bone,
      });
    }
    // the throat, glimpsed when the jaw opens: the strike telegraph
    r.part(PRIM.box(), { bone, pos: [0, s * 0.6, 0.4], scale: [3.6, 0.14, 0.2], color: PALETTE.emberDim, emit: 2.2 });
  }
  r.part(PRIM.sph(12, 10), { bone: 'eye', scale: [1.2, 1.3, 1.0], color: 0xd8c060, emit: 1.6, flat: false });
  r.part(PRIM.box(), { bone: 'eye', pos: [0, 0, -0.62], scale: [0.22, 1.5, 0.5], color: PALETTE.ironDark });
  r.part(PRIM.tor(0.5, 0.14, 6, 14), { bone: 'eye', rot: [Math.PI / 2, 0, 0], scale: 2.0, color: PALETTE.hideDark, flat: false });

  const clips = {
    idle: (() => {
      const c = new Clip('idle', 5.0);
      c.track('core', 'rot', [[0, 0, 0, 0], [2.5, 0.2, 0.4, 0.1], [5.0, 0, 0, 0]]);
      c.track('jawT', 'rot', [[0, 0, 0, 0], [2.5, -0.08, 0, 0], [5.0, 0, 0, 0]]);
      c.track('jawB', 'rot', [[0, 0, 0, 0], [2.5, 0.08, 0, 0], [5.0, 0, 0, 0]]);
      c.track('eye', 'scale', [[0, 0.2, 0.2, 0.2], [5.0, 0.2, 0.2, 0.2]]);
      return c;
    })(),
    open: (() => {
      const c = new Clip('open', 1.2, { loop: false });
      c.track('jawT', 'rot', [[0, 0, 0, 0], [1.2, -0.62, 0, 0]]);
      c.track('jawB', 'rot', [[0, 0, 0, 0], [1.2, 0.62, 0, 0]]);
      c.track('jawT', 'pos', [[0, 0, 0, 0], [1.2, 0, 2.4, 0.6]]);
      c.track('jawB', 'pos', [[0, 0, 0, 0], [1.2, 0, -2.4, 0.6]]);
      c.track('eye', 'scale', [[0, 0.2, 0.2, 0.2], [1.2, 1.25, 1.25, 1.25]]);
      c.track('core', 'scale', [[0, 1, 1, 1], [1.2, 0.94, 0.94, 1.06]]);
      return c;
    })(),
    slam: (() => {
      const c = new Clip('slam', 1.5, { loop: false });
      c.track('jawT', 'rot', [[0, -0.62, 0, 0], [0.1, -0.7, 0, 0], [0.22, 0.12, 0, 0], [1.5, 0, 0, 0]]);
      c.track('jawB', 'rot', [[0, 0.62, 0, 0], [0.1, 0.7, 0, 0], [0.22, -0.12, 0, 0], [1.5, 0, 0, 0]]);
      c.track('jawT', 'pos', [[0, 0, 2.4, 0.6], [0.22, 0, -0.3, 0], [1.5, 0, 0, 0]]);
      c.track('jawB', 'pos', [[0, 0, -2.4, 0.6], [0.22, 0, 0.3, 0], [1.5, 0, 0, 0]]);
      c.track('core', 'scale', [[0, 1, 1, 1], [0.24, 1.16, 0.86, 1.16], [1.5, 1, 1, 1]]);
      c.track('eye', 'scale', [[0, 1.25, 1.25, 1.25], [0.3, 0.2, 0.2, 0.2], [1.5, 0.2, 0.2, 0.2]]);
      return c;
    })(),
    devour: (() => {
      const c = new Clip('devour', 1.6);
      c.track('jawT', 'rot', [[0, -0.7, 0, 0], [0.8, -0.85, 0, 0], [1.6, -0.7, 0, 0]]);
      c.track('jawB', 'rot', [[0, 0.7, 0, 0], [0.8, 0.85, 0, 0], [1.6, 0.7, 0, 0]]);
      c.track('jawT', 'pos', [[0, 0, 2.6, 0.6], [1.6, 0, 2.6, 0.6]]);
      c.track('jawB', 'pos', [[0, 0, -2.6, 0.6], [1.6, 0, -2.6, 0.6]]);
      c.track('eye', 'scale', [[0, 1.3, 1.3, 1.3], [0.8, 1.6, 1.6, 1.6], [1.6, 1.3, 1.3, 1.3]]);
      c.track('core', 'rot', [[0, 0, 0, 0], [0.8, 0, 0.3, 0], [1.6, 0, 0, 0]]);
      return c;
    })(),
  };
  return pack(r, clips, 'maw', { radius: 7.8 });
}

export const RIGGED_BOSSES = {
  warden: buildRiggedWarden,
  harrower: buildRiggedHarrower,
  maw: buildRiggedMaw,
};
