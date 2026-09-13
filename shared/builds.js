// Turret build schema, costing and validation.
//
// A build is plain data. The builder UI edits it, the client sends it on join,
// and the server re-validates it with THIS SAME CODE before accepting. Never
// trust the client's own cost arithmetic — only `validateBuild`'s verdict.

import { clamp } from './math.js';

export const BUDGET = 120;        // build points every player gets
export const MAX_TURRETS = 10;
export const MAX_BOSS_TURRETS = 16;

export const BODY_SHAPES = ['circle', 'square', 'triangle', 'pentagon', 'hexagon'];
export const TURRET_SHAPES = ['rect', 'trap', 'trapInv', 'bulge'];
export const TURRET_TYPES = ['bullet', 'drone', 'trap'];

/** Per-field bounds. Anything outside is clamped, not rejected. */
export const FIELDS = {
  offset:  { min: -28,  max: 28,  step: 1,    def: 0,    label: 'Offset',       help: 'Sideways shift from centre' },
  forward: { min: -10,  max: 26,  step: 1,    def: 0,    label: 'Forward',      help: 'Push the turret out of the hull' },
  angle:   { min: -180, max: 180, step: 1,    def: 0,    label: 'Angle',        help: 'Direction in degrees' },
  width:   { min: 8,    max: 34,  step: 1,    def: 18,   label: 'Width',        help: 'Barrel thickness' },
  length:  { min: 20,   max: 75,  step: 1,    def: 42,   label: 'Length',       help: 'Barrel length' },
  damage:  { min: 2,    max: 26,  step: 0.5,  def: 7,    label: 'Damage',       help: 'Damage per projectile' },
  reload:  { min: 0.12, max: 2.5, step: 0.02, def: 0.6,  label: 'Reload',       help: 'Seconds between shots' },
  speed:   { min: 4,    max: 22,  step: 0.5,  def: 13,   label: 'Bullet Speed', help: 'Muzzle velocity' },
  spread:  { min: 0,    max: 40,  step: 1,    def: 0,    label: 'Spread',       help: 'Random cone in degrees' },
  count:   { min: 1,    max: 6,   step: 1,    def: 1,    label: 'Count',        help: 'Projectiles per shot' },
  size:    { min: 0.5,  max: 2.2, step: 0.05, def: 1,    label: 'Bullet Size',  help: 'Projectile scale' },
  pen:     { min: 1,    max: 18,  step: 0.5,  def: 5,    label: 'Penetration',  help: 'Projectile health' },
  recoil:  { min: 0,    max: 6,   step: 0.25, def: 1,    label: 'Recoil',       help: 'Knockback on yourself' },
  life:    { min: 0.4,  max: 6,   step: 0.1,  def: 1.8,  label: 'Range',        help: 'Projectile lifetime (s)' },
};

const TYPE_MULT = {
  bullet: { cost: 1.0,  hp: 1.0, label: 'Bullet' },
  drone:  { cost: 1.35, hp: 1.6, label: 'Drone'  },
  trap:   { cost: 1.15, hp: 1.9, label: 'Trap'   },
};

export function defaultTurret(over = {}) {
  const t = {};
  for (const [k, f] of Object.entries(FIELDS)) t[k] = f.def;
  t.shape = 'rect';
  t.type = 'bullet';
  return Object.assign(t, over);
}

/**
 * Cost of a single turret. Deliberately dominated by sustained DPS so that
 * "fast + huge damage + many barrels" is unaffordable, while glass-cannon and
 * swarm builds stay viable at different points on the curve.
 */
export function turretCost(t) {
  const dps = (t.damage * t.count) / Math.max(0.12, t.reload);
  let c = 0;
  c += dps * 1.25;                       // sustained damage dominates
  c += t.count * 2.2;                    // extra barrels cost on their own
  c += Math.max(0, t.speed - 8) * 0.7;   // fast shots
  c += Math.max(0, t.pen - 4) * 1.1;     // tanky shots
  c += Math.max(0, t.size - 1) * 8;      // big shots
  c += Math.max(0, t.life - 1.8) * 2.4;  // long range
  c += (t.width / 18) * 1.5 + (t.length / 42) * 1.5;
  c -= t.spread * 0.22;                  // inaccuracy is a discount
  c -= t.recoil * 0.8;                   // self-knockback is a discount
  c *= TYPE_MULT[t.type] ? TYPE_MULT[t.type].cost : 1;
  return Math.max(1, c);
}

export function buildCost(build) {
  return (build.turrets || []).reduce((s, t) => s + turretCost(t), 0);
}

/** Coerce one turret into a legal, fully-populated object. */
export function sanitizeTurret(raw) {
  const t = defaultTurret();
  if (!raw || typeof raw !== 'object') return t;
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = Number(raw[k]);
    t[k] = Number.isFinite(v) ? clamp(v, f.min, f.max) : f.def;
  }
  t.shape = TURRET_SHAPES.includes(raw.shape) ? raw.shape : 'rect';
  t.type = TURRET_TYPES.includes(raw.type) ? raw.type : 'bullet';
  // Drones are persistent, so `count` means "max alive" and reload means
  // respawn delay. Keep swarms small enough to simulate and draw cheaply.
  if (t.type === 'drone') t.count = clamp(Math.round(t.count), 1, 4);
  else t.count = clamp(Math.round(t.count), 1, FIELDS.count.max);
  return t;
}

/**
 * Full validation. Always returns a usable build — bad input degrades to the
 * starter build rather than throwing, and over-budget builds are flagged so the
 * caller can reject them.
 * @returns {{build: object, cost: number, ok: boolean, reason: string}}
 */
export function validateBuild(raw, opts = {}) {
  const budget = opts.budget === undefined ? BUDGET : opts.budget;
  const maxTurrets = opts.maxTurrets === undefined ? MAX_TURRETS : opts.maxTurrets;

  if (!raw || typeof raw !== 'object') {
    const fallback = STARTER_BUILDS[0].build;
    return { build: fallback, cost: buildCost(fallback), ok: false, reason: 'malformed build' };
  }

  const out = { name: 'Custom', body: 'circle', turrets: [] };
  out.name = String(raw.name || 'Custom').slice(0, 20);
  out.body = BODY_SHAPES.includes(raw.body) ? raw.body : 'circle';

  const list = Array.isArray(raw.turrets) ? raw.turrets.slice(0, maxTurrets) : [];
  out.turrets = list.map(sanitizeTurret);
  if (out.turrets.length === 0) out.turrets = [defaultTurret()];

  const cost = buildCost(out);
  if (cost > budget + 0.5) {
    return { build: out, cost, ok: false, reason: 'build costs ' + cost.toFixed(1) + ' of ' + budget + ' points' };
  }
  return { build: out, cost, ok: true, reason: '' };
}

/** Stable key for a build's *appearance*, used to dedupe style broadcasts. */
export function buildKey(build) {
  return JSON.stringify([
    build.body,
    build.turrets.map((t) => [t.offset, t.forward, t.angle, t.width, t.length, t.shape, t.type, t.size]),
  ]);
}

const T = defaultTurret;

/** Preset builds offered in the builder as starting points. */
export const STARTER_BUILDS = [
  {
    id: 'basic', label: 'Basic', desc: 'One honest barrel. Balanced and forgiving.',
    build: { name: 'Basic', body: 'circle', turrets: [T({ damage: 8, reload: 0.55, speed: 14, pen: 6 })] },
  },
  {
    id: 'twin', label: 'Twin', desc: 'Two offset barrels. Higher uptime, less punch.',
    build: {
      name: 'Twin', body: 'circle',
      turrets: [
        T({ offset: -10, damage: 5, reload: 0.45, speed: 14, pen: 4 }),
        T({ offset: 10, damage: 5, reload: 0.45, speed: 14, pen: 4 }),
      ],
    },
  },
  {
    id: 'sniper', label: 'Sniper', desc: 'Long barrel, slow fire, hits like a truck.',
    build: {
      name: 'Sniper', body: 'circle',
      turrets: [T({ width: 22, length: 70, damage: 20, reload: 1.35, speed: 21, pen: 9, life: 3.2, recoil: 2 })],
    },
  },
  {
    id: 'scatter', label: 'Scatter', desc: 'Five-pellet cone. Brutal close, useless far.',
    build: {
      name: 'Scatter', body: 'circle',
      turrets: [T({ width: 28, length: 34, damage: 4, reload: 0.85, speed: 12, spread: 22, count: 5, pen: 3, life: 0.9, recoil: 3 })],
    },
  },
  {
    id: 'swarm', label: 'Swarm', desc: 'Drones that chase your cursor and come home.',
    build: {
      name: 'Swarm', body: 'hexagon',
      turrets: [
        T({ offset: -12, angle: -25, shape: 'trapInv', type: 'drone', count: 3, damage: 6, reload: 1.1, speed: 9, pen: 5, life: 6 }),
        T({ offset: 12, angle: 25, shape: 'trapInv', type: 'drone', count: 3, damage: 6, reload: 1.1, speed: 9, pen: 5, life: 6 }),
      ],
    },
  },
  {
    id: 'fortress', label: 'Fortress', desc: 'Traps in front, peashooter behind.',
    build: {
      name: 'Fortress', body: 'pentagon',
      turrets: [
        T({ shape: 'trap', type: 'trap', width: 26, length: 30, damage: 9, reload: 0.7, speed: 10, pen: 12, life: 6, count: 2, spread: 12 }),
        T({ angle: 180, width: 16, length: 38, damage: 4, reload: 0.6, speed: 12, pen: 3 }),
      ],
    },
  },
  {
    id: 'spinner', label: 'Spinner', desc: 'Four-way. Pair it with auto-spin (R).',
    build: {
      name: 'Spinner', body: 'square',
      turrets: [
        T({ angle: 0, damage: 4, reload: 0.5, speed: 12, pen: 3, width: 15 }),
        T({ angle: 90, damage: 4, reload: 0.5, speed: 12, pen: 3, width: 15 }),
        T({ angle: 180, damage: 4, reload: 0.5, speed: 12, pen: 3, width: 15 }),
        T({ angle: -90, damage: 4, reload: 0.5, speed: 12, pen: 3, width: 15 }),
      ],
    },
  },
];

/** The build handed to whoever is picked as boss. Far above the normal budget. */
export const BOSS_BUILD = {
  name: 'The Devourer', body: 'hexagon',
  turrets: [
    T({ angle: 0,    width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: 60,   width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: 120,  width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: 180,  width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: -120, width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: -60,  width: 30, length: 62, damage: 15, reload: 0.45, speed: 15, pen: 12, size: 1.5, life: 3 }),
    T({ angle: 30,   width: 22, length: 46, shape: 'trapInv', type: 'drone', count: 4, damage: 10, reload: 1.0, speed: 10, pen: 8, life: 6 }),
    T({ angle: -30,  width: 22, length: 46, shape: 'trapInv', type: 'drone', count: 4, damage: 10, reload: 1.0, speed: 10, pen: 8, life: 6 }),
    T({ angle: 150,  width: 22, length: 46, shape: 'trapInv', type: 'drone', count: 4, damage: 10, reload: 1.0, speed: 10, pen: 8, life: 6 }),
    T({ angle: -150, width: 22, length: 46, shape: 'trapInv', type: 'drone', count: 4, damage: 10, reload: 1.0, speed: 10, pen: 8, life: 6 }),
  ],
};
