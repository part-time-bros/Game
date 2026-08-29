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
import { clamp, clamp01, damp, dampAngle, lerp, DEG } from '../core/util.js';

const GROUND_Y = 1.05;      // aim plane sits at ship height
const MAX_AIM = 120;        // a grazing ray must not fling the reticle to infinity
const WORLD_LOCKED = Math.PI;   // rig azimuth that puts the camera due south

/**
 * height/distance set the pitch — the whole point of the change. `look` is the
 * height of the look-at point: raising it tilts the rig up, which drops the ship
 * down the screen and puts sky above the horizon.
 */
const RIGS = {
  pov: { height: 8.0, distance: 16.0, fov: 70, look: 2.4, turns: true, fogNear: 105, fogFar: 330 },
  chase: { height: 14.0, distance: 24.0, fov: 66, look: 2.0, turns: false, fogNear: 110, fogFar: 340 },
  tactical: { height: 26.5, distance: 19.5, fov: 56, look: 0.6, turns: false, fogNear: 90, fogFar: 260 },
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

    // A turning rig swings round behind the ship. `turnTo` is null whenever the
    // aim source is an absolute screen cursor: the cursor's ground point rotates
    // with the camera, so following it would chase its own tail forever.
    // Falling back to world-locked matters: a rig frozen at whatever azimuth the
    // last stick input left it at would make camera-relative movement read
    // against a basis the player can no longer see or change.
    if (rig.turns && turnTo !== null) this.rigYaw = dampAngle(this.rigYaw, turnTo, 0.0015, dt);
    else this.rigYaw = dampAngle(this.rigYaw, WORLD_LOCKED, rig.turns ? 0.05 : 0.0004, dt);

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
    const k = 0.0009;                    // smoothing constant (fraction left after 1s)
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
    const dist = rig.distance * ds;
    this.camera.position.set(
      this.smoothTarget.x - fwdX * dist + shake.x,
      rig.height * (1 + (ds - 1) * 0.55) + shake.y,
      this.smoothTarget.z - fwdZ * dist,
    );
    this.offset.set(-fwdX * dist, this.camera.position.y, -fwdZ * dist);
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
    this.distanceScale = 1;
    this.targetDistanceScale = 1;
  }

  /** Snap instantly (run start / restart) so there is no swoop-in. */
  snapTo(x, z, facing) {
    this.target.set(x, 0, z);
    this.smoothTarget.set(x, 0, z);
    this.distanceScale = 1;
    if (this.rig.turns && facing !== undefined) this.rigYaw = facing;
    else this.rigYaw = WORLD_LOCKED;
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
