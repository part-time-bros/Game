/**
 * director.js — cinematic camera sequences.
 *
 * A cinematic is a keyframe track over camera position/target/FOV plus a few
 * presentation channels (letterbox, time scale, input lock) and one-shot cues.
 * The game camera hands over control while one runs and takes it back cleanly.
 *
 * Keyframes are absolute times; values interpolate with a smoothstep so the
 * camera eases rather than snapping between poses.
 */
import { clamp01, lerp, smoothstep, TAU } from '../core/util.js';

const _dirVec = new THREE.Vector3();

export class Director {
  constructor(game) {
    this.game = game;
    this.active = null;
    this.time = 0;
    this.camPos = new THREE.Vector3();
    this.camTarget = new THREE.Vector3();
    this.fov = 56;
    this.letterbox = 0;
    this.lockInput = false;
    this._fired = new Set();
    this.onComplete = null;
  }

  get running() { return this.active !== null; }

  /** Skip whatever is playing (used by pause/restart/abort). */
  cancel() {
    if (!this.active) return;
    this.active = null;
    this.letterbox = 0;
    this.lockInput = false;
    this._fired.clear();
    this.onComplete = null;
    this.game.screen.targetTimeScale = 1;
    this.game.ui.setLetterbox(0);
  }

  /** Finish early (player pressed something). Runs the completion callback. */
  trySkip() {
    if (!this.active || !this.active.skippable || this.time < 0.5) return false;
    const cb = this.onComplete;
    this.cancel();
    if (cb) cb();
    return true;
  }

  play(sequence, onComplete) {
    this.active = sequence;
    this.time = 0;
    this._fired.clear();
    this.onComplete = onComplete || null;
    this.update(0);
  }

  /** Locate the keyframe pair bracketing the current time. */
  _bracket(frames) {
    let a = frames[0], b = frames[frames.length - 1];
    for (let i = 0; i < frames.length - 1; i++) {
      if (this.time >= frames[i].t && this.time <= frames[i + 1].t) { a = frames[i]; b = frames[i + 1]; break; }
      if (this.time > frames[i].t) { a = frames[i]; b = frames[Math.min(i + 1, frames.length - 1)]; }
    }
    const span = b.t - a.t;
    const k = span > 0 ? smoothstep(clamp01((this.time - a.t) / span)) : 1;
    return { a, b, k };
  }

  /** Sample a scalar channel. */
  _sample(frames, key) {
    const { a, b, k } = this._bracket(frames);
    const av = a[key];
    if (av === undefined) return null;
    const bv = b[key] === undefined ? av : b[key];
    return lerp(av, bv, k);
  }

  /**
   * Sample a positional channel. Frames are offsets from the sequence's live
   * anchor (a moving boss, say) unless flagged `abs`, so a reveal keeps its
   * subject framed even while the subject is still flying in. Each keyframe is
   * resolved to world space before interpolation, which lets one track mix
   * anchored and absolute poses.
   */
  _sampleVec(frames, key, anchor, out) {
    const { a, b, k } = this._bracket(frames);
    if (a[key] === undefined) return null;
    const bv = b[key] === undefined ? a[key] : b[key];
    const ax = a.abs || !anchor ? 0 : anchor.x;
    const ay = a.abs || !anchor ? 0 : anchor.y;
    const az = a.abs || !anchor ? 0 : anchor.z;
    const bx = b.abs || !anchor ? 0 : anchor.x;
    const by = b.abs || !anchor ? 0 : anchor.y;
    const bz = b.abs || !anchor ? 0 : anchor.z;
    out.set(
      lerp(a[key][0] + ax, bv[0] + bx, k),
      lerp(a[key][1] + ay, bv[1] + by, k),
      lerp(a[key][2] + az, bv[2] + bz, k),
    );
    return out;
  }

  update(dtReal) {
    if (!this.active) return;
    const seq = this.active;
    this.time += dtReal;

    if (seq.frames) {
      const anchor = seq.anchor ? seq.anchor() : null;
      if (this._sampleVec(seq.frames, 'pos', anchor, this.camPos) === null) this.camPos.set(0, 30, 30);
      this._sampleVec(seq.frames, 'target', anchor, this.camTarget);
      const f = this._sample(seq.frames, 'fov');
      if (f !== null) this.fov = f;
      const lb = this._sample(seq.frames, 'letterbox');
      this.letterbox = lb === null ? 0 : lb;
      const ts = this._sample(seq.frames, 'timeScale');
      this.game.screen.targetTimeScale = ts === null ? 1 : ts;
    }

    for (const cue of seq.cues || []) {
      if (this.time >= cue.t && !this._fired.has(cue)) {
        this._fired.add(cue);
        try { cue.run(this.game); } catch (e) { console.warn('[director] cue failed', e); }
      }
    }

    this.lockInput = this.time < (seq.lockUntil === undefined ? seq.duration : seq.lockUntil);
    this.game.ui.setLetterbox(this.letterbox);

    if (this.time >= seq.duration) {
      const cb = this.onComplete;
      this.cancel();
      if (cb) cb();
    }
  }

  /** Apply the cinematic pose to the real camera. */
  applyTo(camera) {
    camera.position.copy(this.camPos);
    camera.lookAt(this.camTarget);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}

// ======================================================================
//  Sequences
// ======================================================================

/** Deployment: a wide sweep that settles into the normal chase pose. */
export function runStartSequence(px, pz, cam) {
  // The last frame has to be exactly where the follow rig rests, or handing
  // control back snaps. Ask the rig rather than hard-coding a pose.
  const rest = cam.restPose(px, pz);
  return {
    name: 'runStart',
    skippable: true,
    duration: 3.1,
    lockUntil: 2.6,
    frames: [
      { t: 0.0, abs: 1, pos: [px + 46, 6, pz + 52], target: [px, 2, pz], fov: 44, letterbox: 1 },
      { t: 1.3, abs: 1, pos: [px + 16, 14, pz + 34], target: [px, 1.4, pz], fov: 50, letterbox: 1 },
      { t: 2.4, abs: 1, pos: [rest.pos[0] + 3, rest.pos[1] + 6, rest.pos[2] + 6], target: [px, 1.0, pz], fov: rest.fov - 4, letterbox: 0.35 },
      { t: 3.1, abs: 1, pos: rest.pos, target: rest.target, fov: rest.fov, letterbox: 0 },
    ],
    cues: [
      { t: 0.0, run: (g) => { g.player.beginWarpIn(); g.audio.play('rift', { gain: 0.8 }); } },
      { t: 0.55, run: (g) => { g.ui.banner('STABILIZER SEVEN', 'HOLD THE DECK', ''); } },
      {
        t: 1.35,
        run: (g) => {
          const p = g.player.position;
          g.rings.spawn(p.x, p.z, { color: g.player.glowColor, from: 0.5, to: 14, duration: 0.8, thickness: 0.12 });
          g.fx.column(p.x, p.z, g.player.glowColor, 9, 30);
          g.world.addRipple(p.x, p.z, 1.4);
          g.audio.play('overdrive', { gain: 0.5 });
        },
      },
    ],
  };
}

/** Boss arrival: letterboxed low-angle push-in on the new threat. */
export function bossIntroSequence(boss, px, pz, cam) {
  const rest = cam.restPose(px, pz);
  return {
    name: 'bossIntro',
    skippable: true,
    duration: 3.4,
    lockUntil: 3.0,
    // anchored: the boss is still flying in during the reveal
    anchor: () => ({ x: boss.x, y: boss.y, z: boss.z }),
    frames: [
      { t: 0.0, pos: [22, 3, 24], target: [0, 0, 0], fov: 42, letterbox: 0 },
      { t: 0.4, pos: [19, 2, 22], target: [0, 0, 0], fov: 40, letterbox: 1 },
      { t: 1.9, pos: [-18, 8, 21], target: [0, 1, 0], fov: 44, letterbox: 1 },
      { t: 2.5, pos: [-4, 16, 26], target: [0, 0, 0], fov: 50, letterbox: 1 },
      { t: 2.9, abs: 1, pos: [rest.pos[0] + 5, rest.pos[1] + 7, rest.pos[2] + 7], target: [(px + boss.x) / 2, 3, (pz + boss.z) / 2], fov: rest.fov - 3, letterbox: 0.6 },
      { t: 3.4, abs: 1, pos: rest.pos, target: rest.target, fov: rest.fov, letterbox: 0 },
    ],
    cues: [
      { t: 0.15, run: (g) => { g.screen.addTrauma(0.5); } },
      {
        t: 0.5,
        run: (g) => {
          g.ui.banner(boss.def.name, boss.def.title, 'danger');
          g.rings.spawn(boss.x, boss.z, { color: 0xff3ea5, from: 2, to: 34, duration: 1.2, thickness: 0.08 });
        },
      },
      { t: 1.5, run: (g) => { g.screen.addTrauma(0.45); g.fx.column(boss.x, boss.z, 0xff3ea5, 16, 40); } },
    ],
  };
}

/** Victory: rise away from the deck as the score settles. */
export function victorySequence(px, pz, cam) {
  const rest = cam.restPose(px, pz);
  return {
    name: 'victory',
    duration: 3.6,
    lockUntil: 3.6,
    frames: [
      { abs: 1, t: 0.0, pos: rest.pos, target: rest.target, fov: rest.fov, letterbox: 0.5, timeScale: 0.35 },
      { abs: 1, t: 1.4, pos: [rest.pos[0] + 4, rest.pos[1] + 14, rest.pos[2] + 6], target: [px, 2, pz], fov: rest.fov - 5, letterbox: 1, timeScale: 0.6 },
      { abs: 1, t: 3.6, pos: [px + 10, 62, pz + 38], target: [0, 3, 0], fov: 48, letterbox: 1, timeScale: 1 },
    ],
    cues: [
      { t: 0.1, run: (g) => { g.screen.addFlash(0xffffff, 0.55); g.ui.banner('STABILIZER HELD', '', ''); } },
      { t: 0.6, run: (g) => { g.fx.column(0, 0, 0x7dff9e, 22, 60); g.rings.spawn(0, 0, { color: 0x7dff9e, from: 2, to: 46, duration: 1.6, thickness: 0.06 }); } },
    ],
  };
}

/** Defeat: slow push-in on the wreck. */
export function defeatSequence(px, pz, cam) {
  const rest = cam.restPose(px, pz);
  return {
    name: 'defeat',
    duration: 2.9,
    lockUntil: 2.9,
    frames: [
      { abs: 1, t: 0.0, pos: rest.pos, target: rest.target, fov: rest.fov, letterbox: 0.4, timeScale: 0.18 },
      { abs: 1, t: 1.2, pos: [px + 3, 12, pz + 12], target: [px, 1.2, pz], fov: 46, letterbox: 1, timeScale: 0.3 },
      { abs: 1, t: 2.9, pos: [px + 5, 7, pz + 9], target: [px, 1.0, pz], fov: 40, letterbox: 1, timeScale: 0.55 },
    ],
    cues: [
      { t: 0.05, run: (g) => { g.screen.desaturate = 0.9; } },
    ],
  };
}

/** Menu attract loop: a slow orbit with a periodic fly-by. */
export function menuOrbit(t, radius = 62, height = 30) {
  const a = t * 0.055;
  _dirVec.set(Math.cos(a) * radius, height + Math.sin(a * 0.7) * 6, Math.sin(a) * radius);
  return _dirVec;
}
