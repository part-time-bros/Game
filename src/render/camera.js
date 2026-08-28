/**
 * camera.js — the chase rig.
 *
 * Yaw stays world-locked (twin-stick readability: "up" is always the same
 * direction) while distance, height, look-ahead and FOV all breathe with speed,
 * aim and threat. Shake, roll and hit-punch are layered on last.
 */
import { clamp, clamp01, damp, lerp, TAU } from '../core/util.js';

const GROUND_Y = 1.05;   // aim plane sits at ship height

export class GameCamera {
  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(56, aspect, 0.5, 900);
    this.baseFov = 56;
    this.target = new THREE.Vector3(0, 0, 0);
    this.smoothTarget = new THREE.Vector3(0, 0, 0);
    this.offset = new THREE.Vector3(0, 26.5, 19.5);
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

  setAspect(a) {
    this.camera.aspect = a;
    // keep a sensible vertical view on ultrawide and on portrait phones
    this.camera.fov = a < 1 ? clamp(this.baseFov / a * 0.62, 56, 82) : this.baseFov;
    this.camera.updateProjectionMatrix();
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
  follow(player, aimPoint, dt, fx, threat = 0, focus = null) {
    this.mode = 'follow';
    const p = player.position;

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
      const w = clamp01(focusSep / 40) * 0.50;
      this.target.x += fx2 * w;
      this.target.z += fz2 * w;
    }
    const k = 0.0009;                    // smoothing constant (fraction left after 1s)
    this.smoothTarget.x = damp(this.smoothTarget.x, this.target.x, k, dt);
    this.smoothTarget.y = damp(this.smoothTarget.y, this.target.y, k, dt);
    this.smoothTarget.z = damp(this.smoothTarget.z, this.target.z, k, dt);

    // pull back when fast or when something huge is on the field
    const speed = Math.sqrt(player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z);
    this.targetDistanceScale = 1 + clamp01(speed / 42) * 0.10 + threat * 0.12 + clamp01(focusSep / 40) * 0.55;
    this.distanceScale = damp(this.distanceScale, this.targetDistanceScale, 0.06, dt);

    const ds = this.distanceScale;
    const shake = fx ? fx.shake(performance.now() * 0.001) : { x: 0, y: 0, roll: 0 };
    this.camera.position.set(
      this.smoothTarget.x + this.offset.x * ds + shake.x,
      this.offset.y * ds + shake.y,
      this.smoothTarget.z + this.offset.z * ds,
    );
    this._tmp.set(this.smoothTarget.x + shake.x * 0.4, 0.6, this.smoothTarget.z);
    this.camera.lookAt(this._tmp);
    if (shake.roll) this.camera.rotateZ(shake.roll);

    const fov = this.baseFov + (fx ? fx.fovPunch * 7 : 0) + clamp01(speed / 46) * 2.4;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = this.camera.aspect < 1 ? clamp(fov / this.camera.aspect * 0.62, 56, 82) : fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snap instantly (run start / restart) so there is no swoop-in. */
  snapTo(x, z) {
    this.target.set(x, 0, z);
    this.smoothTarget.set(x, 0, z);
    this.distanceScale = 1;
    this.camera.position.set(x + this.offset.x, this.offset.y, z + this.offset.z);
    this.camera.lookAt(x, 0.6, z);
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
    if (!hit) {
      // camera is looking parallel to the plane — fall back to a long forward cast
      v.copy(this.camera.position).addScaledVector(this._ray.direction, 60);
      v.y = GROUND_Y;
    }
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
