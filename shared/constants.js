// Shared tuning constants. Imported by both the authoritative server and the
// browser client, so both sides agree on units without a build step.

export const TICK_RATE = 30;           // simulation ticks per second
export const MS_PER_TICK = 1000 / TICK_RATE;
export const WORLD_SIZE = 9000;        // square arena, coords live in [0, WORLD_SIZE]
export const GRID_STEP = 60;           // background grid spacing (visual only)

// Entity type tags, wire-encoded as a u8.
export const ENT = {
  TANK: 0,
  BULLET: 1,
  DRONE: 2,
  TRAP: 3,
  SHAPE: 4,
};

// Projectile visual kinds, wire-encoded in the styleId field.
export const PROJ = {
  BULLET: 0,
  DRONE: 1,
  TRAP: 2,
};

// Destructible farm shapes.
export const SHAPE = {
  SQUARE: 0,
  TRIANGLE: 1,
  PENTAGON: 2,
  ALPHA: 3,
};

export const SHAPE_DEFS = [
  { name: 'Square',         sides: 4, radius: 22, hp: 12,   body: 8,  xp: 12,   score: 12,   color: '#ffe869' },
  { name: 'Triangle',       sides: 3, radius: 26, hp: 32,   body: 10, xp: 30,   score: 30,   color: '#fc7676' },
  { name: 'Pentagon',       sides: 5, radius: 38, hp: 120,  body: 14, xp: 140,  score: 140,  color: '#768cfc' },
  { name: 'Alpha Pentagon', sides: 5, radius: 96, hp: 2400, body: 26, xp: 3200, score: 3200, color: '#7ee0a8' },
];

// The eight upgradable stats, in UI order.
export const STATS = [
  { key: 'regen',   name: 'Health Regen',  color: '#c364e0' },
  { key: 'health',  name: 'Max Health',    color: '#e06c64' },
  { key: 'body',    name: 'Body Damage',   color: '#e0a864' },
  { key: 'bspeed',  name: 'Bullet Speed',  color: '#64c8e0' },
  { key: 'bpen',    name: 'Bullet Pen',    color: '#8ee064' },
  { key: 'bdamage', name: 'Bullet Damage', color: '#e06464' },
  { key: 'reload',  name: 'Reload',        color: '#64e0a8' },
  { key: 'mspeed',  name: 'Move Speed',    color: '#6478e0' },
];
export const STAT_COUNT = STATS.length;
export const STAT_MAX = 7;              // per-stat cap
export const MAX_LEVEL = 45;

// Team ids. FFA players all sit on TEAM_NONE and simply damage everyone.
export const TEAM = { NONE: 0, BLUE: 1, RED: 2, GREEN: 3, PURPLE: 4, SHAPES: 5, BOSS: 6 };

export const TEAM_COLORS = {
  0: '#00b2e1', // neutral / self-ish blue
  1: '#00b2e1',
  2: '#f14e54',
  3: '#00e16e',
  4: '#bf7ff5',
  5: '#a0a0a0',
  6: '#e8a33d',
};

export const GAME_MODES = {
  ffa:  { id: 'ffa',  name: 'Free For All', teams: 0, maxPlayers: 40 },
  tdm:  { id: 'tdm',  name: 'Team Deathmatch', teams: 2, maxPlayers: 40 },
  boss: { id: 'boss', name: 'Boss Fight', teams: 0, maxPlayers: 30 },
  // Cheat builds are accepted here and nowhere else, so the competitive modes
  // stay honest while you still get somewhere to fire a 48-barrel monstrosity.
  sandbox: { id: 'sandbox', name: 'Sandbox', teams: 0, maxPlayers: 12, cheat: true },
};

// Server -> client VFX event kinds. The server decides when these happen so
// every client renders identical effects at identical world positions.
export const FX = {
  FIRE: 0,        // muzzle flash   a=angle b=barrelWidth c=teamColorIdx
  HIT: 1,         // projectile impact spark
  EXPLODE: 2,     // projectile death puff
  TANK_DEATH: 3,  // tank shatter + shockwave
  SHAPE_DEATH: 4, // shape shatter, b=shapeKind
  LEVEL_UP: 5,    // expanding ring on a tank
  SPAWN: 6,       // warp-in
  BOSS_ROAR: 7,   // big shockwave, screen shake for everyone
  HEAL: 8,        // regen sparkle
  BOSS_SLAM: 9,   // boss ground slam ring
};

// Physics
export const FRICTION = 0.86;
export const BASE_ACCEL = 1.35;
export const TANK_BASE_RADIUS = 24;

export const MAX_NAME_LEN = 16;

// Simulation safety rails. Cheat builds are allowed to be absurd on paper, but
// the server still has to tick whatever they produce, so firing is throttled
// against these budgets rather than against the build's own numbers.
export const MAX_PROJECTILES_PER_TANK = 340;
export const ROOM_ENTITY_CAP = 3600;
