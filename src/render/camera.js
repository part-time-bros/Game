/**
 * camera.js — the chase rig.
 *
 * Three rigs, because the viewing angle changes what kind of game this is:
 *
 *   pov       over-the-shoulder. Low and close, and the rig swings round behind
 *             the ship as it turns. This is the one that reads as 3D.
 *   chase     the same low, wide framing but world-locked, so "up" is always
 *             north — every threat keeps a fixed screen direction.
 *   tactical  the old high board view. Flat-looking, but you see everything.
 *
 * Distance, height, look-ahead and FOV all breathe with speed, aim and threat
 * on top of whichever rig is active. Shake, roll and hit-punch are layered last.
 */
import { clamp, clamp01, damp, dampAngle, wrapAngle, lerp, DEG } from '../core/util.js';

const GROUND_Y = 1.05;      // aim plane sits at ship height
const MAX_AIM = 120;        // a grazing ray must not fling the reticle to infinity
const WORLD_LOCKED = Math.PI;   // rig azimuth that puts the camera due south

/**
 * How far a turning rig may lean off world north.
 *
 * It is a clamp against an absolute reference, not a chase, and that is the
 * whole point. The aim stick is expressed relative to the rig, so a rig that
 * damps toward the ship's yaw closes a loop: the stick's world direction is
 * rig + stickAngle, the ship turns to that, the rig follows the ship, and next
 * frame the same held stick points somewhere new again. For any stick angle
 * off screen-up that system has no fixed point and the ship spins forever —
 * 5.4 rotations per 10 seconds at 45 degrees. Recomputing the lean from world
 * north each frame removes the integration, so the offset saturates here and
 * stops.
 */
const LEAN_MAX = 26 * DEG;

/** Clearance kept between the camera and any rock it would otherwise enter. */
const CAM_PAD = 1.2;
/** Preferred floor for the boom: below this the rig looks for a way round. */
const CAM_MIN_DIST = 8.0;
/** Absolute floor, used only when no bearing works at all. */
const CAM_HARD_MIN = 3.6;
/**
 * How far the rig may step sideways around an obstacle it cannot see past.
 *
 * A ship hugging the far side of a twelve-unit butte cannot be seen from any
 * distance directly behind it, and clearing the top would need the eye a
 * hundred units up. Stepping around is the only remedy left. Bounded, because
 * the input basis stays on rigYaw while this moves: a small mismatch is worth
 * it to see your own ship, a large one is not.
 */
const CAM_AVOID_MAX = 78 * DEG;
const CAM_AVOID_STEPS = [14, -14, 28, -28, 42, -42, 56, -56, 70, -70, 78, -78];

/**
 * height/distance set the pitch — the whole point of the change. `look` is the
 * height of the look-at point: raising it tilts the rig up, which drops the ship
 * down the screen and puts sky above the horizon.
 */
const RIGS = {
  // Fog distances are tuned to the arena, which is now 66 across the radius:
  // the far wall can be 140 units away, and haze that started at 105 turned it
  // into a flat milky band with no rock left in it.
  pov: { height: 8.0, distance: 16.0, fov: 70, look: 2.4, turns: true, fogNear: 155, fogFar: 470 },
  chase: { height: 14.0, distance: 24.0, fov: 66, look: 2.0, turns: false, fogNear: 160, fogFar: 480 },
  tactical: { height: 26.5, distance: 19.5, fov: 56, look: 0.6, turns: false, fogNear: 135, fogFar: 400 },
};

/**
 * Horizontal field of view is what actually blows out on a phone: a 70-degree
 * vertical rig on a 21:9 landscape screen is a 113-degree fisheye where the ship
 * is a speck. Cap the horizontal angle and let the vertical give way.
 */
const MAX_H_FOV = 96 * DEG;

export const CAMERA_STYLES = RIGS;

export class GameCamera {
  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.5, 900);
    this.style = 'pov';
    this.rig = RIGS.pov;
    this.baseFov = this.rig.fov;
    // Azimuth the rig looks along. PI = looking north from due south, which is
    // the world-locked pose every non-turning rig holds.
    this.rigYaw = WORLD_LOCKED;
    this.target = new THREE.Vector3(0, 0, 0);
    this.smoothTarget = new THREE.Vector3(0, 0, 0);
    this.offset = new THREE.Vector3(0, this.rig.height, this.rig.distance);
    this.distanceScale = 1;
    this.targetDistanceScale = 1;
    this.lead = new THREE.Vector3();
    this.mode = 'follow';     // follow | orbit (menus)
    this.orbitAngle = 0;
    this.enableLead = true;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._ray = new THREE.Ray();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y);
    this._ndc = new THREE.Vector3();
    this.camera.position.set(0, 34, 26);
    this.camera.lookAt(0, 0, 0);
    this.shakeOffset = new THREE.Vector3();
    // Set once from the game so the boom can avoid the scenery (see _solveBoom).
    this.obstacles = null;
    // Bearing offset currently in use to see round an obstacle, and the
    // bearing it is heading for (held across frames — see follow).
    this.avoidYaw = 0;
    this._avoidTarget = 0;
    this.arenaRadius = 0;
    // Smoothed boom length. Kept separately from distanceScale because the two
    // move on different timescales: pulling in has to be immediate or the
    // camera clips through rock, while pushing back out has to be slow or it
    // pops the moment you clear a corner.
    this.boom = 0;
  }

  /** Switch rigs. Unknown names fall back to the over-the-shoulder default. */
  setStyle(name) {
    const rig = RIGS[name] || RIGS.pov;
    this.style = RIGS[name] ? name : 'pov';
    this.rig = rig;
    this.baseFov = rig.fov;
    if (!rig.turns) this.rigYaw = WORLD_LOCKED;
    this.setAspect(this.camera.aspect);
    return this.rig;
  }

  /** Give the rig the collision world so the boom can avoid it. */
  setWorld(world) {
    this.obstacles = world ? world.obstacles : null;
    this.arenaRadius = world ? world.radius : 0;
  }

  /**
   * Boom length and eye height that together leave the ship visible.
   *
   * The arena is full of standing rock, and a chase rig that ignores it spends
   * half a fight looking at the inside of a butte. Obstacles are already
   * tracked as vertical cylinders for collision, so this is one quadratic per
   * obstacle rather than a mesh raycast — cheap enough to run every frame.
   *
   * The camera sits at `target - fwd * t`, so substituting that into
   * |point - centre| = r + pad gives t^2 - 2bt + c = 0, and the near root is
   * the first t at which the camera would enter something.
   *
   * There are two ways out and the order matters. Winding the boom in is
   * preferred because it keeps the framing. But a ship hugging the far side of
   * a big butte cannot be seen from any distance that is still behind it, so
   * below a floor the rig climbs instead and looks down over the top. Both are
   * bounded, and the solve is iterated because each one changes what blocks.
   */
  _solveBoom(tx, tz, fwdX, fwdZ, want, lookY, eyeFor) {
    let dist = want;
    let eye = eyeFor(want);
    if (!this.obstacles) return { dist, eye, blocked: false };
    const maxEye = eyeFor(want) * 2.1;

    let blocked = false;
    for (let pass = 0; pass < 3; pass++) {
      let shortest = dist;
      let lift = eye;
      blocked = false;
      for (const ob of this.obstacles) {
        const dx = tx - ob.x, dz = tz - ob.z;
        const r = ob.r + CAM_PAD;
        const c = dx * dx + dz * dz - r * r;
        if (c <= 0) continue;                 // the ship is inside it already
        const b = dx * fwdX + dz * fwdZ;
        const disc = b * b - c;
        if (disc <= 0) continue;              // the boom misses this one
        const tEnter = b - Math.sqrt(disc);
        if (tEnter <= 0 || tEnter >= dist) continue;
        // The sight line climbs from the ship to the eye, so a rock only
        // blocks if it is still taller than the line where the line passes
        // over it. Testing the ground plan alone had the rig flinching away
        // from every boulder it drove past.
        const h = lookY + (eye - lookY) * (tEnter / dist);
        if (ob.height !== undefined && ob.height < h) continue;
        if (tEnter >= CAM_MIN_DIST) {
          if (tEnter < shortest) shortest = tEnter;
        } else if (ob.height !== undefined) {
          // Too close to back away from: rise until the line clears the top.
          // If that needs more height than the cap allows, the bearing is a
          // write-off and the caller has to go round — saying so is the point
          // of `blocked`. Reporting success here is what previously left the
          // rig staring into a butte with a full-length boom.
          const need = lookY + (ob.height + 1.4 - lookY) * (dist / Math.max(0.001, tEnter));
          if (need > maxEye) blocked = true;
          if (need > lift) lift = Math.min(need, maxEye);
        }
      }
      const settled = shortest === dist && lift === eye;
      dist = Math.max(CAM_MIN_DIST, shortest);
      eye = Math.max(eyeFor(dist), lift);
      if (settled) break;
    }
    // Nothing worked from this bearing. Wind in below the usual floor so the
    // ship is at least on screen — a very close camera beats a view of rock.
    if (blocked) {
      let nearest = dist;
      for (const ob of this.obstacles) {
        const dx = tx - ob.x, dz = tz - ob.z;
        const r = ob.r + CAM_PAD;
        const c = dx * dx + dz * dz - r * r;
        if (c <= 0) continue;
        const b = dx * fwdX + dz * fwdZ;
        const disc = b * b - c;
        if (disc <= 0) continue;
        const tEnter = b - Math.sqrt(disc);
        if (tEnter > 0 && tEnter < nearest) nearest = tEnter;
      }
      dist = Math.max(CAM_HARD_MIN, nearest);
      eye = eyeFor(dist);
    }

    // and keep the camera inside the canyon rather than buried in its wall
    if (this.arenaRadius > 0) {
      const maxR = this.arenaRadius + 3;
      const c = tx * tx + tz * tz - maxR * maxR;
      const b = tx * fwdX + tz * fwdZ;
      const disc = b * b - c;
      if (disc > 0) {
        const tExit = b + Math.sqrt(disc);    // target is inside, so this root
        if (tExit > 0 && tExit < dist) dist = Math.max(CAM_MIN_DIST, tExit);
      }
    }
    return { dist, eye, blocked };
  }

  /** Unit vector the rig looks along, on the ground plane. */
  get forwardX() { return Math.sin(this.rigYaw); }
  get forwardZ() { return Math.cos(this.rigYaw); }

  /**
   * Where the follow rig would rest over a point. Cinematics land on this
   * instead of hard-coded numbers, so they hand back without a jump whichever
   * rig is active.
   */
  restPose(x, z) {
    const r = this.rig;
    return {
      pos: [x - this.forwardX * r.distance, r.height, z - this.forwardZ * r.distance],
      target: [x, r.look, z],
      fov: r.fov,
    };
  }

  setAspect(a) {
    this.camera.aspect = a;
    this.camera.fov = this.fovFor(this.baseFov, a);
    this.camera.updateProjectionMatrix();
  }

  /** Vertical FOV that keeps both axes sane at any aspect ratio. */
  fovFor(base, a) {
    // Portrait has no horizontal room, so it trades vertical angle for reach.
    if (a < 1) return clamp(base / a * 0.62, base, 92);
    return Math.min(base, (2 * Math.atan(Math.tan(MAX_H_FOV / 2) / a)) / DEG);
  }

  /** Menu / attract-mode slow orbit around the arena. */
  orbit(dt, radius = 62, height = 30) {
    this.mode = 'orbit';
    this.orbitAngle += dt * 0.055;
    const a = this.orbitAngle;
    this.camera.position.set(Math.cos(a) * radius, height + Math.sin(a * 0.7) * 6, Math.sin(a) * radius);
    this.camera.lookAt(0, 3.5, 0);
    this.camera.fov = lerp(this.camera.fov, 50, clamp01(dt * 2));
    this.camera.updateProjectionMatrix();
  }

  /**
   * follow(player, aimPoint, dt, fx, threat)
   * player: {position, velocity, speed}
   */
  follow(player, aimPoint, dt, fx, threat = 0, focus = null, turnTo = null) {
    this.mode = 'follow';
    const p = player.position;
    const rig = this.rig;

    // A turning rig leans toward the ship rather than swinging round behind it
    // (see LEAN_MAX). `turnTo` is null whenever the aim source is an absolute
    // screen cursor: the cursor's ground point rotates with the camera, so
    // following it would chase its own tail. Falling back to world-locked
    // matters: a rig frozen at whatever azimuth the last stick input left it at
    // would make camera-relative movement read against a basis the player can
    // no longer see or change.
    if (rig.turns && turnTo !== null) {
      const lean = clamp(wrapAngle(turnTo - WORLD_LOCKED), -LEAN_MAX, LEAN_MAX);
      this.rigYaw = dampAngle(this.rigYaw, WORLD_LOCKED + lean, 0.0015, dt);
    } else {
      this.rigYaw = dampAngle(this.rigYaw, WORLD_LOCKED, rig.turns ? 0.05 : 0.0004, dt);
    }

    // look-ahead blends motion and aim so the player sees where they're going
    let lx = 0, lz = 0;
    if (this.enableLead) {
      lx = player.velocity.x * 0.17;
      lz = player.velocity.z * 0.17;
      if (aimPoint) {
        lx += (aimPoint.x - p.x) * 0.11;
        lz += (aimPoint.z - p.z) * 0.11;
      }
      const ll = Math.sqrt(lx * lx + lz * lz);
      const maxLead = 5.0;
      if (ll > maxLead) { lx = lx / ll * maxLead; lz = lz / ll * maxLead; }
    }

    this.target.set(p.x + lx, 0, p.z + lz);

    // Two-target framing: when something huge is on the field, drift the
    // target toward it and pull back so both stay on screen.
    let focusSep = 0;
    if (focus) {
      const fx2 = focus.x - p.x, fz2 = focus.z - p.z;
      focusSep = Math.sqrt(fx2 * fx2 + fz2 * fz2);
      const w = clamp01(focusSep / 36) * 0.46;
      this.target.x += fx2 * w;
      this.target.z += fz2 * w;
    }
    // Fraction of the error still left after one second. Softer than it was:
    // at 0.0009 the rig arrived in about a sixth of a second, which tracks the
    // ship so tightly that the ship looks pinned to the screen and only the
    // world appears to move.
    const k = 0.0035;
    this.smoothTarget.x = damp(this.smoothTarget.x, this.target.x, k, dt);
    this.smoothTarget.y = damp(this.smoothTarget.y, this.target.y, k, dt);
    this.smoothTarget.z = damp(this.smoothTarget.z, this.target.z, k, dt);

    // pull back when fast or when something huge is on the field
    const speed = Math.sqrt(player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z);
    this.targetDistanceScale = 1 + clamp01(speed / 42) * 0.10 + threat * 0.12 + clamp01(focusSep / 34) * 0.85;
    this.distanceScale = damp(this.distanceScale, this.targetDistanceScale, 0.06, dt);

    const ds = this.distanceScale;
    const shake = fx ? fx.shake(performance.now() * 0.001) : { x: 0, y: 0, roll: 0 };
    const fwdX = this.forwardX, fwdZ = this.forwardZ;
    const want = rig.distance * ds;
    const fullEye = rig.height * (1 + (ds - 1) * 0.55);
    // Eye height falls as the boom shortens, and the boom depends on the eye
    // height (a lower line is blocked by more rock), so the two are solved
    // together. Two passes is plenty — the second barely moves.
    const eyeFor = (d) => fullEye * (0.72 + clamp01(d / Math.max(0.001, rig.distance)) * 0.28);
    // Try straight back first; only look for a way round if that is hopeless.
    let solved = this._solveBoom(this.smoothTarget.x, this.smoothTarget.z, fwdX, fwdZ, want, rig.look, eyeFor);
    const straightOk = !solved.blocked && solved.dist >= want * 0.62;
    let avoid = 0;
    if (straightOk) {
      // nothing in the way: unwind whatever detour we were on
      this._avoidTarget = 0;
    } else {
      // Hysteresis. Re-running the search from scratch every frame makes the
      // rig hunt between two equally good bearings and never arrive at either,
      // so the detour we are already on gets to keep the job while it works.
      const held = this._avoidTarget || 0;
      let chosen = null;
      if (held !== 0) {
        const a = this.rigYaw + held;
        const cur = this._solveBoom(this.smoothTarget.x, this.smoothTarget.z, Math.sin(a), Math.cos(a), want, rig.look, eyeFor);
        if (!cur.blocked && cur.dist >= want * 0.55) chosen = { off: held, sol: cur };
      }
      if (!chosen) {
        let best = { off: 0, sol: solved };
        for (const deg of CAM_AVOID_STEPS) {
          const a = this.rigYaw + deg * DEG;
          const alt = this._solveBoom(this.smoothTarget.x, this.smoothTarget.z, Math.sin(a), Math.cos(a), want, rig.look, eyeFor);
          // an unblocked bearing always beats a blocked one, however short
          const better = (!alt.blocked && best.sol.blocked)
            || (alt.blocked === best.sol.blocked && alt.dist > best.sol.dist + 1);
          if (better) best = { off: deg * DEG, sol: alt };
          if (!best.sol.blocked && best.sol.dist >= want * 0.9) break;
        }
        chosen = { off: best.off, sol: best.sol };
      }
      this._avoidTarget = chosen.off;
      solved = chosen.sol;
      avoid = chosen.off;
    }
    this.avoidYaw = damp(this.avoidYaw, clamp(avoid, -CAM_AVOID_MAX, CAM_AVOID_MAX), 0.004, dt);
    const viewYaw = this.rigYaw + this.avoidYaw;
    const vFwdX = Math.sin(viewYaw), vFwdZ = Math.cos(viewYaw);
    const clear = solved.dist;
    // Asymmetric: snap in hard so the camera never enters rock, ease back out
    // so it does not pop the instant the ship clears a corner.
    if (this.boom === 0) this.boom = clear;
    this.boom = clear < this.boom
      ? damp(this.boom, clear, 0.0002, dt)
      : damp(this.boom, clear, 0.22, dt);
    const dist = this.boom;
    // The eye comes down a little with the boom so a shortened rig does not
    // stare straight along the deck — but only a little. Dropping it far is
    // what used to put the camera underneath the height it had just checked
    // for clearance, and therefore inside the rock it had cleared.
    if (this.eye === undefined) this.eye = solved.eye;
    this.eye = damp(this.eye, solved.eye, 0.004, dt);
    const eye = this.eye;
    let cx = this.smoothTarget.x - vFwdX * dist + shake.x;
    let cz = this.smoothTarget.z - vFwdZ * dist;
    // Last resort. Solving the boom is the real mechanism, but it is damped and
    // the ship can be shoved by an explosion faster than the boom retracts, so
    // this guarantees the invariant the solve only approximates: the camera is
    // never inside rock.
    if (this.obstacles) {
      for (const ob of this.obstacles) {
        if (ob.height !== undefined && eye > ob.height) continue;
        const dx = cx - ob.x, dz = cz - ob.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const r = ob.r + 0.6;
        if (d >= r) continue;
        if (d < 1e-4) { cx = ob.x + r; continue; }
        cx = ob.x + (dx / d) * r;
        cz = ob.z + (dz / d) * r;
      }
    }
    this.camera.position.set(cx, eye + shake.y, cz);
    this.offset.set(-vFwdX * dist, this.camera.position.y, -vFwdZ * dist);
    this._tmp.set(this.smoothTarget.x + shake.x * 0.4, rig.look, this.smoothTarget.z);
    this.camera.lookAt(this._tmp);
    if (shake.roll) this.camera.rotateZ(shake.roll);

    const fov = this.fovFor(this.baseFov + (fx ? fx.fovPunch * 7 : 0) + clamp01(speed / 46) * 2.4, this.camera.aspect);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Keep the chase rig's smoothing state on the player without moving the
   * camera — used while a cinematic owns the pose, so handing control back
   * does not swoop from wherever the cinematic ended.
   */
  parkTarget(x, z) {
    this.target.set(x, 0, z);
    this.smoothTarget.set(x, 0, z);
    this.boom = 0;
    this.eye = undefined;
    this.avoidYaw = 0;
    this._avoidTarget = 0;
    this.distanceScale = 1;
    this.targetDistanceScale = 1;
  }

  /** Snap instantly (run start / restart) so there is no swoop-in. */
  snapTo(x, z, facing) {
    this.target.set(x, 0, z);
    this.smoothTarget.set(x, 0, z);
    this.boom = 0;
    this.eye = undefined;
    this.avoidYaw = 0;
    this._avoidTarget = 0;
    this.distanceScale = 1;
    if (this.rig.turns && facing !== undefined) {
      this.rigYaw = WORLD_LOCKED + clamp(wrapAngle(facing - WORLD_LOCKED), -LEAN_MAX, LEAN_MAX);
    } else {
      this.rigYaw = WORLD_LOCKED;
    }
    const pose = this.restPose(x, z);
    this.camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    this.camera.updateMatrixWorld();
  }

  /** Screen pixel -> point on the aim plane. Returns the reused vector. */
  screenToGround(sx, sy, width, height, out) {
    const v = out || this._tmp2;
    this._ndc.set((sx / width) * 2 - 1, -(sy / height) * 2 + 1, 0.5);
    this._ndc.unproject(this.camera);
    this._ray.origin.copy(this.camera.position);
    this._ray.direction.copy(this._ndc).sub(this.camera.position).normalize();
    const hit = this._ray.intersectPlane(this._plane, v);
    const cx = this.camera.position.x, cz = this.camera.position.z;
    if (!hit) {
      // Pointing at or above the horizon — a low rig sees plenty of sky. Cast
      // along the ray's horizontal component so the reticle still means
      // something instead of jumping behind the player.
      const dx = this._ray.direction.x, dz = this._ray.direction.z;
      const l = Math.hypot(dx, dz) || 1;
      v.set(cx + (dx / l) * MAX_AIM, GROUND_Y, cz + (dz / l) * MAX_AIM);
    } else {
      // A grazing ray lands absurdly far out; keep the aim point in the arena's
      // neighbourhood so lead, assist and the reticle all stay sane.
      const dx = v.x - cx, dz = v.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > MAX_AIM) v.set(cx + (dx / d) * MAX_AIM, GROUND_Y, cz + (dz / d) * MAX_AIM);
    }
    v.y = GROUND_Y;
    return v;
  }

  /** World point -> screen pixels (+ whether it is in front of the camera). */
  worldToScreen(x, y, z, width, height, out) {
    const v = out || this._tmp2;
    v.set(x, y, z).project(this.camera);
    const behind = v.z > 1;
    const sx = (v.x * 0.5 + 0.5) * width;
    const sy = (-v.y * 0.5 + 0.5) * height;
    return { x: sx, y: sy, behind, ndcX: v.x, ndcY: v.y };
  }
}
