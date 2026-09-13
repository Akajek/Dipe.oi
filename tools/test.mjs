// Headless regression tests for the simulation and build validation.
// Run with: npm test
//
// These cover the invariants that are expensive to notice by playing:
// friendly fire, build-budget enforcement, drone accounting and tick cost.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Room } from '../server/room.js';
import { AssetServer } from '../server/assets.js';
import {
  STARTER_BUILDS, validateBuild, defaultTurret, BUDGET, MAX_TURRETS,
  MAX_TURRETS_CHEAT, fieldRange,
} from '../shared/builds.js';
import { KEY, EF, readSnapshot } from '../shared/protocol.js';
import { ENT, TEAM, MAX_PROJECTILES_PER_TANK, ROOM_ENTITY_CAP } from '../shared/constants.js';
import { Shape } from '../server/entities.js';

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

section('cheat mode');
{
  const insane = {
    name: 'APOCALYPSE', body: 'hexagon',
    turrets: Array.from({ length: 200 }, () => defaultTurret({
      damage: 1e9, reload: 0, count: 999, pen: Infinity, size: NaN, speed: 1e6, life: 1e9,
    })),
  };

  const fair = validateBuild(insane);
  check('cheat build is rejected in fair modes', !fair.ok);

  const cheat = validateBuild(insane, { cheat: true });
  check('cheat build is accepted with cheat on', cheat.ok);
  check('cheat turret count is still capped', cheat.build.turrets.length === MAX_TURRETS_CHEAT,
    String(cheat.build.turrets.length));

  // The important one: no non-finite value may survive. A NaN position makes
  // an entity that cannot be drawn, hit, or removed.
  const allFinite = cheat.build.turrets.every((t) =>
    Object.values(t).every((v) => typeof v !== 'number' || Number.isFinite(v)));
  check('cheat values are all finite', allFinite);

  check('cheat widens the ranges', fieldRange('damage', true).max > fieldRange('damage', false).max);
  check('fair ranges are untouched', fieldRange('damage', false).max === 26);

  // Turning cheat off must clamp an existing cheat build back to legal values.
  const back = validateBuild(cheat.build, { cheat: false });
  check('un-cheating clamps turrets to the fair cap', back.build.turrets.length <= MAX_TURRETS);
  check('un-cheating clamps fields to fair ranges', back.build.turrets[0].damage <= 26);
}

section('sandbox mode');
{
  const room = emptyRoom('sandbox');
  const cheatBuild = validateBuild({
    name: 'BIG', body: 'hexagon',
    turrets: Array.from({ length: 48 }, (_, i) => defaultTurret({
      angle: -180 + i * 7, damage: 500, reload: 0.03, count: 24, speed: 40, pen: 50000, size: 6, life: 20,
    })),
  }, { cheat: true }).build;

  const a = fakeClient('Cheater', cheatBuild);
  const b = fakeClient('Bystander', STARTER_BUILDS[0].build);
  room.join(a); room.join(b);
  check('sandbox accepts a 48-turret build', a.tank.barrels.length === 48, String(a.tank.barrels.length));

  let peakEntities = 0, worstTick = 0;
  for (let i = 0; i < 200; i++) {
    if (a.tank) a.tank.applyInput({ keys: KEY.AUTOFIRE | KEY.SHOOT, aimAngle: i * 0.05, aimDist: 600 });
    const t0 = Date.now();
    room.update();
    worstTick = Math.max(worstTick, Date.now() - t0);
    peakEntities = Math.max(peakEntities, room.entities.size);
  }

  check('per-tank projectile budget holds', !a.tank || a.tank.liveProjectiles <= MAX_PROJECTILES_PER_TANK,
    a.tank ? String(a.tank.liveProjectiles) : 'dead');
  check('room entity cap holds', peakEntities <= ROOM_ENTITY_CAP, String(peakEntities));
  check('worst tick still inside budget', worstTick < 33, worstTick + ' ms');

  // No NaN may leak into the world from an extreme build.
  const bad = [...room.entities.values()].filter((e) => !Number.isFinite(e.x) || !Number.isFinite(e.y));
  check('no entity ends up at a NaN position', bad.length === 0, String(bad.length));
}

section('snapshot flags');
{
  // Decode what a real client would receive and check per-viewer hostility.
  const room = emptyRoom('ffa');
  const me = fakeClient('Me', STARTER_BUILDS[0].build);
  const foe = fakeClient('Foe', STARTER_BUILDS[0].build);
  room.join(me); room.join(foe);
  me.tank.x = 4000; me.tank.y = 4000;
  foe.tank.x = 4150; foe.tank.y = 4000;
  // Put a shape in view so we can confirm shapes are never flagged hostile.
  room.add(Object.assign(new Shape(0, 4080, 4080), { faction: 0 }));

  let decoded = null;
  me.sendBinary = (buf) => { decoded = readSnapshot(buf); };
  room.update();

  check('snapshot reaches the client', !!decoded);
  const selfEnt = decoded.ents.find((e) => e.id === me.tank.id);
  const foeEnt = decoded.ents.find((e) => e.id === foe.tank.id);
  check('own tank is flagged SELF', !!(selfEnt.flags & EF.SELF));
  check('own tank is not flagged hostile', !(selfEnt.flags & EF.HOSTILE));
  check('enemy tank is flagged hostile', !!(foeEnt.flags & EF.HOSTILE));
  const shapeEnts = decoded.ents.filter((e) => e.type === ENT.SHAPE);
  check('shapes are never flagged hostile', shapeEnts.every((e) => !(e.flags & EF.HOSTILE)), String(shapeEnts.length) + ' shapes');
  check('selfId matches the viewer', decoded.selfId === me.tank.id);
}

section('idle clients');
{
  const room = emptyRoom('ffa');
  const c = fakeClient('Idler', STARTER_BUILDS[0].build);
  room.join(c);
  c.tank.x = 4000; c.tank.y = 4000;
  // Simulate a client that sent input and then froze (backgrounded tab).
  c.lastInputAt = Date.now() - 5000;
  c.tank.applyInput({ keys: KEY.RIGHT | KEY.SHOOT, aimAngle: 0, aimDist: 300 });
  for (let i = 0; i < 60; i++) room.update();
  check('a frozen client coasts to a stop', Math.abs(c.tank.vx) < 0.5, 'vx=' + c.tank.vx.toFixed(2));
  check('a frozen client stops firing', !c.tank.shooting && !c.tank.autofire);
}

section('asset versioning');
{
  // The bug this guards: every module is cached under its own URL with its own
  // expiry, so after a redeploy each visitor ends up with a private mixture of
  // old and new files. Stamping the URLs makes a mixture impossible.
  // fileURLToPath, not URL.pathname: the latter keeps percent-encoding, so a
  // project path containing spaces silently resolves to nothing.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const a = new AssetServer(root, 'testbuild');

  const main = a.cache.get('/js/main.js');
  check('entry module is served from the stamped cache', !!main);

  const imports = (main.body.match(/from '[^']+'/g) || []).filter((l) => l.includes('./'));
  const stamped = imports.filter((l) => l.includes('?v=testbuild'));
  check('every relative import is stamped', imports.length > 0 && stamped.length === imports.length,
    stamped.length + '/' + imports.length);

  const html = a.cache.get('/index.html');
  check('index.html references the stamped entry point', html.body.includes('js/main.js?v=testbuild'));
  check('index.html references the stamped stylesheet', html.body.includes('css/style.css?v=testbuild'));

  // Cross-module imports inside shared/ must be stamped too, or those files
  // become the stale ones.
  const shared = a.cache.get('/shared/builds.js');
  const sharedImports = (shared.body.match(/from '\.\/[^']+'/g) || []);
  check('shared modules stamp their own imports',
    sharedImports.every((l) => l.includes('?v=testbuild')), sharedImports.join(' '));

  // A different build id must produce different URLs, or a redeploy changes
  // nothing for anyone already holding the old files.
  const b = new AssetServer(root, 'otherbuild');
  check('a new build id changes every module URL',
    b.cache.get('/index.html').body.includes('js/main.js?v=otherbuild'));
}

section('browser portability');
{
  // These guard a specific failure: code that runs fine in a current Chromium
  // but throws on a slightly older browser, where the symptom is a control
  // that silently does nothing rather than an obvious error.
  const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const clientFiles = fs.readdirSync(new URL('../client/js', import.meta.url))
    .filter((f) => f.endsWith('.js'));

  let usesStructuredClone = [];
  let bareRoundRect = [];
  for (const f of clientFiles) {
    const src = read('client/js/' + f);
    if (/structuredClone\s*\(/.test(src)) usesStructuredClone.push(f);
    // ctx.roundRect is fine behind a capability check, not as a bare call.
    const calls = (src.match(/\.roundRect\s*\(/g) || []).length;
    const guards = (src.match(/typeof\s+\w+\.roundRect/g) || []).length;
    if (calls > guards) bareRoundRect.push(f);
  }

  check('no client file calls structuredClone', usesStructuredClone.length === 0, usesStructuredClone.join(', '));
  check('roundRect is only called behind a guard', bareRoundRect.length === 0, bareRoundRect.join(', '));

  // Stale assets after a redeploy are what made cheat mode look broken:
  // new HTML, cached JS, handlers missing.
  const server = read('server/index.js');
  check('production assets revalidate rather than sitting in cache',
    /no-cache/.test(server) && !/maxAge:\s*'1h'/.test(server));
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
