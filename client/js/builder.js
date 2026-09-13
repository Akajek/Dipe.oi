// "The Forge" — the custom turret editor.
//
// Edits a build object in place, prices it live with the same cost model the
// server validates against, and previews it on a canvas you can click and drag.

import {
  FIELDS, BODY_SHAPES, TURRET_SHAPES, TURRET_TYPES, STARTER_BUILDS,
  defaultTurret, turretCost, buildCost, validateBuild, BUDGET, MAX_TURRETS,
} from '../../shared/builds.js';
import { TAU, clamp } from '../../shared/math.js';
import { TANK_BASE_RADIUS } from '../../shared/constants.js';

const STORE_KEY = 'turretforge.builds.v1';
const CURRENT_KEY = 'turretforge.current.v1';
const BODY_SIDES = { circle: 0, triangle: 3, square: 4, pentagon: 5, hexagon: 6 };
const PREVIEW_SCALE = 2.2;

const el = (id) => document.getElementById(id);

export class Builder {
  constructor(onSave) {
    this.onSave = onSave;
    this.build = this.loadCurrent();
    this.selected = 0;
    this.open = false;
    this.shots = [];
    this.dragging = false;
    this.lastFrame = 0;

    this.canvas = el('forgeCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.bindUI();
  }

  // ------------------------------------------------------------- persistence

  loadCurrent() {
    try {
      const raw = localStorage.getItem(CURRENT_KEY);
      if (raw) {
        const v = validateBuild(JSON.parse(raw));
        if (v.build) return v.build;
      }
    } catch { /* corrupt or unavailable storage: fall through */ }
    return structuredClone(STARTER_BUILDS[0].build);
  }

  saveCurrent() {
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify(this.build)); } catch { /* quota */ }
  }

  loadSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  writeSaved(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 24))); } catch { /* quota */ }
  }

  saveNamed() {
    const list = this.loadSaved();
    const name = (this.build.name || 'Custom').slice(0, 20);
    const copy = structuredClone(this.build);
    copy.name = name;
    const at = list.findIndex((b) => b.name === name);
    if (at >= 0) list[at] = copy; else list.unshift(copy);
    this.writeSaved(list);
    this.renderSaved();
  }

  // ----------------------------------------------------------------- open UI

  show() {
    this.open = true;
    el('forge').classList.remove('hidden');
    this.renderPresets();
    this.renderSaved();
    this.renderBodyOptions();
    this.refresh();
    this.resize();
  }

  hide() {
    this.open = false;
    el('forge').classList.add('hidden');
  }

  resize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = rect.width;
    this.ch = rect.height;
  }

  // ---------------------------------------------------------------- bindings

  bindUI() {
    el('forgeSave').addEventListener('click', () => {
      const v = validateBuild(this.build);
      if (!v.ok) { this.toast(v.reason, true); return; }
      this.saveCurrent();
      this.onSave(this.build);
      this.hide();
    });

    el('addTurret').addEventListener('click', () => {
      if (this.build.turrets.length >= MAX_TURRETS) { this.toast('Turret limit reached', true); return; }
      this.build.turrets.push(defaultTurret());
      this.selected = this.build.turrets.length - 1;
      this.refresh();
    });

    el('deleteTurret').addEventListener('click', () => {
      if (this.build.turrets.length <= 1) { this.toast('A tank needs at least one turret', true); return; }
      this.build.turrets.splice(this.selected, 1);
      this.selected = Math.max(0, this.selected - 1);
      this.refresh();
    });

    el('saveCurrent').addEventListener('click', () => {
      this.saveNamed();
      this.toast('Saved "' + this.build.name + '"');
    });

    el('buildName').addEventListener('input', (e) => {
      this.build.name = e.target.value.slice(0, 20);
    });

    el('bodyShape').addEventListener('change', (e) => {
      this.build.body = e.target.value;
    });

    el('testFire').addEventListener('click', () => this.testFire());

    // Preview interaction: click selects a turret, drag swings it around.
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = this.canvasPoint(e);
      const hit = this.turretAt(p.x, p.y);
      if (hit >= 0) {
        this.selected = hit;
        this.dragging = true;
        this.canvas.setPointerCapture(e.pointerId);
        this.refresh();
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const p = this.canvasPoint(e);
      const t = this.build.turrets[this.selected];
      if (!t) return;
      const dist = Math.hypot(p.x, p.y) / PREVIEW_SCALE;
      t.angle = clamp(Math.round((Math.atan2(p.y, p.x) * 180) / Math.PI), FIELDS.angle.min, FIELDS.angle.max);
      // Distance from hull centre maps to how far the barrel is pushed out.
      t.forward = clamp(Math.round(dist - t.length * 0.55), FIELDS.forward.min, FIELDS.forward.max);
      this.refresh();
    });

    const endDrag = () => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => { if (this.open) this.resize(); });
  }

  /** Pointer position in hull-local pixels (origin at the tank centre). */
  canvasPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - this.cw / 2, y: e.clientY - r.top - this.ch / 2 };
  }

  /** Index of the turret under a local point, or -1. */
  turretAt(x, y) {
    const s = PREVIEW_SCALE;
    for (let i = this.build.turrets.length - 1; i >= 0; i--) {
      const t = this.build.turrets[i];
      const dir = (t.angle * Math.PI) / 180;
      const cos = Math.cos(dir), sin = Math.sin(dir);
      const bx = -sin * t.offset * s + cos * t.forward * s;
      const by = cos * t.offset * s + sin * t.forward * s;
      // Rotate the point into barrel space and test the rectangle.
      const dx = x - bx, dy = y - by;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (lx >= -6 && lx <= t.length * s + 6 && Math.abs(ly) <= (t.width * s) / 2 + 6) return i;
    }
    return -1;
  }

  toast(msg, bad) {
    const box = document.getElementById('toast');
    const d = document.createElement('div');
    d.textContent = msg;
    if (bad) d.className = 'bad';
    box.appendChild(d);
    setTimeout(() => d.remove(), 3900);
  }

  // -------------------------------------------------------------- UI panels

  renderPresets() {
    const box = el('presetList');
    box.innerHTML = '';
    for (const p of STARTER_BUILDS) {
      const d = document.createElement('div');
      d.className = 'presetItem';
      d.innerHTML = '<b></b><small></small>';
      d.querySelector('b').textContent = p.label + '  (' + Math.round(buildCost(p.build)) + 'pts)';
      d.querySelector('small').textContent = p.desc;
      d.addEventListener('click', () => {
        this.build = structuredClone(p.build);
        this.selected = 0;
        this.refresh();
      });
      box.appendChild(d);
    }
  }

  renderSaved() {
    const box = el('savedList');
    box.innerHTML = '';
    const list = this.loadSaved();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No saved builds yet.';
      box.appendChild(p);
      return;
    }
    list.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'presetItem';
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = 'x';
      del.title = 'Delete';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const next = this.loadSaved();
        next.splice(i, 1);
        this.writeSaved(next);
        this.renderSaved();
      });
      const name = document.createElement('b');
      name.textContent = b.name || 'Custom';
      const meta = document.createElement('small');
      meta.textContent = (b.turrets ? b.turrets.length : 0) + ' turrets, ' + Math.round(buildCost(b)) + 'pts';
      d.appendChild(del); d.appendChild(name); d.appendChild(meta);
      d.addEventListener('click', () => {
        const v = validateBuild(b);
        this.build = v.build;
        this.selected = 0;
        this.refresh();
      });
      box.appendChild(d);
    });
  }

  renderBodyOptions() {
    const sel = el('bodyShape');
    sel.innerHTML = '';
    for (const b of BODY_SHAPES) {
      const o = document.createElement('option');
      o.value = b;
      o.textContent = b[0].toUpperCase() + b.slice(1);
      sel.appendChild(o);
    }
  }

  renderTabs() {
    const box = el('turretTabs');
    box.innerHTML = '';
    this.build.turrets.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'tTab' + (i === this.selected ? ' active' : '');
      d.innerHTML = '<span></span><span class="c"></span>';
      d.querySelector('span').textContent = '#' + (i + 1);
      d.querySelector('.c').textContent = Math.round(turretCost(t)) + 'p';
      d.addEventListener('click', () => { this.selected = i; this.refresh(); });
      box.appendChild(d);
    });
    el('turretCount').textContent = this.build.turrets.length + '/' + MAX_TURRETS;
  }

  renderProps() {
    const box = el('turretProps');
    box.innerHTML = '';
    const t = this.build.turrets[this.selected];
    if (!t) return;

    box.appendChild(this.segmented('Type', TURRET_TYPES, t.type, (v) => {
      t.type = v;
      // Drone barrels cap their swarm size; re-clamp so the UI cannot lie.
      if (v === 'drone') t.count = clamp(Math.round(t.count), 1, 4);
      this.refresh();
    }));
    box.appendChild(this.segmented('Barrel shape', TURRET_SHAPES, t.shape, (v) => {
      t.shape = v;
      this.refresh();
    }));

    const order = ['angle', 'offset', 'forward', 'length', 'width', 'damage', 'reload', 'speed', 'count', 'spread', 'size', 'pen', 'life', 'recoil'];
    for (const key of order) {
      const f = FIELDS[key];
      if (!f) continue;
      const max = key === 'count' && t.type === 'drone' ? 4 : f.max;
      box.appendChild(this.slider(key, f, max, t));
    }
  }

  segmented(label, options, value, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'prop';
    const row = document.createElement('div');
    row.className = 'row';
    const b = document.createElement('b');
    b.textContent = label;
    row.appendChild(b);
    wrap.appendChild(row);

    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.textContent = opt;
      if (opt === value) btn.className = 'on';
      btn.addEventListener('click', () => onPick(opt));
      seg.appendChild(btn);
    }
    wrap.appendChild(seg);
    return wrap;
  }

  slider(key, f, max, turret) {
    const wrap = document.createElement('div');
    wrap.className = 'prop';

    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('b');
    name.textContent = f.label;
    const val = document.createElement('i');
    const fmt = (v) => (f.step < 1 ? v.toFixed(2) : String(Math.round(v)));
    val.textContent = fmt(turret[key]);
    row.appendChild(name); row.appendChild(val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min);
    input.max = String(max);
    input.step = String(f.step);
    input.value = String(turret[key]);
    input.addEventListener('input', () => {
      turret[key] = Number(input.value);
      val.textContent = fmt(turret[key]);
      // Live-update cost and preview without rebuilding the whole panel,
      // so dragging a slider stays smooth.
      this.updateBudget();
      this.renderTabs();
    });

    const help = document.createElement('small');
    help.textContent = f.help;

    wrap.appendChild(row);
    wrap.appendChild(input);
    wrap.appendChild(help);
    return wrap;
  }

  updateBudget() {
    const cost = buildCost(this.build);
    const pct = Math.min(100, (cost / BUDGET) * 100);
    const fill = el('budgetFill');
    const text = el('budgetText');
    fill.style.width = pct + '%';
    const over = cost > BUDGET + 0.5;
    fill.classList.toggle('over', over);
    text.classList.toggle('over', over);
    text.textContent = cost.toFixed(1) + ' / ' + BUDGET + (over ? ' — over!' : '');
    el('forgeSave').disabled = over;
  }

  refresh() {
    this.selected = clamp(this.selected, 0, Math.max(0, this.build.turrets.length - 1));
    el('buildName').value = this.build.name || 'Custom';
    el('bodyShape').value = this.build.body;
    this.renderTabs();
    this.renderProps();
    this.updateBudget();
    this.saveCurrent();
  }

  // ----------------------------------------------------------------- preview

  testFire() {
    const s = PREVIEW_SCALE;
    for (const t of this.build.turrets) {
      const dir = (t.angle * Math.PI) / 180;
      const cos = Math.cos(dir), sin = Math.sin(dir);
      const bx = -sin * t.offset * s + cos * t.forward * s;
      const by = cos * t.offset * s + sin * t.forward * s;
      const mx = bx + cos * t.length * s, my = by + sin * t.length * s;
      const n = t.type === 'drone' ? 1 : t.count;
      for (let i = 0; i < n; i++) {
        const jitter = ((Math.random() - 0.5) * t.spread * Math.PI) / 180;
        const a = dir + jitter;
        this.shots.push({
          x: mx, y: my,
          vx: Math.cos(a) * t.speed * 26,
          vy: Math.sin(a) * t.speed * 26,
          r: t.width * 0.45 * t.size * s,
          life: Math.min(1.4, t.life),
          maxLife: Math.min(1.4, t.life),
          type: t.type,
          angle: a,
        });
      }
      // Muzzle spark so the barrel visibly kicks.
      t._flash = 1;
    }
  }

  drawPreview(dt) {
    const ctx = this.ctx;
    const w = this.cw, h = this.ch;
    if (!w || !h) return;
    const s = PREVIEW_SCALE;

    ctx.clearRect(0, 0, w, h);

    // Backdrop grid.
    ctx.fillStyle = '#1f232b';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (w / 2) % 30; x < w; x += 30) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = (h / 2) % 30; y < h; y += 30) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    ctx.save();
    ctx.translate(w / 2, h / 2);

    // Shots first, so they fly out from under the hull.
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const b = this.shots[i];
      b.life -= dt;
      if (b.life <= 0 || Math.abs(b.x) > w || Math.abs(b.y) > h) { this.shots.splice(i, 1); continue; }
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.type === 'trap') { b.vx *= 0.94; b.vy *= 0.94; b.angle += dt * 3; }
      ctx.globalAlpha = clamp(b.life / b.maxLife, 0, 1);
      ctx.fillStyle = '#00b2e1';
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (b.type === 'bullet') {
        ctx.arc(b.x, b.y, b.r, 0, TAU);
      } else {
        const sides = b.type === 'drone' ? 3 : 6;
        for (let k = 0; k < sides; k++) {
          const a = b.angle + (k / sides) * TAU;
          const rr = b.type === 'trap' && k % 2 ? b.r * 0.6 : b.r * 1.3;
          const px = b.x + Math.cos(a) * rr, py = b.y + Math.sin(a) * rr;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Barrels.
    this.build.turrets.forEach((t, i) => {
      const selected = i === this.selected;
      const dir = (t.angle * Math.PI) / 180;
      const cos = Math.cos(dir), sin = Math.sin(dir);
      let kick = 0;
      if (t._flash > 0) {
        t._flash = Math.max(0, t._flash - dt * 6);
        kick = -t._flash * 5;
      }
      const bx = -sin * t.offset * s + cos * (t.forward * s + kick);
      const by = cos * t.offset * s + sin * (t.forward * s + kick);
      const len = t.length * s;
      const hw = (t.width * s) / 2;
      let farW = hw;
      if (t.shape === 'trap') farW = hw * 1.5;
      else if (t.shape === 'trapInv') farW = hw * 0.62;

      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(dir);
      ctx.fillStyle = selected ? '#c8d2de' : '#999999';
      ctx.strokeStyle = selected ? '#00b2e1' : '#727272';
      ctx.lineWidth = selected ? 3.5 : 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (t.shape === 'bulge') {
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

      if (t._flash > 0) {
        ctx.globalAlpha = t._flash;
        ctx.fillStyle = '#fff6d8';
        ctx.beginPath();
        ctx.moveTo(len, -farW);
        ctx.lineTo(len + farW * 2.2, 0);
        ctx.lineTo(len, farW);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      if (selected) {
        // Handle marker at the muzzle to advertise drag-to-aim.
        const mx = bx + cos * len, my = by + sin * len;
        ctx.strokeStyle = 'rgba(0,178,225,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(mx, my, 9, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Hull.
    const r = TANK_BASE_RADIUS * s;
    const sides = BODY_SIDES[this.build.body] || 0;
    ctx.fillStyle = '#00b2e1';
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    if (sides < 3) ctx.arc(0, 0, r, 0, TAU);
    else {
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * TAU;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Facing hint.
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('facing ->', w - 14, h - 14);
  }

  frame(now) {
    if (!this.open) { this.lastFrame = now; return; }
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000 || 0);
    this.lastFrame = now;
    this.drawPreview(dt);
  }
}
