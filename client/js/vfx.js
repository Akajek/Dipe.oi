// Particle system. Every effect is spawned from a server FX event, so all
// players see the same explosion in the same place at the same time.

import { TAU, randRange, randInt, clamp } from '../../shared/math.js';
import { FX, TEAM_COLORS, SHAPE_DEFS } from '../../shared/constants.js';

const MAX_PARTICLES = 1400;

// Particle kinds.
const P_SPARK = 0, P_PUFF = 1, P_SHARD = 2, P_RING = 3, P_FLASH = 4, P_TEXT = 5, P_CONE = 6;

class Particle {
  constructor() { this.alive = false; }
  init(kind, x, y) {
    this.kind = kind;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.life = 1; this.maxLife = 1;
    this.size = 4; this.growth = 0;
    this.angle = 0; this.spin = 0;
    this.color = '#fff';
    this.drag = 0.9;
    this.width = 2;
    this.text = '';
    this.sides = 0;
    this.alive = true;
    return this;
  }
}

export class VFX {
  constructor() {
    this.pool = [];
    this.active = [];
    for (let i = 0; i < MAX_PARTICLES; i++) this.pool.push(new Particle());
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.flashAlpha = 0;
    this.flashColor = '#fff';
    this.quality = 1;    // scales particle counts; dropped automatically if slow
    this.maxAlive = MAX_PARTICLES;
  }

  spawn(kind, x, y) {
    // Two ceilings: the pool itself, and a lower live cap that low-graphics
    // mode tightens so a big fight cannot flood a weak machine.
    if (this.active.length >= this.maxAlive) return null;
    const p = this.pool.pop();
    if (!p) return null;               // pool exhausted; drop the effect
    this.active.push(p.init(kind, x, y));
    return p;
  }

  addShake(amount) {
    this.shake = Math.min(34, this.shake + amount);
  }

  screenFlash(color, alpha) {
    if (alpha > this.flashAlpha) { this.flashAlpha = alpha; this.flashColor = color; }
  }

  count(n) {
    return Math.max(1, Math.round(n * this.quality));
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.active.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d;
      p.angle += p.spin * dt;
      p.size += p.growth * dt;
    }

    // Camera shake decays exponentially and jitters each frame.
    if (this.shake > 0.2) {
      this.shake *= Math.pow(0.0015, dt);
      this.shakeX = randRange(-this.shake, this.shake);
      this.shakeY = randRange(-this.shake, this.shake);
    } else {
      this.shake = 0; this.shakeX = 0; this.shakeY = 0;
    }
    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.4);
  }

  clear() {
    for (const p of this.active) { p.alive = false; this.pool.push(p); }
    this.active.length = 0;
    this.shake = 0; this.flashAlpha = 0;
  }

  // ---------------------------------------------------- server event handling

  /**
   * Turn one authoritative FX event into particles.
   * @param {object} ev  {kind, x, y, a, b, c}
   * @param {object} ctx {selfX, selfY, viewScale}
   */
  handle(ev, ctx) {
    const color = TEAM_COLORS[ev.c] || '#b6c2d4';
    const distToSelf = Math.hypot(ev.x - ctx.selfX, ev.y - ctx.selfY);
    const near = distToSelf < 900;

    switch (ev.kind) {
      case FX.FIRE:        this.muzzle(ev.x, ev.y, ev.a, ev.b, color); break;
      case FX.HIT:         this.hit(ev.x, ev.y, ev.a, ev.b, color); break;
      case FX.EXPLODE:     this.explode(ev.x, ev.y, ev.b, color); break;
      case FX.TANK_DEATH:  this.tankDeath(ev.x, ev.y, ev.b, color, near); break;
      case FX.SHAPE_DEATH: this.shapeDeath(ev.x, ev.y, ev.a, ev.b); break;
      case FX.LEVEL_UP:    this.levelUp(ev.x, ev.y, color); break;
      case FX.SPAWN:       this.spawnWarp(ev.x, ev.y, ev.b, color); break;
      case FX.HEAL:        this.heal(ev.x, ev.y, ev.b); break;
      case FX.BOSS_ROAR:   this.bossRoar(ev.x, ev.y); break;
      case FX.BOSS_SLAM:   this.bossSlam(ev.x, ev.y, ev.b * 8, distToSelf); break;
      default: break;
    }
  }

  muzzle(x, y, angle, width, color) {
    const w = Math.max(6, width);
    // A short bright cone at the barrel mouth.
    const cone = this.spawn(P_CONE, x, y);
    if (cone) {
      cone.angle = angle;
      cone.size = w * 0.9;
      cone.growth = w * 3;
      cone.life = cone.maxLife = 0.09;
      cone.color = '#fff6d8';
    }
    const flash = this.spawn(P_FLASH, x, y);
    if (flash) {
      flash.size = w * 0.85;
      flash.growth = -w * 2;
      flash.life = flash.maxLife = 0.12;
      flash.color = color;
    }
    for (let i = 0; i < this.count(3); i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = angle + randRange(-0.34, 0.34);
      const sp = randRange(120, 460);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.1, 0.26);
      p.size = randRange(1.4, 3);
      p.color = i % 2 ? '#ffe9a8' : color;
      p.drag = 0.86;
    }
  }

  hit(x, y, angle, size, color) {
    const n = this.count(clamp(size * 0.6, 4, 14));
    for (let i = 0; i < n; i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = angle + randRange(-1.1, 1.1);
      const sp = randRange(90, 420);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.12, 0.36);
      p.size = randRange(1.2, 2.8);
      p.color = i % 3 === 0 ? '#ffffff' : color;
      p.drag = 0.84;
    }
    const f = this.spawn(P_FLASH, x, y);
    if (f) {
      f.size = size * 0.7; f.growth = size * 2.2;
      f.life = f.maxLife = 0.1; f.color = '#ffffff';
    }
  }

  explode(x, y, size, color) {
    const r = Math.max(4, size);
    const puff = this.spawn(P_PUFF, x, y);
    if (puff) {
      puff.size = r * 0.8; puff.growth = r * 6;
      puff.life = puff.maxLife = 0.26; puff.color = color;
    }
    for (let i = 0; i < this.count(4); i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = randRange(60, 260);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.15, 0.4);
      p.size = randRange(1.4, 3.2);
      p.color = color;
    }
  }

  tankDeath(x, y, radius, color, near) {
    const r = Math.max(10, radius);
    // Shockwave.
    const ring = this.spawn(P_RING, x, y);
    if (ring) {
      ring.size = r; ring.growth = r * 13;
      ring.life = ring.maxLife = 0.45;
      ring.color = color; ring.width = 5;
    }
    const ring2 = this.spawn(P_RING, x, y);
    if (ring2) {
      ring2.size = r * 0.5; ring2.growth = r * 7;
      ring2.life = ring2.maxLife = 0.62;
      ring2.color = '#ffffff'; ring2.width = 2;
    }
    const flash = this.spawn(P_FLASH, x, y);
    if (flash) {
      flash.size = r * 2.4; flash.growth = r * 5;
      flash.life = flash.maxLife = 0.22; flash.color = '#ffffff';
    }
    // Hull fragments.
    for (let i = 0; i < this.count(18); i++) {
      const p = this.spawn(P_SHARD, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = randRange(120, 560);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.45, 1.05);
      p.size = randRange(r * 0.16, r * 0.42);
      p.angle = Math.random() * TAU;
      p.spin = randRange(-9, 9);
      p.color = color;
      p.sides = randInt(3, 4);
      p.drag = 0.93;
    }
    for (let i = 0; i < this.count(12); i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = randRange(200, 700);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.2, 0.5);
      p.size = randRange(1.6, 3.4);
      p.color = '#fff3c4';
    }
    if (near) this.addShake(Math.min(16, r * 0.42));
  }

  shapeDeath(x, y, angle, kind) {
    const def = SHAPE_DEFS[kind] || SHAPE_DEFS[0];
    const r = def.radius;
    for (let i = 0; i < this.count(def.sides * 2); i++) {
      const p = this.spawn(P_SHARD, x, y);
      if (!p) break;
      const a = angle + (i / (def.sides * 2)) * TAU + randRange(-0.3, 0.3);
      const sp = randRange(70, 300);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.35, 0.85);
      p.size = randRange(r * 0.2, r * 0.45);
      p.angle = a;
      p.spin = randRange(-7, 7);
      p.color = def.color;
      p.sides = def.sides;
      p.drag = 0.92;
    }
    const ring = this.spawn(P_RING, x, y);
    if (ring) {
      ring.size = r * 0.6; ring.growth = r * 6;
      ring.life = ring.maxLife = 0.3;
      ring.color = def.color; ring.width = 3;
    }
    if (kind === 3) {
      // Alpha pentagons go out with a bang.
      this.addShake(9);
      this.screenFlash(def.color, 0.16);
    }
  }

  levelUp(x, y, color) {
    for (let k = 0; k < 2; k++) {
      const ring = this.spawn(P_RING, x, y);
      if (!ring) break;
      ring.size = 12 + k * 16; ring.growth = 260;
      ring.life = ring.maxLife = 0.55 + k * 0.12;
      ring.color = k ? '#ffd34e' : color;
      ring.width = 4 - k;
    }
    for (let i = 0; i < this.count(16); i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = randRange(60, 230);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp - 90;
      p.life = p.maxLife = randRange(0.4, 0.9);
      p.size = randRange(1.8, 3.6);
      p.color = '#ffd34e';
      p.drag = 0.95;
    }
  }

  spawnWarp(x, y, radius, color) {
    const r = Math.max(12, radius);
    const ring = this.spawn(P_RING, x, y);
    if (ring) {
      // Implodes inward: starts wide, shrinks onto the tank.
      ring.size = r * 7; ring.growth = -r * 12;
      ring.life = ring.maxLife = 0.45;
      ring.color = color; ring.width = 3;
    }
    for (let i = 0; i < this.count(10); i++) {
      const p = this.spawn(P_SPARK, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const d = randRange(r * 3, r * 7);
      p.x = x + Math.cos(a) * d;
      p.y = y + Math.sin(a) * d;
      p.vx = -Math.cos(a) * d * 2.2;
      p.vy = -Math.sin(a) * d * 2.2;
      p.life = p.maxLife = 0.42;
      p.size = randRange(1.6, 3);
      p.color = color;
      p.drag = 0.97;
    }
  }

  heal(x, y, radius) {
    const p = this.spawn(P_SPARK, x + randRange(-radius, radius), y + randRange(-radius, radius));
    if (!p) return;
    p.vx = randRange(-12, 12); p.vy = randRange(-60, -28);
    p.life = p.maxLife = 0.7;
    p.size = 2.4;
    p.color = '#6ff0ad';
    p.drag = 0.98;
  }

  bossRoar(x, y) {
    for (let k = 0; k < 3; k++) {
      const ring = this.spawn(P_RING, x, y);
      if (!ring) break;
      ring.size = 40 + k * 40; ring.growth = 900 - k * 180;
      ring.life = ring.maxLife = 0.9 + k * 0.2;
      ring.color = k === 1 ? '#ffffff' : '#e8a33d';
      ring.width = 7 - k * 2;
    }
    this.addShake(26);
    this.screenFlash('#e8a33d', 0.3);
  }

  bossSlam(x, y, radius, distToSelf) {
    const ring = this.spawn(P_RING, x, y);
    if (ring) {
      ring.size = 30; ring.growth = radius * 2.4;
      ring.life = ring.maxLife = 0.42;
      ring.color = '#f14e54'; ring.width = 9;
    }
    const ring2 = this.spawn(P_RING, x, y);
    if (ring2) {
      ring2.size = 20; ring2.growth = radius * 2.1;
      ring2.life = ring2.maxLife = 0.5;
      ring2.color = '#ffd34e'; ring2.width = 3;
    }
    for (let i = 0; i < this.count(26); i++) {
      const p = this.spawn(P_SHARD, x, y);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = randRange(240, 820);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.life = p.maxLife = randRange(0.3, 0.7);
      p.size = randRange(4, 11);
      p.angle = a; p.spin = randRange(-8, 8);
      p.color = '#e8a33d';
      p.sides = 3;
      p.drag = 0.9;
    }
    // Shake scales with proximity to the slam.
    if (distToSelf < radius * 1.6) {
      this.addShake(22 * (1 - Math.min(1, distToSelf / (radius * 1.6))) + 5);
    }
  }

  /** Floating combat text, spawned locally (not server-driven). */
  floatText(x, y, text, color) {
    const p = this.spawn(P_TEXT, x, y);
    if (!p) return;
    p.text = text;
    p.color = color || '#fff';
    p.vy = -58;
    p.life = p.maxLife = 0.9;
    p.size = 15;
    p.drag = 0.99;
  }
}

export const PK = { P_SPARK, P_PUFF, P_SHARD, P_RING, P_FLASH, P_TEXT, P_CONE };
