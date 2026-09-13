// Keyboard/mouse capture, plus local movement prediction so the tank responds
// on the same frame as the keypress instead of a round trip later.

import { KEY } from '../../shared/protocol.js';
import { FRICTION, BASE_ACCEL, WORLD_SIZE, TICK_RATE } from '../../shared/constants.js';
import { clamp } from '../../shared/math.js';

const BINDS = {
  KeyW: KEY.UP, ArrowUp: KEY.UP,
  KeyS: KEY.DOWN, ArrowDown: KEY.DOWN,
  KeyA: KEY.LEFT, ArrowLeft: KEY.LEFT,
  KeyD: KEY.RIGHT, ArrowRight: KEY.RIGHT,
};

export class Input {
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.keys = 0;
    this.autofire = false;
    this.autospin = false;
    this.mouseX = 0;
    this.mouseY = 0;
    this.enabled = false;
    this.chatting = false;

    // Predicted local state.
    this.px = WORLD_SIZE / 2;
    this.py = WORLD_SIZE / 2;
    this.pvx = 0;
    this.pvy = 0;
    this.accel = BASE_ACCEL;
    this.hasPrediction = false;

    this.bind();
  }

  bind() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys = 0; });
    window.addEventListener('mousemove', (e) => { this.mouseX = e.clientX; this.mouseY = e.clientY; });
    window.addEventListener('mousedown', (e) => {
      if (!this.enabled || e.button !== 0) return;
      if (e.target !== this.canvas) return;
      this.keys |= KEY.SHOOT;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.keys &= ~KEY.SHOOT; });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });

    // Touch: drag to aim and fire.
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const t = e.touches[0];
      this.mouseX = t.clientX; this.mouseY = t.clientY;
      this.keys |= KEY.SHOOT;
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      this.mouseX = t.clientX; this.mouseY = t.clientY;
    }, { passive: true });
    this.canvas.addEventListener('touchend', () => { this.keys &= ~KEY.SHOOT; });
  }

  onKey(e, down) {
    if (this.chatting) {
      if (down && e.code === 'Escape') this.hooks.onChatToggle(false);
      return;
    }
    if (!this.enabled) return;

    const bit = BINDS[e.code];
    if (bit) {
      e.preventDefault();
      if (down) this.keys |= bit; else this.keys &= ~bit;
      return;
    }
    if (!down) return;

    if (e.code === 'KeyE') {
      this.autofire = !this.autofire;
      this.hooks.onToggle('Autofire', this.autofire);
    } else if (e.code === 'KeyR') {
      this.autospin = !this.autospin;
      this.hooks.onToggle('Autospin', this.autospin);
    } else if (e.code === 'Enter') {
      this.hooks.onChatToggle(true);
    } else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 8) this.hooks.onUpgrade(n - 1);
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.keys |= KEY.SHOOT;
      setTimeout(() => { this.keys &= ~KEY.SHOOT; }, 60);
    }
  }

  /** Bitmask sent to the server this tick. */
  packedKeys() {
    let k = this.keys;
    if (this.autofire) k |= KEY.AUTOFIRE;
    if (this.autospin) k |= KEY.AUTOSPIN;
    return k;
  }

  /** Aim in world space, relative to the predicted tank position. */
  aim(renderer) {
    const w = renderer.screenToWorld(this.mouseX, this.mouseY);
    const dx = w.x - this.px, dy = w.y - this.py;
    return { angle: Math.atan2(dy, dx), dist: Math.min(4000, Math.hypot(dx, dy)), x: w.x, y: w.y };
  }

  /**
   * Advance the predicted position by one frame and pull it toward the
   * server's authoritative position.
   * @param {number} dt seconds
   * @param {object|null} serverSelf latest authoritative entity for this player
   */
  predict(dt, serverSelf) {
    if (!serverSelf) { this.hasPrediction = false; return; }

    if (!this.hasPrediction) {
      // First sight of our tank: adopt the server position outright.
      this.px = serverSelf.x; this.py = serverSelf.y;
      this.pvx = 0; this.pvy = 0;
      this.hasPrediction = true;
      return;
    }

    // Integrate the same way the server does, in tick-sized steps.
    const steps = clamp(Math.round(dt * TICK_RATE), 0, 3);
    for (let i = 0; i < steps; i++) {
      let dx = 0, dy = 0;
      if (this.keys & KEY.LEFT) dx -= 1;
      if (this.keys & KEY.RIGHT) dx += 1;
      if (this.keys & KEY.UP) dy -= 1;
      if (this.keys & KEY.DOWN) dy += 1;
      if (dx || dy) {
        const m = Math.hypot(dx, dy);
        this.pvx += (dx / m) * this.accel;
        this.pvy += (dy / m) * this.accel;
      }
      this.px += this.pvx;
      this.py += this.pvy;
      this.pvx *= FRICTION;
      this.pvy *= FRICTION;
    }
    this.px = clamp(this.px, 0, WORLD_SIZE);
    this.py = clamp(this.py, 0, WORLD_SIZE);

    // Reconcile. A big gap means a teleport, knockback or respawn: snap.
    const ex = serverSelf.x - this.px, ey = serverSelf.y - this.py;
    const err = Math.hypot(ex, ey);
    if (err > 260) {
      this.px = serverSelf.x; this.py = serverSelf.y;
      this.pvx = 0; this.pvy = 0;
    } else if (err > 0.5) {
      // Blend rate rises with error so small drift stays invisible.
      const k = clamp(err / 120, 0.08, 0.5);
      this.px += ex * k;
      this.py += ey * k;
    }
  }

  /** Update the predicted acceleration when our move-speed stat changes. */
  setMoveStat(level) {
    this.accel = BASE_ACCEL * (1 + level * 0.13);
  }

  reset() {
    this.hasPrediction = false;
    this.keys = 0;
    this.pvx = 0; this.pvy = 0;
  }
}
