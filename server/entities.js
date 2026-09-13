// Authoritative entity simulation. Everything here runs server-side only; the
// client re-implements just enough of the tank movement for local prediction.

import { TAU, clamp, randRange } from '../shared/math.js';
import {
  TICK_RATE, WORLD_SIZE, ENT, PROJ, SHAPE_DEFS, STAT_COUNT, STAT_MAX,
  MAX_LEVEL, TEAM, FRICTION, BASE_ACCEL, TANK_BASE_RADIUS, FX,
  MAX_PROJECTILES_PER_TANK, ROOM_ENTITY_CAP,
} from '../shared/constants.js';
import { KEY, EF } from '../shared/protocol.js';

let nextId = 1;
export function allocId() {
  // Ids ride the wire as u16, so wrap and skip 0 (reserved for "none").
  nextId = (nextId + 1) & 0xffff;
  if (nextId === 0) nextId = 1;
  return nextId;
}

// ------------------------------------------------------------ stat formulas

export function xpForLevel(level) {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.floor(6 * Math.pow(level, 1.55) + 4);
}

/** Skill points granted on reaching `level`. */
export function pointsForLevel(level) {
  if (level <= 1) return 0;
  if (level <= 28) return 1;
  return level % 3 === 0 ? 1 : 0;
}

export function derivedStats(s, level) {
  const maxHp = 50 + (level - 1) * 2 + s[1] * 22;
  return {
    maxHp,
    regen: maxHp * (0.0035 + s[0] * 0.011),   // hp per second
    bodyDamage: 20 + s[2] * 7,
    bulletSpeed: 1 + s[3] * 0.07,
    bulletPen: 1 + s[4] * 0.16,
    bulletDamage: 1 + s[5] * 0.22,
    reload: 1 / (1 + s[6] * 0.11),
    moveAccel: BASE_ACCEL * (1 + s[7] * 0.13),
  };
}

export function tankRadius(level, bossScale) {
  return (TANK_BASE_RADIUS + (level - 1) * 0.38) * (bossScale || 1);
}

// ------------------------------------------------------------- base entity

export class Entity {
  constructor(x, y, r, team) {
    this.id = allocId();
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.r = r;
    this.angle = 0;
    this.team = team;
    this.dead = false;
    this.hp = 1; this.maxHp = 1;
    this.hurtTimer = 0;
    this.mass = r * r;
    this.type = ENT.SHAPE;
    this.styleId = 0;
    this.aux = 0;
  }

  get hpRatio() { return this.maxHp > 0 ? clamp(this.hp / this.maxHp, 0, 1) : 0; }

  damage(amount, source, room) {
    if (this.dead || amount <= 0) return;
    this.hp -= amount;
    this.hurtTimer = 3;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.onDeath(source, room);
    }
  }

  onDeath() {}

  /** Hook invoked once when the room drops this entity from the world. */
  onRemove() {}

  integrate() {
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= FRICTION;
    this.vy *= FRICTION;
  }

  clampToWorld(bounce) {
    const r = this.r;
    if (this.x < r) { this.x = r; if (bounce) this.vx = Math.abs(this.vx) * 0.5; else this.vx = 0; }
    if (this.y < r) { this.y = r; if (bounce) this.vy = Math.abs(this.vy) * 0.5; else this.vy = 0; }
    if (this.x > WORLD_SIZE - r) { this.x = WORLD_SIZE - r; if (bounce) this.vx = -Math.abs(this.vx) * 0.5; else this.vx = 0; }
    if (this.y > WORLD_SIZE - r) { this.y = WORLD_SIZE - r; if (bounce) this.vy = -Math.abs(this.vy) * 0.5; else this.vy = 0; }
  }

  flags() {
    return this.hurtTimer > 0 ? EF.HURT : 0;
  }
}

// ------------------------------------------------------------------ shapes

export class Shape extends Entity {
  constructor(kind, x, y) {
    const def = SHAPE_DEFS[kind];
    super(x, y, def.radius, TEAM.SHAPES);
    this.type = ENT.SHAPE;
    this.kind = kind;
    this.styleId = kind;
    this.maxHp = def.hp;
    this.hp = def.hp;
    this.bodyDamage = def.body;
    this.xp = def.xp;
    this.score = def.score;
    this.angle = Math.random() * TAU;
    this.spin = randRange(-0.02, 0.02);
    this.mass = def.radius * def.radius;
    this.drift = Math.random() * TAU;
  }

  update(room) {
    this.angle += this.spin;
    // Gentle brownian drift so the field never looks frozen.
    this.drift += randRange(-0.08, 0.08);
    this.vx += Math.cos(this.drift) * 0.03;
    this.vy += Math.sin(this.drift) * 0.03;
    this.integrate();
    this.clampToWorld(true);
    if (this.hurtTimer > 0) this.hurtTimer--;
  }

  onDeath(source, room) {
    room.fx(FX.SHAPE_DEATH, this.x, this.y, this.angle, this.kind, 0);
    if (source && source.isTank && !source.dead) {
      source.addXp(this.xp, room);
      source.score += this.score;
    }
    room.shapeDeaths++;
  }
}

// ------------------------------------------------------------- projectiles

export class Projectile extends Entity {
  constructor(owner, barrel, kind, x, y, dir, stats, room) {
    const size = barrel.width * 0.45 * barrel.size;
    super(x, y, Math.max(4, size), owner.team);
    this.type = kind === PROJ.DRONE ? ENT.DRONE : kind === PROJ.TRAP ? ENT.TRAP : ENT.BULLET;
    this.kind = kind;
    this.styleId = kind;
    this.ownerId = owner.id;
    this.owner = owner;
    // Inherit the launcher's faction, otherwise "who may hurt whom" is
    // undefined for projectiles and teammates shoot each other.
    this.faction = owner.faction;
    this.barrel = barrel;
    this.angle = dir;

    const speed = barrel.speed * stats.bulletSpeed;
    this.vx = Math.cos(dir) * speed;
    this.vy = Math.sin(dir) * speed;
    this.speed = speed;

    this.dmg = barrel.damage * stats.bulletDamage;
    this.bodyDamage = this.dmg;
    this.maxHp = Math.max(1, barrel.pen * stats.bulletPen * (kind === PROJ.DRONE ? 1.6 : kind === PROJ.TRAP ? 1.9 : 1));
    this.hp = this.maxHp;
    this.life = Math.round(barrel.life * TICK_RATE);
    this.mass = this.r * this.r * 0.6;
    this.aux = Math.min(255, Math.round(this.r));
    // Traps fly straight for a beat before parking, so they can be *placed*
    // rather than dropped on your own feet.
    this.coast = kind === PROJ.TRAP ? 20 : 0;
  }

  update(room) {
    if (--this.life <= 0) {
      this.dead = true;
      room.fx(FX.EXPLODE, this.x, this.y, this.angle, Math.min(255, Math.round(this.r)), this.team);
      return;
    }
    if (this.hurtTimer > 0) this.hurtTimer--;

    if (this.kind === PROJ.DRONE) {
      this.steer(room);
    } else if (this.kind === PROJ.TRAP) {
      // Coast, then brake hard and sit as a minefield until the timer runs out.
      if (this.coast > 0) this.coast--;
      else { this.vx *= 0.86; this.vy *= 0.86; }
      this.angle += 0.06;
    } else {
      this.angle = Math.atan2(this.vy, this.vx);
    }

    this.x += this.vx;
    this.y += this.vy;

    // Projectiles die on the wall instead of bouncing, except traps which rest.
    if (this.x < 0 || this.y < 0 || this.x > WORLD_SIZE || this.y > WORLD_SIZE) {
      if (this.kind === PROJ.TRAP) {
        this.clampToWorld(false);
      } else {
        this.dead = true;
        room.fx(FX.EXPLODE, this.x, this.y, this.angle, Math.min(255, Math.round(this.r)), this.team);
      }
    }
  }

  /** Drones chase the owner's cursor, then loiter around the owner. */
  steer(room) {
    const o = this.owner;
    if (!o || o.dead) { this.dead = true; return; }
    let tx = o.aimX, ty = o.aimY;
    if (!o.shooting && !o.autofire) {
      // Idle: orbit the owner rather than sitting on top of them.
      const t = room.tick * 0.02 + this.id;
      tx = o.x + Math.cos(t) * 190;
      ty = o.y + Math.sin(t) * 190;
    }
    const dx = tx - this.x, dy = ty - this.y;
    const d = Math.hypot(dx, dy) || 1;
    const accel = this.speed * 0.12;
    this.vx += (dx / d) * accel;
    this.vy += (dy / d) * accel;
    const sp = Math.hypot(this.vx, this.vy);
    const max = this.speed;
    if (sp > max) { this.vx = (this.vx / sp) * max; this.vy = (this.vy / sp) * max; }
    this.angle = Math.atan2(this.vy, this.vx);
  }

  onDeath(source, room) {
    room.fx(FX.EXPLODE, this.x, this.y, this.angle, Math.min(255, Math.round(this.r)), this.team);
  }

  /**
   * Called by the room for every removal path (damage, lifetime, owner death),
   * so a barrel's drone budget is always returned exactly once.
   */
  onRemove() {
    const o = this.owner;
    if (!o) return;
    if (o.liveProjectiles !== undefined) o.liveProjectiles = Math.max(0, o.liveProjectiles - 1);
    if (this.kind === PROJ.DRONE && o.droneCount) {
      const i = this.barrelIdx;
      o.droneCount[i] = Math.max(0, (o.droneCount[i] || 1) - 1);
    }
  }
}

// ------------------------------------------------------------------- tanks

export class Tank extends Entity {
  constructor(x, y, team, name, build) {
    super(x, y, TANK_BASE_RADIUS, team);
    this.type = ENT.TANK;
    this.isTank = true;
    this.name = name;
    this.level = 1;
    this.xp = 0;
    this.nextXp = xpForLevel(1);
    this.score = 0;
    this.kills = 0;
    this.points = 0;
    this.stats = new Array(STAT_COUNT).fill(0);
    this.isBoss = false;
    this.bossScale = 1;

    this.keys = 0;
    this.shooting = false;
    this.autofire = false;
    this.autospin = false;
    this.aimAngle = 0;
    this.aimX = x + 100;
    this.aimY = y;
    this.spinAngle = 0;

    this.invuln = TICK_RATE * 2;   // spawn protection
    this.regenDelay = 0;
    this.droneCount = [];
    this.liveProjectiles = 0;      // budget enforced in fireBarrels
    this.setBuild(build);
    this.recompute();
    this.hp = this.maxHp;
  }

  setBuild(build) {
    this.build = build;
    this.barrels = build.turrets.map((t) => ({
      def: t,
      angle: (t.angle * Math.PI) / 180,
      offset: t.offset,
      forward: t.forward,
      length: t.length,
      width: t.width,
      size: t.size,
      damage: t.damage,
      reload: t.reload,
      speed: t.speed,
      spread: (t.spread * Math.PI) / 180,
      count: t.count,
      pen: t.pen,
      recoil: t.recoil,
      life: t.life,
      type: t.type,
      timer: Math.random() * 4,
      flash: 0,
    }));
    this.droneCount = new Array(this.barrels.length).fill(0);
  }

  recompute() {
    const d = derivedStats(this.stats, this.level);
    const prevMax = this.maxHp;
    this.maxHp = d.maxHp * (this.isBoss ? 26 : 1);
    if (prevMax > 0 && this.maxHp !== prevMax) {
      this.hp = Math.min(this.maxHp, this.hp + (this.maxHp - prevMax)); // upgrades heal
    }
    this.derived = d;
    this.bodyDamage = d.bodyDamage * (this.isBoss ? 3 : 1);
    this.r = tankRadius(this.level, this.bossScale);
    this.mass = this.r * this.r;
  }

  makeBoss(build, scale) {
    this.isBoss = true;
    this.bossScale = scale;
    this.setBuild(build);
    this.level = MAX_LEVEL;
    // Boss comes fully specced rather than farming its way up.
    this.stats = this.stats.map(() => STAT_MAX);
    this.points = 0;
    this.recompute();
    this.hp = this.maxHp;
  }

  addXp(amount, room) {
    if (this.level >= MAX_LEVEL) { this.score += amount * 0.2; return; }
    this.xp += amount;
    while (this.level < MAX_LEVEL && this.xp >= this.nextXp) {
      this.xp -= this.nextXp;
      this.level++;
      this.points += pointsForLevel(this.level);
      this.nextXp = xpForLevel(this.level);
      this.recompute();
      this.hp = this.maxHp;              // full heal on level up
      if (room) room.fx(FX.LEVEL_UP, this.x, this.y, 0, Math.min(255, this.level), this.team);
    }
  }

  upgrade(index) {
    if (index < 0 || index >= STAT_COUNT) return false;
    if (this.points <= 0 || this.stats[index] >= STAT_MAX) return false;
    this.stats[index]++;
    this.points--;
    this.recompute();
    return true;
  }

  applyInput(inp) {
    this.keys = inp.keys;
    this.shooting = (inp.keys & KEY.SHOOT) !== 0;
    this.autofire = (inp.keys & KEY.AUTOFIRE) !== 0;
    this.autospin = (inp.keys & KEY.AUTOSPIN) !== 0;
    this.aimAngle = inp.aimAngle;
    const dist = Math.min(inp.aimDist, 4000);
    this.aimX = this.x + Math.cos(inp.aimAngle) * dist;
    this.aimY = this.y + Math.sin(inp.aimAngle) * dist;
  }

  update(room) {
    const dt = 1 / TICK_RATE;
    if (this.invuln > 0) this.invuln--;
    if (this.hurtTimer > 0) this.hurtTimer--;

    // Movement from WASD, normalised so diagonals aren't faster.
    let dx = 0, dy = 0;
    if (this.keys & KEY.LEFT) dx -= 1;
    if (this.keys & KEY.RIGHT) dx += 1;
    if (this.keys & KEY.UP) dy -= 1;
    if (this.keys & KEY.DOWN) dy += 1;
    if (dx || dy) {
      const m = Math.hypot(dx, dy);
      const a = this.derived.moveAccel * (this.isBoss ? 0.62 : 1);
      this.vx += (dx / m) * a;
      this.vy += (dy / m) * a;
    }

    this.integrate();
    this.clampToWorld(false);

    // Facing: auto-spin overrides the cursor.
    if (this.autospin) {
      this.spinAngle += 0.07;
      this.angle = this.spinAngle;
    } else {
      this.angle = this.aimAngle;
      this.spinAngle = this.angle;
    }

    // Regeneration ramps up after a few seconds without taking a hit.
    if (this.regenDelay > 0) this.regenDelay--;
    if (this.hp < this.maxHp) {
      const boost = this.regenDelay <= 0 ? 3.2 : 1;
      this.hp = Math.min(this.maxHp, this.hp + this.derived.regen * dt * boost);
      if (this.regenDelay <= 0 && room.tick % 20 === 0) {
        room.fx(FX.HEAL, this.x, this.y, 0, Math.round(this.r), this.team);
      }
    }

    this.fireBarrels(room);
  }

  /** World-space muzzle point and direction for a barrel. */
  barrelMuzzle(b) {
    const dir = this.angle + b.angle;
    const scale = this.r / TANK_BASE_RADIUS;
    const cos = Math.cos(dir), sin = Math.sin(dir);
    // Offset is perpendicular to the barrel; forward pushes it along the barrel.
    const bx = this.x + -sin * b.offset * scale + cos * b.forward * scale;
    const by = this.y + cos * b.offset * scale + sin * b.forward * scale;
    return { dir, x: bx + cos * b.length * scale, y: by + sin * b.length * scale, scale };
  }

  fireBarrels(room) {
    const wantsFire = this.shooting || this.autofire;
    for (let i = 0; i < this.barrels.length; i++) {
      const b = this.barrels[i];
      if (b.timer > 0) b.timer--;
      if (b.flash > 0) b.flash--;

      const isDrone = b.type === 'drone';
      if (!isDrone && !wantsFire) continue;
      if (isDrone && this.droneCount[i] >= b.count) continue;
      if (b.timer > 0) continue;

      const reloadTicks = Math.max(2, Math.round(b.reload * this.derived.reload * TICK_RATE));
      b.timer = reloadTicks;
      b.flash = 4;

      // Clamp the volley to what the tank and the room can still afford. This
      // is what makes a 48-barrel cheat build merely silly rather than fatal.
      const tankBudget = MAX_PROJECTILES_PER_TANK - this.liveProjectiles;
      const roomBudget = ROOM_ENTITY_CAP - room.entities.size;
      const affordable = Math.min(tankBudget, roomBudget);
      if (affordable <= 0) continue;

      const shots = Math.min(isDrone ? 1 : b.count, affordable);
      const m = this.barrelMuzzle(b);
      for (let s = 0; s < shots; s++) {
        const jitter = b.spread ? randRange(-b.spread / 2, b.spread / 2) : 0;
        const kind = isDrone ? PROJ.DRONE : b.type === 'trap' ? PROJ.TRAP : PROJ.BULLET;
        const p = new Projectile(this, b, kind, m.x, m.y, m.dir + jitter, this.derived, room);
        p.r *= m.scale;
        p.barrelIdx = i;
        room.add(p);
        this.liveProjectiles++;
        if (isDrone) this.droneCount[i] = (this.droneCount[i] || 0) + 1;
      }

      // Recoil pushes the hull opposite the shot; a real build tradeoff.
      const rec = b.recoil * 0.28 * (this.isBoss ? 0.2 : 1);
      this.vx -= Math.cos(m.dir) * rec;
      this.vy -= Math.sin(m.dir) * rec;

      room.fx(FX.FIRE, m.x, m.y, m.dir, Math.min(255, Math.round(b.width * m.size * m.scale)), this.team);
    }
  }

  damage(amount, source, room) {
    if (this.invuln > 0 || this.dead) return;
    this.regenDelay = TICK_RATE * 4;
    // Boss-mode picks the next boss from whoever hurt this one the most.
    if (this.isBoss && room && room.creditBossDamage) {
      room.creditBossDamage(Math.min(amount, this.hp), source);
    }
    super.damage(amount, source, room);
  }

  onDeath(source, room) {
    room.onTankDeath(this, source);
  }

  flags() {
    let f = 0;
    if (this.hurtTimer > 0) f |= EF.HURT;
    if (this.isBoss) f |= EF.BOSS;
    if (this.invuln > 0) f |= EF.INVULN;
    if (this.autospin) f |= EF.AUTOSPIN;
    return f;
  }
}
