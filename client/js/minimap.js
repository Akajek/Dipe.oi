// Bottom-right minimap: arena bounds, teammates, enemies, boss and your own
// viewport rectangle.

import { WORLD_SIZE, ENT, TEAM_COLORS } from '../../shared/constants.js';
import { EF } from '../../shared/protocol.js';

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 172;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(ents, selfId, camX, camY, viewW, viewH) {
    const ctx = this.ctx;
    const s = this.size;
    const k = s / WORLD_SIZE;
    ctx.clearRect(0, 0, s, s);

    ctx.fillStyle = 'rgba(31,35,43,0.85)';
    ctx.fillRect(0, 0, s, s);

    // Viewport box.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect((camX - viewW / 2) * k, (camY - viewH / 2) * k, viewW * k, viewH * k);

    for (const e of ents) {
      if (e.type !== ENT.TANK) continue;
      const isSelf = e.id === selfId;
      const boss = (e.flags & EF.BOSS) !== 0;
      const x = e.x * k, y = e.y * k;

      if (boss) {
        ctx.fillStyle = '#e8a33d';
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        continue;
      }

      ctx.fillStyle = isSelf ? '#ffffff' : (TEAM_COLORS[e.team] || '#b6c2d4');
      ctx.beginPath();
      ctx.arc(x, y, isSelf ? 3.4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      if (isSelf) {
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  }
}
