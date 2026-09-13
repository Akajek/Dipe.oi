// One arena instance: world state, physics, mode rules and per-client snapshots.

import { clamp, randRange, randInt } from '../shared/math.js';
import { TICK_RATE, WORLD_SIZE, ENT, SHAPE, TEAM, FX, GAME_MODES } from '../shared/constants.js';
import { writeSnapshot, EF } from '../shared/protocol.js';
import { Tank, Shape } from './entities.js';
import { BOSS_BUILD, buildKey } from '../shared/builds.js';

const CELL = 140;
const GRID_W = Math.ceil(WORLD_SIZE / CELL);
const isProjectile = (e) => e.type === ENT.BULLET || e.type === ENT.DRONE || e.type === ENT.TRAP;

// Faction ids keep "who may hurt whom" independent of the team colour on the
// wire. In FFA every tank is its own faction; in TDM factions are the teams.
const FACTION_SHAPES = 0;
const FACTION_TDM = 100;
const FACTION_BOSS_PLAYERS = 200;
const FACTION_BOSS = 201;

export class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode;
    this.modeDef = GAME_MODES[mode];
    this.tick = 0;
    this.entities = new Map();
    this.clients = new Set();
    this.events = [];
    this.cells = new Map();
    this.shapeDeaths = 0;
    this.styleIds = new Map();   // buildKey -> styleId
    this.styleDefs = new Map();  // styleId -> build
    this.nextStyleId = 1;

    // Boss-mode round state.
    this.boss = null;
    this.bossClient = null;
    this.roundTimer = 0;
    this.roundState = 'waiting';
    this.bossDamage = new Map();

    this.targetShapes = 380;
    this.seedShapes();
  }

  // ------------------------------------------------------------- entity set

  add(e) {
    this.entities.set(e.id, e);
    return e;
  }

  remove(e) {
    if (this.entities.delete(e.id)) e.onRemove(this);
  }

  fx(kind, x, y, a = 0, b = 0, c = 0) {
    // Hard cap so a pathological tick can't blow up every client's frame.
    if (this.events.length < 600) this.events.push({ kind, x, y, a, b, c });
  }

  seedShapes() {
    for (let i = 0; i < this.targetShapes; i++) this.spawnShape();
  }

  spawnShape() {
    const roll = Math.random();
    // Alpha pentagons are rare centrepieces; squares are the bread and butter.
    const kind = roll < 0.66 ? SHAPE.SQUARE : roll < 0.9 ? SHAPE.TRIANGLE : roll < 0.995 ? SHAPE.PENTAGON : SHAPE.ALPHA;
    const m = 160;
    const s = new Shape(kind, randRange(m, WORLD_SIZE - m), randRange(m, WORLD_SIZE - m));
    s.faction = FACTION_SHAPES;
    this.add(s);
    return s;
  }

  // ------------------------------------------------------------- join/leave

  teamForNewPlayer() {
    if (this.mode !== 'tdm') return TEAM.NONE;
    // Balance by headcount, tie-break randomly.
    let blue = 0, red = 0;
    for (const c of this.clients) {
      if (!c.tank) continue;
      if (c.tank.team === TEAM.BLUE) blue++; else if (c.tank.team === TEAM.RED) red++;
    }
    if (blue === red) return Math.random() < 0.5 ? TEAM.BLUE : TEAM.RED;
    return blue < red ? TEAM.BLUE : TEAM.RED;
  }

  spawnPoint(team) {
    const m = 400;
    if (this.mode === 'tdm') {
      // Teams spawn in opposite corners with scatter.
      const cx = team === TEAM.BLUE ? m * 2 : WORLD_SIZE - m * 2;
      const cy = team === TEAM.BLUE ? m * 2 : WORLD_SIZE - m * 2;
      return { x: clamp(cx + randRange(-500, 500), m, WORLD_SIZE - m), y: clamp(cy + randRange(-500, 500), m, WORLD_SIZE - m) };
    }
    if (this.mode === 'boss' && this.boss) {
      // Keep fresh fighters away from the boss's lap.
      for (let i = 0; i < 24; i++) {
        const p = { x: randRange(m, WORLD_SIZE - m), y: randRange(m, WORLD_SIZE - m) };
        if (Math.hypot(p.x - this.boss.x, p.y - this.boss.y) > 1500) return p;
      }
    }
    return { x: randRange(m, WORLD_SIZE - m), y: randRange(m, WORLD_SIZE - m) };
  }

  /** Assign (and lazily register) a style id for a build's appearance. */
  styleIdFor(build) {
    const key = buildKey(build);
    let id = this.styleIds.get(key);
    if (id !== undefined) return id;
    id = this.nextStyleId++;
    if (this.nextStyleId > 65000) this.nextStyleId = 1;
    this.styleIds.set(key, id);
    this.styleDefs.set(id, build);
    this.broadcastJSON({ t: 'style', id, build });
    return id;
  }

  spawnTank(client) {
    const team = client.tank ? client.tank.team : this.teamForNewPlayer();
    const p = this.spawnPoint(team);
    const tank = new Tank(p.x, p.y, team, client.name, client.build);
    tank.client = client;
    // Sandbox behaves like FFA: everyone is their own faction, so you can
    // actually test a build against something that shoots back.
    tank.faction = this.mode === 'tdm' ? FACTION_TDM + team
      : this.mode === 'boss' ? FACTION_BOSS_PLAYERS
      : tank.id;
    client.tank = tank;
    tank.styleId = this.styleIdFor(client.build);
    this.add(tank);
    // Anyone fighting an active boss is brought up to fighting weight, whether
    // they were here at the bell or wandered in halfway through.
    if (this.mode === 'boss' && this.roundState === 'active' && client !== this.bossClient) {
      this.buffChallenger(tank);
    }
    this.fx(FX.SPAWN, tank.x, tank.y, 0, Math.round(tank.r), tank.team);
    this.broadcastPlayers();
    return tank;
  }

  /** Level a boss-mode challenger up and auto-spend their skill points. */
  buffChallenger(tank) {
    tank.addXp(4200, this);
    for (let i = 0; tank.points > 0 && i < 64; i++) tank.upgrade(i % 8);
    tank.hp = tank.maxHp;
  }

  join(client) {
    this.clients.add(client);
    client.room = this;
    // Catch the newcomer up on every style already in play.
    for (const [id, build] of this.styleDefs) client.sendJSON({ t: 'style', id, build });
    this.spawnTank(client);
    client.sendJSON({ t: 'joined', room: this.id, mode: this.mode, world: WORLD_SIZE, tickRate: TICK_RATE });
    this.broadcastPlayers();
  }

  leave(client) {
    this.clients.delete(client);
    if (client.tank) {
      this.killProjectilesOf(client.tank);
      this.remove(client.tank);
      client.tank = null;
    }
    if (this.bossClient === client) {
      this.bossClient = null;
      if (this.boss) { this.remove(this.boss); this.boss = null; }
      this.endRound('The boss fled the arena.');
    }
    this.broadcastPlayers();
  }

  killProjectilesOf(tank) {
    for (const e of this.entities.values()) {
      if (isProjectile(e) && e.ownerId === tank.id) {
        // Drones die with their owner; fired shots live out their lifetime.
        if (e.type === ENT.DRONE) this.remove(e);
        else e.owner = null;
      }
    }
  }

  // ------------------------------------------------------------- broad phase

  rebuildGrid() {
    this.cells.clear();
    for (const e of this.entities.values()) {
      const cx = (e.x / CELL) | 0, cy = (e.y / CELL) | 0;
      const key = cy * GRID_W + cx;
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = []; this.cells.set(key, bucket); }
      bucket.push(e);
    }
  }

  /** Visit entities in the 3x3 cell block around `e`. */
  forEachNear(e, fn) {
    const cx = (e.x / CELL) | 0, cy = (e.y / CELL) | 0;
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = this.cells.get(gy * GRID_W + gx);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }

  /** Entities whose cells intersect an axis-aligned world box. */
  queryBox(x0, y0, x1, y1, out) {
    const gx0 = Math.max(0, (x0 / CELL) | 0), gx1 = Math.min(GRID_W - 1, (x1 / CELL) | 0);
    const gy0 = Math.max(0, (y0 / CELL) | 0), gy1 = Math.min(GRID_W - 1, (y1 / CELL) | 0);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const bucket = this.cells.get(gy * GRID_W + gx);
        if (bucket) for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  hostile(a, b) {
    return a.faction !== b.faction;
  }

  // ------------------------------------------------------------ narrow phase

  collideAll() {
    const dt = 1 / TICK_RATE;
    for (const a of this.entities.values()) {
      if (a.dead) continue;
      this.forEachNear(a, (b) => {
        // Order the pair so each is handled exactly once.
        if (b.id <= a.id || b.dead || a.dead) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 === 0) return;

        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        const hostile = this.hostile(a, b);
        const aP = isProjectile(a), bP = isProjectile(b);

        // A projectile never collides with its own launcher.
        if (aP && b.isTank && a.ownerId === b.id) return;
        if (bP && a.isTank && b.ownerId === a.id) return;

        if (hostile) {
          const hx = a.x + nx * a.r, hy = a.y + ny * a.r;
          if (aP && bP) {
            const ad = a.dmg, bd = b.dmg;
            a.damage(bd, b.owner, this);
            b.damage(ad, a.owner, this);
            this.fx(FX.HIT, hx, hy, Math.atan2(-ny, -nx), 6, a.team);
          } else if (aP || bP) {
            const proj = aP ? a : b;
            const target = aP ? b : a;
            target.damage(proj.dmg, proj.owner || proj, this);
            proj.damage(target.bodyDamage, target, this);
            this.fx(FX.HIT, hx, hy, Math.atan2(-ny, -nx), Math.min(255, Math.round(proj.r * 1.6)), proj.team);
          } else {
            // Body-to-body damage is expressed per second, not per tick.
            const ad = a.bodyDamage * dt, bd = b.bodyDamage * dt;
            a.damage(bd, b, this);
            b.damage(ad, a, this);
            if (this.tick % 6 === 0) this.fx(FX.HIT, hx, hy, Math.atan2(-ny, -nx), 10, a.team);
          }
        }

        if (a.dead || b.dead) return;

        // Projectiles never shove each other -- otherwise a multi-shot trap
        // barrel scatters its own volley off-axis the instant it spawns.
        if (aP && bP) return;

        // Tanks, shapes and parked traps are solid and push each other apart.
        // Bullets and drones only impart knockback -- they never block movement.
        const aSolid = !aP || a.type === ENT.TRAP;
        const bSolid = !bP || b.type === ENT.TRAP;
        const overlap = rr - d;
        if (aSolid && bSolid) {
          const total = a.mass + b.mass || 1;
          const push = overlap * 0.34;
          const aShare = (b.mass / total) * push, bShare = (a.mass / total) * push;
          a.vx -= nx * aShare * 0.5; a.vy -= ny * aShare * 0.5;
          b.vx += nx * bShare * 0.5; b.vy += ny * bShare * 0.5;
          a.x -= nx * aShare; a.y -= ny * aShare;
          b.x += nx * bShare; b.y += ny * bShare;
        } else if (aSolid !== bSolid) {
          const solid = aSolid ? a : b;
          const proj = aSolid ? b : a;
          const kb = Math.min(1.6, (proj.mass / (solid.mass || 1)) * 12);
          const sx = aSolid ? -nx : nx, sy = aSolid ? -ny : ny;
          solid.vx += sx * kb; solid.vy += sy * kb;
        }
      });
    }
  }

  // -------------------------------------------------------------- game loop

  update() {
    this.tick++;
    this.events.length = 0;
    this.dropStaleInput();

    for (const e of this.entities.values()) {
      if (!e.dead) e.update(this);
    }

    this.rebuildGrid();
    this.collideAll();

    for (const e of this.entities.values()) {
      if (e.dead) this.remove(e);
    }

    // Top the shape field back up a few at a time.
    if (this.shapeDeaths > 0) {
      const n = Math.min(this.shapeDeaths, 4);
      for (let i = 0; i < n; i++) this.spawnShape();
      this.shapeDeaths -= n;
    }

    this.updateMode();

    if (this.tick % 15 === 0) this.broadcastLeaderboard();
    if (this.tick % 6 === 0) this.sendSelfStats();
    this.sendSnapshots();
  }

  /**
   * A backgrounded tab stops sending input (browsers freeze rAF), and without
   * this the server would keep applying the last packet forever -- so a player
   * who alt-tabs mid-sprint drives into a wall and keeps firing. Idle clients
   * coast to a stop instead.
   */
  dropStaleInput() {
    const now = Date.now();
    for (const c of this.clients) {
      if (!c.tank || c.tank.dead) continue;
      if (c.lastInputAt && now - c.lastInputAt > 1000) {
        c.tank.keys = 0;
        c.tank.shooting = false;
        c.tank.autofire = false;
      }
    }
  }

  // ------------------------------------------------------------------ death

  onTankDeath(tank, source) {
    this.fx(FX.TANK_DEATH, tank.x, tank.y, tank.angle, Math.min(255, Math.round(tank.r)), tank.team);
    this.killProjectilesOf(tank);

    let killerName = 'the arena';
    const killer = this.tankOf(source);
    if (killer && killer !== tank) {
      killer.kills++;
      killer.score += Math.round(50 + tank.score * 0.35);
      killer.addXp(Math.round(40 + tank.level * 14), this);
      killerName = killer.name;
    }
    this.broadcastJSON({ t: 'kill', killer: killerName, victim: tank.name });

    const client = tank.client;
    if (client) {
      client.sendJSON({ t: 'dead', score: Math.round(tank.score), level: tank.level, kills: tank.kills, killer: killerName });
      client.tank = null;
      client.lastScore = Math.round(tank.score);
    }
    if (tank === this.boss) this.onBossDefeated(killerName);
    this.broadcastPlayers();
  }

  /** Walk a damage source back to the tank responsible, if any. */
  tankOf(source) {
    if (!source) return null;
    if (source.isTank) return source;
    if (source.ownerId) {
      const o = this.entities.get(source.ownerId);
      if (o && o.isTank) return o;
    }
    return null;
  }

  // ------------------------------------------------------------------ modes

  updateMode() {
    if (this.mode === 'boss') this.updateBossMode();
  }

  livingClients() {
    const out = [];
    for (const c of this.clients) if (c.tank && !c.tank.dead) out.push(c);
    return out;
  }

  updateBossMode() {
    if (this.roundState === 'waiting') {
      // Wait out the inter-round breather, then start once there is a boss
      // plus at least one challenger.
      if (this.nextRoundAt && this.tick < this.nextRoundAt) return;
      if (this.clients.size >= 2) this.ensureBoss();
      return;
    }
    if (this.roundState !== 'active' || !this.boss) return;

    this.roundTimer--;

    // The boss gets a periodic slam: a damaging shockwave with heavy VFX.
    if (this.tick % (TICK_RATE * 9) === 0) this.bossSlam();

    // No per-second progress broadcast here: the leaderboard packet already
    // carries the boss name, health and countdown twice a second.
    if (this.roundTimer <= 0) this.onBossSurvived();
  }

  bossSlam() {
    const b = this.boss;
    if (!b || b.dead) return;
    const radius = b.r * 6;
    this.fx(FX.BOSS_SLAM, b.x, b.y, 0, Math.min(255, Math.round(radius / 8)), b.team);
    for (const e of this.entities.values()) {
      if (e === b || e.dead || !this.hostile(b, e)) continue;
      const dx = e.x - b.x, dy = e.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d > radius || d === 0) continue;
      const falloff = 1 - d / radius;
      const kb = 22 * falloff;
      e.vx += (dx / d) * kb;
      e.vy += (dy / d) * kb;
      if (e.isTank) e.damage(30 * falloff, b, this);
    }
  }

  ensureBoss() {
    if (this.boss && !this.boss.dead) return;
    if (this.roundState === 'active') return;
    if (this.clients.size < 2) return;   // a boss needs someone to fight
    const candidates = [...this.clients].filter((c) => c !== this.bossClient);
    const pool = candidates.length ? candidates : [...this.clients];
    if (pool.length < 1) return;

    // Prefer whoever dealt the most damage last round; else pick at random.
    let chosen = null, best = -1;
    for (const c of pool) {
      const d = this.bossDamage.get(c) || 0;
      if (d > best) { best = d; chosen = c; }
    }
    if (best <= 0) chosen = pool[randInt(0, pool.length - 1)];
    this.startRound(chosen);
  }

  startRound(client) {
    this.bossDamage.clear();
    this.bossClient = client;
    if (client.tank) this.remove(client.tank);

    const p = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    const tank = new Tank(p.x, p.y, TEAM.BOSS, client.name, BOSS_BUILD);
    tank.client = client;
    tank.faction = FACTION_BOSS;
    tank.makeBoss(BOSS_BUILD, 4.2);
    tank.styleId = this.styleIdFor(BOSS_BUILD);
    client.tank = tank;
    this.add(tank);
    this.boss = tank;
    // Flip the round live *before* respawning challengers so spawnTank applies
    // the challenger buff to them.
    this.roundState = 'active';
    this.roundTimer = TICK_RATE * 180;   // three minutes to kill the boss

    for (const c of this.clients) {
      if (c === client) continue;
      if (c.tank) this.remove(c.tank);
      this.spawnTank(c);
    }
    this.fx(FX.BOSS_ROAR, tank.x, tank.y, 0, 200, tank.team);
    this.broadcastJSON({ t: 'round', state: 'start', bossName: client.name, seconds: 180 });
    this.broadcastPlayers();
  }

  onBossDefeated(killerName) {
    this.bossClient = null;
    this.boss = null;
    this.endRound(killerName + ' slew the boss!');
  }

  onBossSurvived() {
    const name = this.boss ? this.boss.name : 'The boss';
    if (this.boss && this.boss.client) this.boss.client.sendJSON({ t: 'bossWin' });
    if (this.boss) { this.remove(this.boss); this.boss = null; }
    if (this.bossClient) this.bossClient.tank = null;
    this.bossClient = null;
    this.endRound(name + ' survived and reigns!');
  }

  endRound(message) {
    this.roundState = 'waiting';
    this.roundTimer = 0;
    this.broadcastJSON({ t: 'round', state: 'end', message });
    // Short breather, then the next round rolls automatically.
    this.nextRoundAt = this.tick + TICK_RATE * 6;
  }

  /** Track who is hurting the boss, to pick next round's boss. */
  creditBossDamage(amount, source) {
    const t = this.tankOf(source);
    if (t && t.client) this.bossDamage.set(t.client, (this.bossDamage.get(t.client) || 0) + amount);
  }

  // -------------------------------------------------------------- networking

  broadcastJSON(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) c.sendRaw(s);
  }

  broadcastPlayers() {
    const players = [];
    for (const c of this.clients) {
      if (!c.tank) continue;
      players.push({ id: c.tank.id, name: c.name, team: c.tank.team, boss: c.tank.isBoss });
    }
    this.broadcastJSON({ t: 'players', players });
  }

  broadcastLeaderboard() {
    const rows = [];
    for (const c of this.clients) {
      if (!c.tank) continue;
      rows.push({
        id: c.tank.id, name: c.name, score: Math.round(c.tank.score),
        level: c.tank.level, team: c.tank.team, boss: c.tank.isBoss,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    const payload = { t: 'lb', rows: rows.slice(0, 10), players: this.clients.size, mode: this.mode };
    if (this.mode === 'tdm') {
      let blue = 0, red = 0;
      for (const r of rows) { if (r.team === TEAM.BLUE) blue += r.score; else if (r.team === TEAM.RED) red += r.score; }
      payload.teamScores = { blue, red };
    }
    if (this.mode === 'boss' && this.boss) {
      payload.boss = { name: this.boss.name, hp: this.boss.hpRatio, secondsLeft: Math.ceil(this.roundTimer / TICK_RATE) };
    }
    this.broadcastJSON(payload);
  }

  /** Per-player HUD state: level, xp, score and unspent skill points. */
  sendSelfStats() {
    for (const c of this.clients) {
      const t = c.tank;
      if (!t || t.dead) continue;
      c.sendJSON({
        t: 'self',
        level: t.level,
        xp: Math.round(t.xp),
        nextXp: t.nextXp === Infinity ? 0 : Math.round(t.nextXp),
        score: Math.round(t.score),
        points: t.points,
        stats: t.stats,
        hp: t.hpRatio,
        boss: t.isBoss,
      });
    }
  }

  sendSnapshots() {
    const scratch = [];
    for (const c of this.clients) {
      if (c.ws.bufferedAmount > 262144) continue;   // client is drowning; skip a frame

      const tank = c.tank;
      const cx = tank ? tank.x : c.camX || WORLD_SIZE / 2;
      const cy = tank ? tank.y : c.camY || WORLD_SIZE / 2;
      c.camX = cx; c.camY = cy;

      const halfW = c.viewW * 0.5 + 220;
      const halfH = c.viewH * 0.5 + 220;
      scratch.length = 0;
      this.queryBox(cx - halfW, cy - halfH, cx + halfW, cy + halfH, scratch);

      const ents = [];
      for (let i = 0; i < scratch.length; i++) {
        const e = scratch[i];
        if (e.dead) continue;
        if (Math.abs(e.x - cx) > halfW + e.r || Math.abs(e.y - cy) > halfH + e.r) continue;
        let flags = e.flags();
        if (tank && e.id === tank.id) flags |= EF.SELF;
        // Mark what can hurt *this* viewer, so the client can colour friend and
        // foe correctly even in FFA where everyone shares one team colour.
        if (tank && e.type !== ENT.SHAPE && e.faction !== tank.faction) flags |= EF.HOSTILE;
        ents.push({
          id: e.id, type: e.type, flags,
          x: e.x, y: e.y, angle: e.angle, radius: e.r,
          team: e.team, hpRatio: e.hpRatio, styleId: e.styleId,
          aux: e.isTank ? Math.min(255, e.level) : e.aux,
        });
        if (ents.length >= 900) break;
      }

      // Only ship VFX the player could actually see.
      const evs = [];
      for (let i = 0; i < this.events.length; i++) {
        const ev = this.events[i];
        const big = ev.kind === FX.BOSS_ROAR || ev.kind === FX.BOSS_SLAM;
        if (big || (Math.abs(ev.x - cx) < halfW + 400 && Math.abs(ev.y - cy) < halfH + 400)) evs.push(ev);
      }

      c.sendBinary(writeSnapshot(this.tick, tank ? tank.id : 0, ents, evs));
    }
  }
}
