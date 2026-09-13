// HTTP + WebSocket entry point. Serves the static client, hosts the rooms and
// drives every room's fixed-step simulation.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { MS_PER_TICK, TICK_RATE, GAME_MODES, MAX_NAME_LEN, STAT_COUNT, WORLD_SIZE } from '../shared/constants.js';
import { MSG, readInput } from '../shared/protocol.js';
import { validateBuild, BUDGET, STARTER_BUILDS } from '../shared/builds.js';
import { Room } from './room.js';
import { AssetServer } from './assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const START_TIME = new Date().toISOString();

/**
 * Short fingerprint of the code actually being served. Lets a player read
 * their build off the menu and say whether they are on the current deploy --
 * the question that is otherwise guesswork over chat.
 */
const BUILD_ID = (() => {
  try {
    const h = createHash('sha1');
    for (const dir of ['client/js', 'client/css', 'client', 'shared']) {
      const full = path.join(ROOT, dir);
      for (const f of fs.readdirSync(full).sort()) {
        const fp = path.join(full, f);
        const st = fs.statSync(fp);
        if (st.isFile()) h.update(f + st.size + st.mtimeMs);
      }
    }
    return h.digest('hex').slice(0, 7);
  } catch {
    return 'dev';
  }
})();

const app = express();
app.disable('x-powered-by');

app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ build: BUILD_ID, node: process.version, started: START_TIME });
});

// Render's health check. Cheap and dependency-free.
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

app.get('/api/rooms', (_req, res) => {
  res.json({
    region: process.env.RENDER_REGION || 'local',
    modes: Object.values(GAME_MODES).map((m) => ({
      id: m.id, name: m.name,
      players: [...rooms.values()].filter((r) => r.mode === m.id).reduce((s, r) => s + r.clients.size, 0),
    })),
  });
});

// Cache aggressively in production; never in development, where a stale
// module is indistinguishable from a bug.
// Asset URLs carry no content hash, so a long max-age means a redeploy can
// leave a browser holding new HTML and stale JS -- the UI renders controls
// whose event handlers do not exist yet. `no-cache` still caches; it just
// forces a revalidation, which answers 304 in a few bytes when nothing moved.
// For a few hundred KB of source that is the right trade for always-correct.
const STATIC_OPTS = process.env.NODE_ENV === 'production'
  ? { etag: true, maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }
  : { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') };

// Build-stamped modules first; everything else (favicon, images) falls
// through to the plain static handler below.
const assets = new AssetServer(ROOT, BUILD_ID);
app.use(assets.middleware());

app.use('/shared', express.static(path.join(ROOT, 'shared'), STATIC_OPTS));
app.use(express.static(path.join(ROOT, 'client'), Object.assign({ index: 'index.html' }, STATIC_OPTS)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, perMessageDeflate: false });

// ------------------------------------------------------------------- rooms

const rooms = new Map();
let roomSeq = 0;

function getRoom(mode) {
  const def = GAME_MODES[mode] || GAME_MODES.ffa;
  for (const r of rooms.values()) {
    if (r.mode === def.id && r.clients.size < def.maxPlayers) return r;
  }
  const id = `${def.id}-${++roomSeq}`;
  const room = new Room(id, def.id);
  rooms.set(id, room);
  console.log(`[room] created ${id}`);
  return room;
}

function reapRooms() {
  for (const [id, room] of rooms) {
    // Keep one room per mode warm; drop extra empties so shapes stop ticking.
    if (room.clients.size > 0) continue;
    const siblings = [...rooms.values()].filter((r) => r.mode === room.mode);
    if (siblings.length > 1) {
      rooms.delete(id);
      console.log(`[room] reaped ${id}`);
    }
  }
}

// ------------------------------------------------------------------ client

let clientSeq = 0;

class Client {
  constructor(ws) {
    this.id = ++clientSeq;
    this.ws = ws;
    this.name = 'Unnamed';
    this.room = null;
    this.tank = null;
    this.build = validateBuild(null).build;
    this.viewW = 1800;
    this.viewH = 1000;
    this.camX = WORLD_SIZE / 2;
    this.camY = WORLD_SIZE / 2;
    this.lastScore = 0;
    this.alive = true;
    this.joined = false;
    this.lastInput = null;
    this.lastInputAt = 0;
  }

  sendRaw(str) {
    if (this.ws.readyState === 1) this.ws.send(str);
  }
  sendJSON(obj) { this.sendRaw(JSON.stringify(obj)); }
  sendBinary(buf) {
    if (this.ws.readyState === 1) this.ws.send(buf, { binary: true });
  }
  error(message) { this.sendJSON({ t: 'error', message }); }
}

/**
 * Validate a client-supplied build, falling back to the starter build when it
 * fails. Clamping alone is not enough: ten max-stat turrets are each
 * individually legal but wildly over budget together, so a failed check must
 * discard the build outright rather than use the clamped version.
 */
function acceptBuild(client, raw, mode) {
  const def = GAME_MODES[mode] || GAME_MODES.ffa;
  const check = validateBuild(raw, { cheat: !!def.cheat });
  if (check.ok) return check.build;
  client.error('Build rejected (' + check.reason + '); using the starter build.');
  return structuredClone(STARTER_BUILDS[0].build);
}

/** Strip control characters and clamp length. Names are shown to other players. */
function sanitizeName(raw) {
  let out = '';
  for (const ch of String(raw || '')) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  out = out.trim().slice(0, MAX_NAME_LEN);
  return out.length ? out : 'Anonymous';
}

wss.on('connection', (ws) => {
  const client = new Client(ws);
  ws.binaryType = 'arraybuffer';

  client.sendJSON({
    t: 'welcome',
    budget: BUDGET,
    tickRate: TICK_RATE,
    world: WORLD_SIZE,
    region: process.env.RENDER_REGION || 'local',
    build: BUILD_ID,
    modes: Object.values(GAME_MODES),
  });

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) handleBinary(client, data);
      else handleText(client, data);
    } catch (err) {
      console.error('[msg] error from client', client.id, err.message);
    }
  });

  ws.on('pong', () => { client.alive = true; });

  ws.on('close', () => {
    if (client.room) client.room.leave(client);
    console.log('[net] client ' + client.id + ' (' + client.name + ') disconnected');
  });

  ws.on('error', (err) => console.error('[net] socket error', err.message));
});

function handleBinary(client, data) {
  const buf = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (buf.byteLength < 1) return;
  const kind = buf[0];

  if (kind === MSG.INPUT) {
    const inp = readInput(buf);
    if (!inp) return;
    client.lastInput = inp;
    client.lastInputAt = Date.now();
    if (client.tank && !client.tank.dead) client.tank.applyInput(inp);
    return;
  }

  if (kind === MSG.PING) {
    // Echo the client stamp back untouched so it can measure RTT itself.
    const out = new Uint8Array(buf.byteLength);
    out.set(buf);
    out[0] = MSG.PONG;
    client.sendBinary(out);
  }
}

function handleText(client, data) {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (text.length > 16384) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'join': {
      if (client.joined && client.room) { client.error('Already in a game.'); return; }
      client.name = sanitizeName(msg.name);
      const mode = GAME_MODES[msg.mode] ? msg.mode : 'ffa';
      client.build = acceptBuild(client, msg.build, mode);
      if (msg.view) client.setView(msg.view.w, msg.view.h);
      const room = getRoom(mode);
      room.join(client);
      client.joined = true;
      console.log('[net] ' + client.name + ' joined ' + room.id);
      break;
    }

    case 'respawn': {
      if (!client.room) return;
      if (client.tank && !client.tank.dead) return;
      if (msg.build) client.build = acceptBuild(client, msg.build, client.room.mode);
      // The boss slot is round-controlled; never self-respawn into it.
      if (client.room.mode === 'boss' && client.room.bossClient === client) return;
      client.room.spawnTank(client);
      break;
    }

    case 'setBuild': {
      const mode = client.room ? client.room.mode : 'ffa';
      const def = GAME_MODES[mode] || GAME_MODES.ffa;
      const check = validateBuild(msg.build, { cheat: !!def.cheat });
      if (!check.ok) { client.error('Build rejected: ' + check.reason); return; }
      client.build = check.build;
      client.sendJSON({ t: 'buildOk', cost: check.cost });
      break;
    }

    case 'upgrade': {
      const tank = client.tank;
      if (!tank || tank.dead) return;
      const stat = msg.stat | 0;
      if (stat < 0 || stat >= STAT_COUNT) return;
      if (tank.upgrade(stat)) {
        client.sendJSON({ t: 'stats', stats: tank.stats, points: tank.points });
      }
      break;
    }

    case 'view':
      client.setView(msg.w, msg.h);
      break;

    case 'chat': {
      if (!client.room) return;
      const now = Date.now();
      if (now - (client.lastChat || 0) < 900) return;   // simple flood guard
      client.lastChat = now;
      const body = sanitizeName(msg.msg).slice(0, 80);
      if (!body) return;
      client.room.broadcastJSON({ t: 'chat', name: client.name, msg: body });
      break;
    }

    default:
      break;
  }
}

Client.prototype.setView = function setView(w, h) {
  // Clamp the requested viewport so nobody can ask for the whole map.
  this.viewW = Math.max(600, Math.min(3000, Number(w) || 1800));
  this.viewH = Math.max(400, Math.min(1800, Number(h) || 1000));
};

// --------------------------------------------------------------- main loop

let lastTick = Date.now();
let accumulator = 0;
let slowTicks = 0;

function loop() {
  const now = Date.now();
  let elapsed = now - lastTick;
  lastTick = now;
  // A long stall (GC, suspend) must not trigger a catch-up avalanche.
  if (elapsed > 500) elapsed = 500;
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= MS_PER_TICK && steps < 5) {
    accumulator -= MS_PER_TICK;
    steps++;
    const t0 = Date.now();
    for (const room of rooms.values()) {
      // An empty room has nobody to simulate for. Freezing it matters on
      // small instances, where ticking a few hundred idle shapes is a real
      // slice of the CPU budget.
      if (room.clients.size === 0) continue;
      room.update();
    }
    const cost = Date.now() - t0;
    if (cost > MS_PER_TICK) {
      if (++slowTicks % 30 === 0) {
        console.warn('[perf] tick took ' + cost + 'ms across ' + rooms.size + ' rooms');
      }
    }
  }
}

setInterval(loop, Math.max(1, Math.floor(MS_PER_TICK / 2)));
setInterval(reapRooms, 30000);

// Drop sockets that stop answering pings, so rooms do not fill with ghosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* already closing */ }
  }
}, 30000);

wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

server.listen(PORT, () => {
  console.log('[boot] turretforge listening on :' + PORT);
  console.log('[boot] region=' + (process.env.RENDER_REGION || 'local') + ' tickRate=' + TICK_RATE);
});

function shutdown(signal) {
  console.log('[boot] ' + signal + ' received, closing');
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server restarting'); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
