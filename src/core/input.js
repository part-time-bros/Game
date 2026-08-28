/**
 * input.js — one unified control surface fed by three device families:
 * keyboard+mouse, gamepad (twin-stick), and touch (on-screen sticks).
 *
 * The rest of the game only ever reads the resolved intent:
 *   move {x,z}   normalised movement request (magnitude <= 1)
 *   aim  {...}   either a screen point (pointer) or a stick direction
 *   fire / dashEdge / pulseEdge / overdriveEdge / pauseEdge
 */
import { clamp, lengthXZ } from './util.js';

const KEY_MOVE = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const DEADZONE = 0.22;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.keyEdges = new Set();
    this.move = { x: 0, z: 0 };
    this.aim = { mode: 'pointer', screenX: 0, screenY: 0, dirX: 0, dirZ: 1, active: false };
    this.fire = false;
    this.firePulse = false;      // "pulse" as in secondary weapon, held
    this.dashEdge = false;
    this.pulseEdge = false;
    this.overdriveEdge = false;
    this.pauseEdge = false;
    this.anyEdge = false;
    this.scheme = 'keyboard';    // keyboard | gamepad | touch
    this.enabled = true;         // false while a menu owns the screen
    this.suppress = 0;           // seconds of input lockout after a state change
    this.hasTouch = false;
    this.gamepadIndex = -1;
    this.override = null;
    this._pointerInside = false;
    this._touchAimActive = false;
    this._sticks = { move: null, aim: null };
    this._touchButtons = { dash: false, pulse: false, over: false, pause: false };
    this._listeners = [];
    this._install();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _install() {
    const c = this.canvas;
    this._on(window, 'keydown', (e) => {
      if (e.repeat) { if (KEY_MOVE[e.code]) e.preventDefault(); return; }
      // Never swallow browser-level combos.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.scheme = 'keyboard';
      this.keys.add(e.code);
      this.keyEdges.add(e.code);
      this.anyEdge = true;
      if (KEY_MOVE[e.code] || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    this._on(window, 'keyup', (e) => { this.keys.delete(e.code); });
    this._on(window, 'blur', () => this.releaseAll());

    this._on(c, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.scheme = 'keyboard';
      this.aim.mode = 'pointer';
      const r = c.getBoundingClientRect();
      this.aim.screenX = e.clientX - r.left;
      this.aim.screenY = e.clientY - r.top;
      this.aim.active = true;
      this._pointerInside = true;
    }, { passive: true });
    this._on(c, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (!this.enabled) return;
      this.scheme = 'keyboard';
      this.aim.mode = 'pointer';
      const r = c.getBoundingClientRect();
      this.aim.screenX = e.clientX - r.left;
      this.aim.screenY = e.clientY - r.top;
      this.aim.active = true;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) { this.firePulse = true; this.pulseEdge = true; }
      this.anyEdge = true;
    });
    this._on(window, 'pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.firePulse = false;
    });
    this._on(window, 'contextmenu', (e) => { if (e.target === c) e.preventDefault(); });
    this._on(c, 'pointerleave', () => { this._pointerInside = false; this.fire = false; this.firePulse = false; });

    this._on(window, 'gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    this._on(window, 'gamepaddisconnected', (e) => { if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = -1; });

    this.hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  }

  /** Wire the on-screen sticks/buttons (called once the DOM overlay exists). */
  bindTouch(els) {
    if (!els) return;
    const mkStick = (el, key) => {
      if (!el) return;
      const knob = el.querySelector('i');
      const radius = 46;
      let id = null;
      const set = (dx, dz) => {
        const len = lengthXZ(dx, dz);
        const k = len > radius ? radius / len : 1;
        knob.style.transform = `translate(${dx * k}px, ${dz * k}px)`;
        this._sticks[key] = { x: clamp(dx / radius, -1, 1), z: clamp(dz / radius, -1, 1) };
      };
      const clear = () => { knob.style.transform = ''; this._sticks[key] = null; id = null; };
      el.addEventListener('pointerdown', (e) => {
        id = e.pointerId; el.setPointerCapture(id);
        this.scheme = 'touch'; this.aim.mode = 'stick';
        const r = el.getBoundingClientRect();
        set(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId !== id) return;
        const r = el.getBoundingClientRect();
        set(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      });
      const end = (e) => { if (e.pointerId === id) clear(); };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    };
    mkStick(els.move, 'move');
    mkStick(els.aim, 'aim');

    const mkBtn = (el, key, edgeKey) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.scheme = 'touch';
        this._touchButtons[key] = true;
        if (edgeKey) this[edgeKey] = true;
        this.anyEdge = true;
      });
      const up = () => { this._touchButtons[key] = false; };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    mkBtn(els.dash, 'dash', 'dashEdge');
    mkBtn(els.pulse, 'pulse', 'pulseEdge');
    mkBtn(els.over, 'over', 'overdriveEdge');
    mkBtn(els.pause, 'pause', 'pauseEdge');
  }

  keyDown(code) { return this.keys.has(code); }
  /** Consumed edge: true only on the frame the key went down. */
  keyPressed(code) { return this.keyEdges.has(code); }

  releaseAll() {
    this.keys.clear();
    this.fire = false;
    this.firePulse = false;
    this._sticks.move = null;
    this._sticks.aim = null;
    for (const k in this._touchButtons) this._touchButtons[k] = false;
  }

  /** Called by the game each frame *before* systems read intent. */
  sample(dt) {
    if (this.suppress > 0) this.suppress -= dt;
    const locked = !this.enabled || this.suppress > 0;

    let mx = 0, mz = 0;
    if (!locked) {
      for (const code in KEY_MOVE) {
        if (this.keys.has(code)) { mx += KEY_MOVE[code][0]; mz += KEY_MOVE[code][1]; }
      }
    }

    let fire = locked ? false : this.fire;
    let pulseHeld = locked ? false : this.firePulse;
    let dash = false, pulse = false, over = false;

    if (!locked) {
      dash = this.keyEdges.has('Space') || this.keyEdges.has('ShiftLeft') || this.keyEdges.has('ShiftRight');
      pulse = this.pulseEdge || this.keyEdges.has('KeyE');
      over = this.overdriveEdge || this.keyEdges.has('KeyQ') || this.keyEdges.has('KeyF');
    }
    let pause = this.pauseEdge || this.keyEdges.has('Escape') || this.keyEdges.has('KeyP');

    // ---- gamepad ----
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    if (this.gamepadIndex >= 0 && pads[this.gamepadIndex]) pad = pads[this.gamepadIndex];
    else { for (const p of pads) { if (p && p.connected) { pad = p; this.gamepadIndex = p.index; break; } } }
    if (pad) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const rl = lengthXZ(ax, ay);
      if (rl > DEADZONE && !locked) {
        const s = (rl - DEADZONE) / (1 - DEADZONE) / rl;
        mx += ax * s; mz += ay * s;
        this.scheme = 'gamepad';
      }
      const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
      const rr = lengthXZ(rx, ry);
      if (rr > DEADZONE && !locked) {
        this.scheme = 'gamepad';
        this.aim.mode = 'stick';
        this.aim.dirX = rx / rr; this.aim.dirZ = ry / rr;
        this.aim.active = true;
        fire = true;                                   // twin-stick: aiming shoots
      }
      const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (!locked) {
        if (btn(7) || btn(0)) fire = true;             // RT / A
        if (btn(6) || btn(2)) { pulseHeld = true; }    // LT / X
        this._padEdge = this._padEdge || {};
        const edge = (i, name) => {
          const now = btn(i);
          const was = this._padEdge[name];
          this._padEdge[name] = now;
          return now && !was;
        };
        if (edge(5, 'rb') || edge(1, 'b')) dash = true;
        if (edge(6, 'lt') || edge(2, 'x')) pulse = true;
        if (edge(3, 'y')) over = true;
        if (edge(9, 'start')) pause = true;
        if (btn(0) || btn(1) || btn(7)) this.scheme = 'gamepad';
      } else {
        this._padEdge = {};
      }
    }

    // ---- touch ----
    if (this.hasTouch) {
      const sm = this._sticks.move;
      if (sm && !locked) { mx += sm.x; mz += sm.z; this.scheme = 'touch'; }
      const sa = this._sticks.aim;
      if (sa && !locked) {
        const l = lengthXZ(sa.x, sa.z);
        if (l > 0.25) {
          this.aim.mode = 'stick';
          this.aim.dirX = sa.x / l; this.aim.dirZ = sa.z / l;
          this.aim.active = true;
          fire = true;
        }
      }
      if (!locked) {
        if (this._touchButtons.pulse) pulseHeld = true;
        if (this._touchButtons.dash) dash = true;      // repeat-friendly; gated by charges
      }
    }

    const len = lengthXZ(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    this.move.x = mx; this.move.z = mz;

    this.fireHeld = fire;
    this.pulseHeld = pulseHeld;
    this.dashEdge = dash;
    this.pulseEdge = pulse;
    this.overdriveEdge = over;
    this.pauseEdge = pause;

    // Scripted control surface: the automated playtests drive the game through
    // exactly the same intent fields a human would produce.
    const o = this.override;
    if (o) {
      if (o.move) { this.move.x = o.move.x; this.move.z = o.move.z; }
      if (o.fire !== undefined) this.fireHeld = !!o.fire;
      if (o.aim) {
        this.aim.mode = 'stick';
        this.aim.active = true;
        this.aim.dirX = o.aim.x;
        this.aim.dirZ = o.aim.z;
      }
      if (o.dash) { this.dashEdge = true; o.dash = false; }
      if (o.pulse) { this.pulseEdge = true; o.pulse = false; }
      if (o.overdrive) { this.overdriveEdge = true; o.overdrive = false; }
      if (o.pause) { this.pauseEdge = true; o.pause = false; }
    }
  }

  /** Clear per-frame edges. Called at the very end of the frame. */
  endFrame() {
    this.keyEdges.clear();
    this.pulseEdge = false;
    this.overdriveEdge = false;
    this.dashEdge = false;
    this.pauseEdge = false;
    this.anyEdge = false;
    this._touchButtons.dash = false;
    this._touchButtons.over = false;
    this._touchButtons.pause = false;
  }

  /** Swallow inputs briefly — used when screens open/close so clicks don't leak into play. */
  lock(seconds = 0.14) {
    this.suppress = Math.max(this.suppress, seconds);
    this.fire = false;
    this.firePulse = false;
    this.keyEdges.clear();
  }

  dispose() {
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
  }
}
