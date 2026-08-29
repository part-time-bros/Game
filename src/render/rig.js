/**
 * rig.js — skeletal animation for hard-surface models.
 *
 * three.js's own skinning path needs GLSL3 texelFetch, which would force the
 * whole shader family to ES 3.00. These models are robots: every vertex belongs
 * to exactly one bone, so a leaner rigid-bind skin does the job — a single
 * `aBone` attribute plus a small mat4 uniform array. That keeps one draw call
 * per entity, works in GLSL1, and costs one matrix multiply per vertex.
 *
 * Authoring model:
 *   - bones are declared parent-first with a bind transform
 *   - parts are authored in their OWN bone's local space
 *   - so the shader is just `uBones[aBone] * position` — no inverse bind needed
 *
 * On top sits a small animation system: clips with position/rotation/scale
 * tracks, crossfading, one-shot clips with callbacks, playback speed, and
 * procedural overlays (aim tracking, recoil) applied after clip evaluation.
 */
import { clamp01, lerp, TAU } from '../core/util.js';

export const MAX_BONES = 18;

/** Builds a bone hierarchy + a skinned geometry in one pass. */
export class RigBuilder {
  constructor() {
    this.bones = [];
    this.index = new Map();
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.emi = [];
    this.bone = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /** bone(name, parent, pos, rot) — parents must be declared first. */
  addBone(name, parent = null, pos = [0, 0, 0], rot = [0, 0, 0]) {
    if (this.index.has(name)) throw new Error(`rig: duplicate bone "${name}"`);
    const parentIndex = parent === null ? -1 : this.index.get(parent);
    if (parent !== null && parentIndex === undefined) throw new Error(`rig: unknown parent "${parent}"`);
    const i = this.bones.length;
    this.index.set(name, i);
    this.bones.push({ name, parent: parentIndex, pos: pos.slice(), rot: rot.slice() });
    if (this.bones.length > MAX_BONES) throw new Error(`rig: over ${MAX_BONES} bones`);
    return i;
  }

  /**
   * part(geometry, { bone, pos, rot, scale, color, emit, flat })
   * pos/rot/scale are relative to the bone's own space.
   */
  part(geo, o = {}) {
    const boneName = o.bone === undefined ? this.bones[0].name : o.bone;
    const boneIndex = this.index.get(boneName);
    if (boneIndex === undefined) throw new Error(`rig: part references unknown bone "${boneName}"`);

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
    this._c.set(o.color === undefined ? 0xffffff : o.color);
    const emit = o.emit === undefined ? 0 : o.emit;
    for (let i = 0; i < posAttr.count; i++) {
      this.pos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      this.nrm.push(nrmAttr.getX(i), nrmAttr.getY(i), nrmAttr.getZ(i));
      this.col.push(this._c.r, this._c.g, this._c.b);
      this.emi.push(emit);
      this.bone.push(boneIndex);
    }
    g.dispose();
    return this;
  }

  /** Mirror a part across X onto a second bone (limbs, wings, nacelles). */
  partMirrored(geo, o = {}, mirrorBone) {
    this.part(geo, o);
    const p = (o.pos || [0, 0, 0]).slice();
    const r = (o.rot || [0, 0, 0]).slice();
    p[0] = -p[0]; r[1] = -r[1]; r[2] = -r[2];
    this.part(geo, { ...o, pos: p, rot: r, bone: mirrorBone || o.bone });
    return this;
  }

  build(name = 'rig') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emi, 1));
    g.setAttribute('aBone', new THREE.Float32BufferAttribute(this.bone, 1));
    g.name = name;
    // The bind pose is not the animated pose, so bounds are computed generously.
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius *= 1.9;
    g.computeBoundingBox();
    return { geometry: g, skeleton: new Skeleton(this.bones, name) };
  }
}

/** Shared, immutable description of a bone hierarchy. */
export class Skeleton {
  constructor(bones, name = 'skeleton') {
    this.name = name;
    this.bones = bones;
    this.count = bones.length;
    this.index = new Map();
    bones.forEach((b, i) => this.index.set(b.name, i));
    // flat bind pose arrays: 3 floats each for position / euler / scale
    this.bindPos = new Float32Array(this.count * 3);
    this.bindRot = new Float32Array(this.count * 3);
    this.bindScale = new Float32Array(this.count * 3);
    bones.forEach((b, i) => {
      this.bindPos.set(b.pos, i * 3);
      this.bindRot.set(b.rot, i * 3);
      this.bindScale.set([1, 1, 1], i * 3);
    });
  }
  boneIndex(name) { return this.index.has(name) ? this.index.get(name) : -1; }
}

const _mat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * A live pose for one entity: local TRS per bone, resolved into the flat
 * matrix array the shader reads.
 */
export class Pose {
  constructor(skeleton) {
    this.skeleton = skeleton;
    const n = skeleton.count;
    this.pos = new Float32Array(skeleton.bindPos);
    this.rot = new Float32Array(skeleton.bindRot);
    this.scale = new Float32Array(skeleton.bindScale);
    this.matrices = new Array(n);
    for (let i = 0; i < n; i++) this.matrices[i] = new THREE.Matrix4();
    // padded so every material can declare the same array length
    this.uniform = new Array(MAX_BONES);
    for (let i = 0; i < MAX_BONES; i++) this.uniform[i] = i < n ? this.matrices[i] : new THREE.Matrix4();
  }

  resetToBind() {
    this.pos.set(this.skeleton.bindPos);
    this.rot.set(this.skeleton.bindRot);
    this.scale.set(this.skeleton.bindScale);
  }

  /** Resolve local transforms into world (model-space) matrices. */
  update() {
    const sk = this.skeleton;
    for (let i = 0; i < sk.count; i++) {
      const i3 = i * 3;
      _v.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      _e.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
      _q.setFromEuler(_e);
      _s.set(this.scale[i3], this.scale[i3 + 1], this.scale[i3 + 2]);
      _mat.compose(_v, _q, _s);
      const parent = sk.bones[i].parent;
      if (parent < 0) this.matrices[i].copy(_mat);
      else this.matrices[i].multiplyMatrices(this.matrices[parent], _mat);
    }
  }
}

/**
 * Clip authoring helper.
 *
 * track(bone, channel, keys) where keys is [[time, x, y, z], ...]; values are
 * OFFSETS from the bind pose for rotation and position, and absolute for scale.
 */
export class Clip {
  constructor(name, duration, opts = {}) {
    this.name = name;
    this.duration = duration;
    this.loop = opts.loop !== false;
    this.tracks = [];
  }
  track(bone, channel, keys) {
    this.tracks.push({ bone, channel, keys, boneIndex: -1 });
    return this;
  }
  /** Convenience: a symmetric swing on one axis. */
  swing(bone, axis, amount, phase = 0, channel = 'rot') {
    const a = ['x', 'y', 'z'].indexOf(axis);
    const keys = [];
    for (let i = 0; i <= 4; i++) {
      const t = (i / 4) * this.duration;
      const v = Math.sin((i / 4 + phase) * TAU) * amount;
      const k = [t, 0, 0, 0];
      k[a + 1] = v;
      keys.push(k);
    }
    return this.track(bone, channel, keys);
  }
  compile(skeleton) {
    for (const t of this.tracks) t.boneIndex = skeleton.boneIndex(t.bone);
    this.tracks = this.tracks.filter((t) => t.boneIndex >= 0);
    return this;
  }
}

function sampleTrack(track, time) {
  const keys = track.keys;
  const n = keys.length;
  if (n === 1) return keys[0];
  let i = 0;
  while (i < n - 1 && keys[i + 1][0] <= time) i++;
  if (i >= n - 1) return keys[n - 1];
  const a = keys[i], b = keys[i + 1];
  const span = b[0] - a[0];
  const t = span > 0 ? clamp01((time - a[0]) / span) : 0;
  // smoothstep between keys: linear joints read as robotic in a bad way
  const k = t * t * (3 - 2 * t);
  _sampleWrap[1] = lerp(a[1], b[1], k);
  _sampleWrap[2] = lerp(a[2], b[2], k);
  _sampleWrap[3] = lerp(a[3], b[3], k);
  return _sampleWrap;
}
// one reusable key tuple: sampling runs thousands of times per frame
const _sampleWrap = [0, 0, 0, 0];

/**
 * Plays clips onto a Pose with crossfading, then lets gameplay layer
 * procedural offsets (aim tracking, recoil kicks) on top.
 */
export class Animator {
  constructor(pose, clips) {
    this.pose = pose;
    this.clips = clips;
    this.current = null;
    this.previous = null;
    this.time = 0;
    this.prevTime = 0;
    this.fade = 1;
    this.fadeSpeed = 0;
    this.speed = 1;
    this.onEnd = null;
    this.finished = false;
    const n = pose.skeleton.count * 3;
    this._posA = new Float32Array(n);
    this._rotA = new Float32Array(n);
    this._sclA = new Float32Array(n);
    this._posB = new Float32Array(n);
    this._rotB = new Float32Array(n);
    this._sclB = new Float32Array(n);
    this._overlayRot = new Float32Array(n);
    this._overlayPos = new Float32Array(n);
  }

  play(name, opts = {}) {
    const clip = this.clips[name];
    if (!clip || (this.current === clip && !opts.restart)) return this;
    this.previous = this.current;
    this.prevTime = this.time;
    this.current = clip;
    this.time = opts.at || 0;
    this.speed = opts.speed === undefined ? 1 : opts.speed;
    this.onEnd = opts.onEnd || null;
    this.finished = false;
    const fade = opts.fade === undefined ? 0.16 : opts.fade;
    this.fade = this.previous && fade > 0 ? 0 : 1;
    this.fadeSpeed = fade > 0 ? 1 / fade : 0;
    return this;
  }

  get playing() { return this.current ? this.current.name : null; }

  /** Additive offset applied after clip evaluation; cleared every update. */
  offsetRot(boneName, x, y, z) {
    const i = this.pose.skeleton.boneIndex(boneName);
    if (i < 0) return;
    const i3 = i * 3;
    this._overlayRot[i3] += x; this._overlayRot[i3 + 1] += y; this._overlayRot[i3 + 2] += z;
  }
  offsetPos(boneName, x, y, z) {
    const i = this.pose.skeleton.boneIndex(boneName);
    if (i < 0) return;
    const i3 = i * 3;
    this._overlayPos[i3] += x; this._overlayPos[i3 + 1] += y; this._overlayPos[i3 + 2] += z;
  }

  _evaluate(clip, time, outPos, outRot, outScl) {
    const sk = this.pose.skeleton;
    outPos.set(sk.bindPos);
    outRot.set(sk.bindRot);
    outScl.set(sk.bindScale);
    if (!clip) return;
    const t = clip.loop ? (clip.duration > 0 ? time % clip.duration : 0) : Math.min(time, clip.duration);
    for (const track of clip.tracks) {
      const k = sampleTrack(track, t);
      const i3 = track.boneIndex * 3;
      if (track.channel === 'rot') {
        outRot[i3] += k[1]; outRot[i3 + 1] += k[2]; outRot[i3 + 2] += k[3];
      } else if (track.channel === 'pos') {
        outPos[i3] += k[1]; outPos[i3 + 1] += k[2]; outPos[i3 + 2] += k[3];
      } else {
        outScl[i3] = k[1]; outScl[i3 + 1] = k[2]; outScl[i3 + 2] = k[3];
      }
    }
  }

  update(dt) {
    const pose = this.pose;
    this.time += dt * this.speed;
    if (this.current && !this.current.loop && !this.finished && this.time >= this.current.duration) {
      this.finished = true;
      if (this.onEnd) { const cb = this.onEnd; this.onEnd = null; cb(); }
    }
    if (this.fade < 1) {
      this.fade = clamp01(this.fade + dt * this.fadeSpeed);
      this.prevTime += dt;
    }

    this._evaluate(this.current, this.time, this._posA, this._rotA, this._sclA);
    if (this.fade < 1 && this.previous) {
      this._evaluate(this.previous, this.prevTime, this._posB, this._rotB, this._sclB);
      const w = this.fade;
      for (let i = 0; i < this._posA.length; i++) {
        pose.pos[i] = lerp(this._posB[i], this._posA[i], w) + this._overlayPos[i];
        pose.rot[i] = lerp(this._rotB[i], this._rotA[i], w) + this._overlayRot[i];
        pose.scale[i] = lerp(this._sclB[i], this._sclA[i], w);
      }
    } else {
      if (this.fade >= 1) this.previous = null;
      for (let i = 0; i < this._posA.length; i++) {
        pose.pos[i] = this._posA[i] + this._overlayPos[i];
        pose.rot[i] = this._rotA[i] + this._overlayRot[i];
        pose.scale[i] = this._sclA[i];
      }
    }
    this._overlayRot.fill(0);
    this._overlayPos.fill(0);
    pose.update();
  }

  reset() {
    this.current = null;
    this.previous = null;
    this.time = 0;
    this.fade = 1;
    this.finished = false;
    this.onEnd = null;
    this._overlayRot.fill(0);
    this._overlayPos.fill(0);
    this.pose.resetToBind();
    this.pose.update();
  }
}

/** Compile a set of clip definitions against a skeleton once, at load. */
export function compileClips(skeleton, clips) {
  const out = {};
  for (const name in clips) out[name] = clips[name].compile(skeleton);
  return out;
}
