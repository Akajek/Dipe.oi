// Canvas2D world renderer. Tanks are drawn directly from their build
// definition, so a custom turret layout looks the same for every player.

import { TAU, clamp } from '../../shared/math.js';
import {
  WORLD_SIZE, GRID_STEP, ENT, SHAPE_DEFS, TEAM_COLORS, TANK_BASE_RADIUS,
} from '../../shared/constants.js';
import { EF } from '../../shared/protocol.js';
import { PK } from './vfx.js';
import { glowSprite, calibrateGlow } from './sprites.js';

const BARREL_FILL = '#999999';
const BARREL_LINE = '#727272';
const OUTLINE = 'rgba(0,0,0,0.28)';
const GRID_COLOR = 'rgba(0,0,0,0.14)';
const BG = '#1f232b';
const BG_OUT = '#121419';   // outside the arena: clearly darker, with a red wash

const BODY_SIDES = { circle: 0, triangle: 3, square: 4, pentagon: 5, hexagon: 6 };
const HOSTILE_COLOR = '#f14e54';

/**
 * In team modes the team colour already says who is who. In FFA everyone is
 * TEAM.NONE, so fall back to the per-viewer hostile flag from the server.
 */
function factionColor(e) {
  const base = TEAM_COLORS[e.team] || '#b6c2d4';
  if (e.team === 0 && (e.flags & EF.HOSTILE)) return HOSTILE_COLOR;
  return base;
}

export class Renderer {
  constructor(canvas, vfx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.vfx = vfx;
    this.dpr = 1;
    this.dprScale = 1;
    this.w = 0; this.h = 0;
    this.vignette = null;
    this.lowFx = false;
    // Whichever soft-glow path is actually faster on this machine.
    this.glowMode = calibrateGlow();
    this.zoom = 1;
    this.camX = WORLD_SIZE / 2;
    this.camY = WORLD_SIZE / 2;
  }

  resize() {
    // Every DPR step squares the pixels we have to fill. 1.5 is the point
    // where the extra sharpness stops being worth it; `dprScale` lets the
    // auto-quality logic drop us to 1.0 on machines that are struggling.
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5) * this.dprScale;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.vignette = null;   // depends on viewport size; rebuilt on next draw
  }

  /** Called by the auto-quality logic when the frame rate is struggling. */
  setDprScale(scale) {
    if (scale === this.dprScale) return;
    this.dprScale = scale;
    this.resize();
  }

  /** World units visible across the viewport at the current zoom. */
  viewSize() {
    return { w: this.w / this.zoom, h: this.h / this.zoom };
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.camX) * this.zoom + this.w / 2 + this.vfx.shakeX,
      y: (y - this.camY) * this.zoom + this.h / 2 + this.vfx.shakeY,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.w / 2) / this.zoom + this.camX,
      y: (sy - this.h / 2) / this.zoom + this.camY,
    };
  }

  begin() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BG_OUT;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    // World transform, including camera shake.
    ctx.translate(this.w / 2 + this.vfx.shakeX, this.h / 2 + this.vfx.shakeY);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.camX, -this.camY);
  }

  end() {
    this.ctx.restore();
  }

  drawArena() {
    const ctx = this.ctx;
    const v = this.viewSize();
    const x0 = this.camX - v.w / 2 - 80, x1 = this.camX + v.w / 2 + 80;
    const y0 = this.camY - v.h / 2 - 80, y1 = this.camY + v.h / 2 + 80;

    // Playfield.
    ctx.fillStyle = BG;
    ctx.fillRect(
      Math.max(0, x0), Math.max(0, y0),
      Math.min(WORLD_SIZE, x1) - Math.max(0, x0),
      Math.min(WORLD_SIZE, y1) - Math.max(0, y0)
    );

    // Grid, clipped to what is on screen.
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    const gx0 = Math.floor(Math.max(0, x0) / GRID_STEP) * GRID_STEP;
    const gy0 = Math.floor(Math.max(0, y0) / GRID_STEP) * GRID_STEP;
    for (let x = gx0; x <= Math.min(WORLD_SIZE, x1); x += GRID_STEP) {
      ctx.moveTo(x, Math.max(0, y0)); ctx.lineTo(x, Math.min(WORLD_SIZE, y1));
    }
    for (let y = gy0; y <= Math.min(WORLD_SIZE, y1); y += GRID_STEP) {
      ctx.moveTo(Math.max(0, x0), y); ctx.lineTo(Math.min(WORLD_SIZE, x1), y);
    }
    ctx.stroke();

    // Out-of-bounds wash, so the map edge is unmistakable.
    ctx.save();
    ctx.fillStyle = 'rgba(241,78,84,0.05)';
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.rect(0, 0, WORLD_SIZE, WORLD_SIZE);
    ctx.fill('evenodd');
    ctx.restore();

    // Arena border.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 6 / this.zoom;
    ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  }

  /**
   * Soft radial glow, drawn the faster way for this machine. Skipped entirely
   * in low-graphics mode, where large alpha blends are the thing to cut first.
   */
  glow(x, y, r, color, alpha) {
    if (this.lowFx || r <= 0) return;
    const ctx = this.ctx;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    if (this.glowMode === 'sprite') {
      ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
    } else {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = prev;
  }

  // --------------------------------------------------------------- primitives

  polygon(x, y, r, sides, rot) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (sides < 3) {
      ctx.arc(x, y, r, 0, TAU);
      return;
    }
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * One barrel, in world space. `shape` tapers the far end:
   *   rect     - parallel sides
   *   trap     - widens toward the muzzle (trapper look)
   *   trapInv  - narrows toward the muzzle (drone spawner look)
   *   bulge    - pinched waist, fat muzzle
   */
  barrel(cx, cy, tankAngle, b, scale) {
    const ctx = this.ctx;
    const dir = tankAngle + (b.angle * Math.PI) / 180;
    const cos = Math.cos(dir), sin = Math.sin(dir);
    const bx = cx + -sin * b.offset * scale + cos * b.forward * scale;
    const by = cy + cos * b.offset * scale + sin * b.forward * scale;
    const len = b.length * scale;
    const hw = (b.width * scale) / 2;

    let farW = hw;
    if (b.shape === 'trap') farW = hw * 1.5;
    else if (b.shape === 'trapInv') farW = hw * 0.62;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(dir);
    ctx.beginPath();
    if (b.shape === 'bulge') {
      ctx.moveTo(0, -hw * 0.7);
      ctx.lineTo(len * 0.55, -hw);
      ctx.lineTo(len, -hw * 1.15);
      ctx.lineTo(len, hw * 1.15);
      ctx.lineTo(len * 0.55, hw);
      ctx.lineTo(0, hw * 0.7);
    } else {
      ctx.moveTo(0, -hw);
      ctx.lineTo(len, -farW);
      ctx.lineTo(len, farW);
      ctx.lineTo(0, hw);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ shapes

  drawShape(e) {
    const ctx = this.ctx;
    const def = SHAPE_DEFS[e.styleId] || SHAPE_DEFS[0];
    const hurt = (e.flags & EF.HURT) !== 0;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = hurt ? '#ffffff' : def.color;
    this.polygon(e.x, e.y, e.radius, def.sides, e.angle);
    ctx.fill();
    ctx.stroke();
    if (e.hpRatio < 0.999) this.healthBar(e.x, e.y + e.radius + 11, e.radius * 1.5, e.hpRatio, '#89e36a');
  }

  // ------------------------------------------------------------- projectiles

  drawProjectile(e) {
    const ctx = this.ctx;
    const color = factionColor(e);
    const hurt = (e.flags & EF.HURT) !== 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = hurt ? '#ffffff' : color;

    if (e.type === ENT.TRAP) {
      // Traps read as spiky hazards.
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.angle);
      ctx.beginPath();
      const r = e.radius * 1.35;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const rr = i % 2 === 0 ? r : r * 0.52;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (e.type === ENT.DRONE) {
      this.polygon(e.x, e.y, e.radius * 1.45, 3, e.angle);
      ctx.fill();
      ctx.stroke();
      return;
    }

    // Bullets get a short motion streak so fast shots read as fast.
    if (!this.lowFx && e.vx !== undefined && (Math.abs(e.vx) > 0.02 || Math.abs(e.vy) > 0.02)) {
      const sp = Math.hypot(e.vx, e.vy);
      const tail = clamp(sp * 6, 0, e.radius * 5);
      if (tail > 3) {
        const nx = e.vx / sp, ny = e.vy / sp;
        // A flat translucent stroke instead of a per-frame gradient. At this
        // size the taper was never visible, and this is an order of magnitude
        // cheaper when canvas is software-rasterised.
        ctx.save();
        ctx.globalAlpha = 0.32;
        ctx.strokeStyle = color;
        ctx.lineWidth = e.radius * 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x - nx * tail, e.y - ny * tail);
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 3;
      }
    }

    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }

  // ------------------------------------------------------------------- tanks

  drawTank(e, build, player, isSelf) {
    const ctx = this.ctx;
    const color = factionColor(e);
    const hurt = (e.flags & EF.HURT) !== 0;
    const boss = (e.flags & EF.BOSS) !== 0;
    const invuln = (e.flags & EF.INVULN) !== 0;
    const scale = e.radius / TANK_BASE_RADIUS;

    ctx.save();
    if (invuln) ctx.globalAlpha = 0.62;

    if (boss) {
      // Menacing aura so the boss reads instantly at any zoom.
      const pulse = 1 + Math.sin(performance.now() / 220) * 0.06;
      const aura = e.radius * 2.1 * pulse;
      this.glow(e.x, e.y, aura, '#e8a33d', 0.34);
    }

    // Barrels sit under the hull.
    ctx.fillStyle = hurt ? '#ffffff' : BARREL_FILL;
    ctx.strokeStyle = BARREL_LINE;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    if (build && build.turrets) {
      for (const b of build.turrets) this.barrel(e.x, e.y, e.angle, b, scale);
    }

    // Hull.
    const sides = build ? (BODY_SIDES[build.body] || 0) : 0;
    ctx.fillStyle = hurt ? '#ffffff' : color;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3.5;
    this.polygon(e.x, e.y, e.radius, sides, sides ? e.angle : 0);
    ctx.fill();
    ctx.stroke();

    if (isSelf) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius + 4, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    // Name + health.
    const name = player ? player.name : '';
    const below = e.y + e.radius + 15;
    if (e.hpRatio < 0.999) {
      this.healthBar(e.x, below, Math.max(34, e.radius * 1.7), e.hpRatio, boss ? '#e8a33d' : '#7ce47c');
    }
    if (name) {
      ctx.save();
      ctx.font = '700 ' + Math.max(12, 13 * Math.min(2.2, scale)) + 'px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.fillStyle = boss ? '#ffce7a' : '#ffffff';
      const ny = e.y - e.radius - 12;
      ctx.strokeText(name, e.x, ny);
      ctx.fillText(name, e.x, ny);
      if (e.aux > 1) {
        ctx.font = '600 11px Segoe UI, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.strokeText('Lv ' + e.aux, e.x, ny - 13);
        ctx.fillText('Lv ' + e.aux, e.x, ny - 13);
      }
      ctx.restore();
    }
  }

  /**
   * Rounded rectangle with a square-corner fallback.
   *
   * ctx.roundRect only arrived in Firefox 116 and Safari 16. This runs for
   * every damaged entity on every frame, so on an older browser the missing
   * method throws inside the draw loop and takes the whole frame with it --
   * the game looks broken rather than slightly less rounded.
   */
  roundedRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  healthBar(x, y, halfW, ratio, color) {
    const ctx = this.ctx;
    const w = halfW * 2, h = 6;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    this.roundedRect(x - halfW - 2, y - h / 2 - 2, w + 4, h + 4, 5);
    ctx.fill();
    ctx.fillStyle = color;
    this.roundedRect(x - halfW, y - h / 2, Math.max(2, w * clamp(ratio, 0, 1)), h, 3);
    ctx.fill();
    ctx.restore();
  }

  // --------------------------------------------------------------- particles

  drawParticles() {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    for (const p of this.vfx.active) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a;
      switch (p.kind) {
        case PK.P_SPARK:
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.4, p.size * a), 0, TAU);
          ctx.fill();
          break;

        case PK.P_PUFF:
          this.glow(p.x, p.y, Math.max(0.5, p.size), p.color, a * 0.42);
          break;

        case PK.P_SHARD: {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.color;
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 2;
          this.polygon(p.x, p.y, Math.max(0.5, p.size), p.sides || 3, p.angle);
          ctx.fill();
          ctx.stroke();
          break;
        }

        case PK.P_RING:
          ctx.globalAlpha = a * 0.8;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.5, p.width * a);
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, p.size), 0, TAU);
          ctx.stroke();
          break;

        case PK.P_FLASH:
          this.glow(p.x, p.y, Math.max(0.5, p.size), p.color, a * 0.75);
          break;

        case PK.P_CONE: {
          ctx.globalAlpha = a * 0.85;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(0, -p.size * 0.5);
          ctx.lineTo(p.size * 1.1, 0);
          ctx.lineTo(0, p.size * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }

        case PK.P_TEXT:
          ctx.globalAlpha = a;
          ctx.font = '700 ' + p.size + 'px Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.fillStyle = p.color;
          ctx.strokeText(p.text, p.x, p.y);
          ctx.fillText(p.text, p.x, p.y);
          break;

        default: break;
      }
    }
    ctx.restore();
  }

  /** Full-screen tint used for big events. Drawn in screen space. */
  drawOverlay() {
    const ctx = this.ctx;
    if (this.vfx.flashAlpha > 0.002) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, this.vfx.flashAlpha);
      ctx.fillStyle = this.vfx.flashColor;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }
    // Vignette. A full-screen alpha blend every frame, which is cheap on a GPU
    // and expensive in software -- so low-graphics mode goes without.
    if (this.lowFx) return;
    if (!this.vignette) {
      this.vignette = ctx.createRadialGradient(
        this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.42,
        this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.78
      );
      this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
      this.vignette.addColorStop(1, 'rgba(0,0,0,0.34)');
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, this.w, this.h);
  }
}
