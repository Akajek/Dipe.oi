// Headless regression tests for the simulation and build validation.
// Run with: npm test
//
// These cover the invariants that are expensive to notice by playing:
// friendly fire, build-budget enforcement, drone accounting and tick cost.

import { Room } from '../server/room.js';
import { STARTER_BUILDS, validateBuild, defaultTurret, BUDGET, MAX_TURRETS } from '../shared/builds.js';
import { KEY } from '../shared/protocol.js';
import { ENT, TEAM } from '../shared/constants.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function section(name) { console.log('\n' + name); }

function fakeClient(name, build) {
  return {
    name, build, tank: null, room: null, viewW: 1800, viewH: 1000, camX: 0, camY: 0,
    msgs: [], ws: { readyState: 1, bufferedAmount: 0 }, bytes: 0,
    sendRaw(s) { this.msgs.push(JSON.parse(s)); },
    sendJSON(o) { this.msgs.push(o); },
    sendBinary(b) { this.bytes += b.byteLength; },
    error(m) { this.msgs.push({ t: 'error', message: m }); },
  };
}

const emptyRoom = (mode) => {
  const r = new Room('test', mode);
  for (const e of [...r.entities.values()]) r.remove(e);
  return r;
};

const countType = (room, type) => [...room.entities.values()].filter((e) => e.type === type).length;

// ---------------------------------------------------------------- build cost

section('build validation');
for (const p of STARTER_BUILDS) {
  const v = validateBuild(p.build);
  check('preset "' + p.label + '" is within budget', v.ok, v.reason);
}

{
  const cheat = {
    name: 'x', body: 'circle',
    turrets: Array.from({ length: 40 }, () => defaultTurret({ damage: 9999, reload: 0.001, count: 99, pen: 9999, size: 99 })),
  };
  const v = validateBuild(cheat);
  check('absurd build is rejected', !v.ok, 'cost ' + v.cost.toFixed(0));
  check('turret count is capped', v.build.turrets.length <= MAX_TURRETS, String(v.build.turrets.length));
  check('fields are clamped', v.build.turrets[0].damage <= 26 && v.build.turrets[0].count <= 6);
}

{
  // Ten individually-legal max-stat turrets must still fail as a set.
  const maxed = {
    name: 'maxed', body: 'circle',
    turrets: Array.from({ length: 10 }, () => defaultTurret({ damage: 26, reload: 0.12, count: 6, pen: 18, size: 2.2 })),
  };
  const v = validateBuild(maxed);
  check('clamped-but-over-budget build is rejected', !v.ok, 'cost ' + v.cost.toFixed(0) + ' > ' + BUDGET);
}

check('malformed input degrades to a legal build', validateBuild('nonsense').build.turrets.length > 0);
check('empty turret list gets a default turret', validateBuild({ turrets: [] }).build.turrets.length === 1);

// -------------------------------------------------------------------- combat

section('combat');
{
  const room = emptyRoom('ffa');
  const a = fakeClient('Shooter', STARTER_BUILDS[0].build);
  const b = fakeClient('Target', STARTER_BUILDS[0].build);
  room.join(a); room.join(b);
  a.tank.x = 4000; a.tank.y = 4000; a.tank.invuln = 0;
  b.tank.x = 4220; b.tank.y = 4000; b.tank.invuln = 0;
  const start = b.tank.hp;
  for (let i = 0; i < 90; i++) {
    a.tank.applyInput({ keys: KEY.SHOOT, aimAngle: 0, aimDist: 220 });
    b.tank.applyInput({ keys: 0, aimAngle: Math.PI, aimDist: 220 });
    room.update();
    if (!b.tank) break;
  }
  check('bullets damage an enemy', !b.tank || b.tank.hp < start);
}

{
  // Every preset must be able to hurt a stationary target within 5 seconds.
  for (const preset of STARTER_BUILDS) {
    const room = emptyRoom('ffa');
    const a = fakeClient('S', preset.build);
    const b = fakeClient('T', STARTER_BUILDS[0].build);
    room.join(a); room.join(b);
    a.tank.x = 4000; a.tank.y = 4000; a.tank.invuln = 0;
    b.tank.x = 4200; b.tank.y = 4000; b.tank.invuln = 0;
    const start = b.tank.hp;
    for (let i = 0; i < 150 && b.tank; i++) {
      a.tank.applyInput({ keys: KEY.SHOOT, aimAngle: 0, aimDist: 200 });
      b.tank.applyInput({ keys: 0, aimAngle: Math.PI, aimDist: 200 });
      room.update();
    }
    check('preset "' + preset.label + '" deals damage', !b.tank || b.tank.hp < start);
  }
}

section('teams');
{
  const room = emptyRoom('tdm');
  const p1 = fakeClient('Blue1', STARTER_BUILDS[0].build);
  const p2 = fakeClient('Blue2', STARTER_BUILDS[0].build);
  const p3 = fakeClient('Red1', STARTER_BUILDS[0].build);
  room.join(p1); room.join(p2); room.join(p3);
  p1.tank.team = TEAM.BLUE; p1.tank.faction = 100 + TEAM.BLUE;
  p2.tank.team = TEAM.BLUE; p2.tank.faction = 100 + TEAM.BLUE;
  p3.tank.team = TEAM.RED;  p3.tank.faction = 100 + TEAM.RED;
  for (const p of [p1, p2, p3]) { p.tank.invuln = 0; p.tank.y = 4000; }
  // Teammate directly in the line of fire, enemy just beyond.
  p1.tank.x = 4000; p2.tank.x = 4200; p3.tank.x = 4400;
  const hp2 = p2.tank.hp, hp3 = p3.tank.hp;
  for (let i = 0; i < 60; i++) {
    p1.tank.applyInput({ keys: KEY.SHOOT, aimAngle: 0, aimDist: 400 });
    room.update();
  }
  check('teammates take no bullet damage', p2.tank && p2.tank.hp === hp2, p2.tank ? String(hp2 - p2.tank.hp) : 'died');
  check('enemies do take damage', !p3.tank || p3.tank.hp < hp3);
}

section('drones');
{
  const room = emptyRoom('ffa');
  const c = fakeClient('Swarm', STARTER_BUILDS[4].build);
  room.join(c);
  for (let i = 0; i < 150; i++) {
    c.tank.applyInput({ keys: KEY.AUTOFIRE, aimAngle: 0.3, aimDist: 400 });
    room.update();
  }
  const alive = countType(room, ENT.DRONE);
  const cap = STARTER_BUILDS[4].build.turrets.reduce((s, t) => s + t.count, 0);
  check('drone swarm respects its cap', alive <= cap, alive + ' > ' + cap);
  check('drone swarm actually spawns', alive > 0);

  c.tank.damage(99999, null, room);
  room.update();
  check('drones die with their owner', countType(room, ENT.DRONE) === 0);
}

section('boss mode');
{
  const room = new Room('boss', 'boss');
  const a = fakeClient('Hero', STARTER_BUILDS[0].build);
  room.join(a);
  room.update();
  check('a lone player never becomes the boss', room.roundState === 'waiting');

  const b = fakeClient('Chad', STARTER_BUILDS[0].build);
  room.join(b);
  room.update();
  check('a round starts once two players are present', room.roundState === 'active');
  check('the boss is huge', room.boss && room.boss.r > 100, room.boss ? String(room.boss.r) : 'none');
  check('the boss has a big health pool', room.boss && room.boss.maxHp > 3000);

  const challenger = room.boss === a.tank ? b : a;
  check('challengers are levelled up to fight', challenger.tank.level > 10, 'level ' + challenger.tank.level);
  check('boss and challengers are hostile', room.boss.faction !== challenger.tank.faction);

  // A player joining mid-round must also be brought up to weight.
  const late = fakeClient('Latecomer', STARTER_BUILDS[0].build);
  room.join(late);
  check('mid-round joiners are levelled too', late.tank.level > 10, 'level ' + late.tank.level);

  room.boss.invuln = 0;
  room.boss.damage(999999, challenger.tank, room);
  room.update();
  check('killing the boss ends the round', room.roundState === 'waiting' && room.boss === null);
  const end = [...a.msgs, ...b.msgs].filter((m) => m.t === 'round' && m.state === 'end').pop();
  check('round end is announced', !!end, end ? end.message : 'no message');
}

section('performance and bandwidth');
{
  const room = new Room('perf', 'ffa');
  const clients = [];
  for (let i = 0; i < 12; i++) {
    const c = fakeClient('P' + i, STARTER_BUILDS[i % STARTER_BUILDS.length].build);
    room.join(c);
    clients.push(c);
  }
  for (let i = 0; i < 30; i++) {
    for (const c of clients) {
      if (c.tank) c.tank.applyInput({ keys: KEY.AUTOFIRE, aimAngle: Math.random() * 6.28, aimDist: 500 });
    }
    room.update();
  }
  for (const c of clients) c.bytes = 0;

  const ticks = 150;
  const t0 = Date.now();
  for (let i = 0; i < ticks; i++) {
    for (const c of clients) {
      if (c.tank) c.tank.applyInput({ keys: KEY.AUTOFIRE, aimAngle: Math.random() * 6.28, aimDist: 500 });
    }
    room.update();
  }
  const ms = Date.now() - t0;
  const perTick = ms / ticks;
  const kbPerSec = (clients[0].bytes / (ticks / 30)) / 1024;
  console.log('  info 12 players, ' + room.entities.size + ' entities: '
    + perTick.toFixed(2) + ' ms/tick, ' + kbPerSec.toFixed(1) + ' KB/s per client');
  check('tick fits in the 33ms budget', perTick < 33, perTick.toFixed(2) + ' ms');
  check('per-client bandwidth is sane', kbPerSec < 120, kbPerSec.toFixed(1) + ' KB/s');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
