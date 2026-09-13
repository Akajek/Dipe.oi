// Entry point: wires transport, simulation view, input and UI into one loop.

import { Net } from './net.js';
import { VFX } from './vfx.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Minimap } from './minimap.js';
import { Builder } from './builder.js';
import { UI } from './ui.js';
import { Sfx } from './sfx.js';
import { ENT, TICK_RATE, GAME_MODES, TANK_BASE_RADIUS } from '../../shared/constants.js';
import { clamp, lerp } from '../../shared/math.js';
import { validateBuild } from '../../shared/builds.js';

const canvas = document.getElementById('game');

const state = {
  playing: false,
  mode: 'ffa',
  name: '',
  level: 1,
  xpRatio: 0,
  score: 0,
  points: 0,
  stats: new Array(8).fill(0),
  bestScore: Number(localStorage.getItem('turretforge.best') || 0),
  boss: null,
  roundMsg: '',
  deathInfo: null,
};

const vfx = new VFX();
const renderer = new Renderer(canvas, vfx);
const minimap = new Minimap(document.getElementById('minimap'));
const sfx = new Sfx();

// Browsers only allow audio to start from a user gesture.
window.addEventListener('pointerdown', () => sfx.unlock(), { once: false });
window.addEventListener('keydown', () => sfx.unlock(), { once: true });

/** Low-graphics mode: fewer particles, lower render resolution, no trails. */
let lowFx = localStorage.getItem('turretforge.lowfx') === '1';
function applyLowFx(on) {
  lowFx = on;
  localStorage.setItem('turretforge.lowfx', on ? '1' : '0');
  renderer.lowFx = on;
  renderer.setDprScale(on ? 0.75 : 1);
  vfx.quality = on ? 0.3 : 1;
  vfx.maxAlive = on ? 260 : 1400;
}

const ui = new UI({
  onPlay: (name, mode) => startGame(name, mode),
  onForge: () => builder.show(),
  onRespawn: () => respawn(),
  onMenu: () => backToMenu(),
  onChat: (msg) => net.sendJSON({ t: 'chat', msg }),
  onUpgrade: (i) => net.sendJSON({ t: 'upgrade', stat: i }),
  onChatState: (open) => { input.chatting = open; },
  onLowFx: (on) => applyLowFx(on),
  onSfx: (on) => sfx.setEnabled(on),
  onVolume: (v) => sfx.setVolume(v),
});

const builder = new Builder(
  (build) => {
    ui.updateBuildSummary(build);
    if (state.playing) {
      // Applies on the next respawn; the server keeps the live tank as-is.
      net.sendJSON({ t: 'setBuild', build });
      ui.toast('Build saved — it takes effect on your next respawn', 'good');
    }
  },
  {
    sfx,
    // Cheat builds are only accepted in Sandbox, so flipping the switch moves
    // you there rather than letting you queue for a game that will reject it.
    onCheatChange: (on) => {
      if (on) ui.setMode('sandbox');
      ui.setCheat(on, builder.build);
    },
  }
);

const input = new Input(canvas, {
  onToggle: (label, on) => ui.toast(label + (on ? ' ON' : ' OFF')),
  onChatToggle: (open) => ui.toggleChat(open),
  onUpgrade: (i) => net.sendJSON({ t: 'upgrade', stat: i }),
});

// ------------------------------------------------------------------ network

const net = new Net({
  onOpen: () => {
    ui.setServerInfo('connected');
  },
  onClose: () => {
    ui.setServerInfo('disconnected — reconnecting…');
    state.playing = false;
    input.enabled = false;
    setTimeout(() => net.connect(), 1500);
  },
  onMessage: (msg) => handleMessage(msg),
  onEvents: (events) => {
    const ctx = { selfX: input.px, selfY: input.py };
    for (const ev of events) {
      vfx.handle(ev, ctx);
      sfx.handle(ev, input.px, input.py);
    }
  },
});

function handleMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      ui.setServerInfo('server: ' + (msg.region || 'local') + ' · tick ' + msg.tickRate + 'Hz');
      break;

    case 'joined':
      state.mode = msg.mode;
      ui.setModeBanner(GAME_MODES[msg.mode] ? GAME_MODES[msg.mode].name : msg.mode);
      ui.showGame();
      state.playing = true;
      input.enabled = true;
      input.reset();
      break;

    case 'self':
      state.level = msg.level;
      state.score = msg.score;
      state.points = msg.points;
      state.stats = msg.stats;
      state.xpRatio = msg.nextXp > 0 ? clamp(msg.xp / msg.nextXp, 0, 1) : 1;
      input.setMoveStat(msg.stats[7] || 0);
      ui.setStats(msg.stats, msg.points);
      ui.setLevel(msg.level, state.xpRatio);
      if (msg.score > state.bestScore) {
        state.bestScore = msg.score;
        localStorage.setItem('turretforge.best', String(msg.score));
      }
      ui.setScore(msg.score, state.bestScore > 0 ? clamp(msg.score / Math.max(1000, state.bestScore), 0, 1) : 0);
      break;

    case 'stats':
      state.stats = msg.stats;
      state.points = msg.points;
      ui.setStats(msg.stats, msg.points);
      break;

    case 'lb':
      ui.setLeaderboard(msg.rows, net.selfId, msg.mode, msg.teamScores);
      ui.setBossBar(msg.boss || null);
      break;

    case 'kill':
      ui.addKill(msg.killer, msg.victim);
      break;

    case 'chat':
      ui.addChat(msg.name, msg.msg);
      break;

    case 'dead':
      input.enabled = false;
      state.playing = false;
      ui.showDeath({ score: msg.score, level: msg.level, kills: msg.kills, killer: msg.killer });
      break;

    case 'bossWin':
      ui.showDeath({ title: 'You survived as the boss!', score: state.score, level: state.level, kills: 0, killer: '' });
      input.enabled = false;
      state.playing = false;
      break;

    case 'round':
      // Boss bar progress rides along with the leaderboard packet; 'round'
      // only announces transitions.
      if (msg.state === 'start') ui.toast('Boss round: ' + msg.bossName + ' is the boss!', 'good');
      else if (msg.state === 'end') { ui.toast(msg.message, 'good'); ui.setBossBar(null); }
      break;

    case 'buildOk':
      break;

    case 'error':
      ui.toast(msg.message, 'bad');
      break;

    default:
      break;
  }
}

// -------------------------------------------------------------- flow control

function startGame(name, mode) {
  // A cheat build is only legal in Sandbox, so send it there instead of
  // letting the server bounce it and hand back a starter tank.
  if (builder.cheat && mode !== 'sandbox') {
    ui.setMode('sandbox');
    ui.toast('Cheat builds only run in Sandbox — switched for you', 'bad');
    return;
  }
  // Catch an over-budget build here rather than letting the server bounce it.
  const check = validateBuild(builder.build, { cheat: builder.cheat });
  if (!check.ok) {
    ui.toast('That build is over budget — trim it first', 'bad');
    builder.show();
    return;
  }
  state.name = name || 'Anonymous';
  state.mode = mode;
  ui.setNameTag(state.name);
  vfx.clear();
  const view = renderer.viewSize();
  net.sendJSON({
    t: 'join',
    name: state.name,
    mode,
    build: builder.build,
    view: { w: view.w, h: view.h },
  });
}

function respawn() {
  ui.hideDeath();
  vfx.clear();
  input.reset();
  net.sendJSON({ t: 'respawn', build: builder.build });
  state.playing = true;
  input.enabled = true;
}

function backToMenu() {
  state.playing = false;
  input.enabled = false;
  net.close();
  ui.showMenu();
  ui.updateBuildSummary(builder.build);
  setTimeout(() => net.connect(), 200);
}

// ---------------------------------------------------------------- main loop

let lastFrame = performance.now();
let inputAccum = 0;
let viewAccum = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;
let qualityTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // FPS meter, also used to auto-scale particle density.
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0;
    ui.setNet(net.ping, fps);
    ui.setMenuPing(net.ping);
  }

  // Ease quality down on weak hardware rather than dropping frames. Particle
  // density goes first because it is the cheapest thing to lose; render
  // resolution only drops once thinning the particles has not been enough.
  qualityTimer += dt;
  if (qualityTimer > 2 && !lowFx) {
    qualityTimer = 0;
    if (fps && fps < 40) {
      vfx.quality = Math.max(0.3, vfx.quality - 0.15);
      if (fps < 28 && vfx.quality <= 0.35) renderer.setDprScale(0.75);
    } else if (fps > 55) {
      vfx.quality = Math.min(1, vfx.quality + 0.1);
      if (vfx.quality >= 1) renderer.setDprScale(1);
    }
  }

  if (builder.open) {
    builder.frame(now);
    return;                      // the forge owns the screen while it is open
  }

  const serverSelf = net.latestSelf();
  input.predict(dt, serverSelf);

  // Send input at the server tick rate, not the frame rate.
  inputAccum += dt;
  if (state.playing && inputAccum >= 1 / TICK_RATE) {
    inputAccum = 0;
    const aim = input.aim(renderer);
    net.sendInput(input.packedKeys(), aim.angle, aim.dist);
  }

  // Tell the server how much world we can see, so culling matches the camera.
  viewAccum += dt;
  if (viewAccum > 2) {
    viewAccum = 0;
    if (net.connected) {
      const v = renderer.viewSize();
      net.sendJSON({ t: 'view', w: v.w, h: v.h });
    }
  }

  // Camera: follow the predicted position, zoom out as the tank grows.
  const selfRadius = serverSelf ? serverSelf.radius : TANK_BASE_RADIUS;
  const targetZoom = clamp(1.05 * Math.pow(TANK_BASE_RADIUS / selfRadius, 0.42), 0.42, 1.25);
  renderer.zoom = lerp(renderer.zoom, targetZoom, 1 - Math.pow(0.002, dt));
  if (input.hasPrediction) {
    // On spawn (or any big jump) the camera should already be there, not glide
    // across the map.
    if (Math.hypot(renderer.camX - input.px, renderer.camY - input.py) > 700) {
      renderer.camX = input.px;
      renderer.camY = input.py;
      renderer.zoom = targetZoom;
    } else {
      renderer.camX = lerp(renderer.camX, input.px, 1 - Math.pow(0.0001, dt));
      renderer.camY = lerp(renderer.camY, input.py, 1 - Math.pow(0.0001, dt));
    }
  }

  vfx.update(dt);

  const world = net.sample(now);
  draw(world);
}

function draw(world) {
  renderer.begin();
  renderer.drawArena();

  const ents = world.ents;
  const selfId = net.selfId;

  // Painter's order: traps and shapes low, then projectiles, then tanks.
  const tanks = [];
  for (const e of ents) {
    if (e.type === ENT.TANK) { tanks.push(e); continue; }
    if (e.type === ENT.SHAPE) renderer.drawShape(e);
  }
  for (const e of ents) {
    if (e.type === ENT.BULLET || e.type === ENT.DRONE || e.type === ENT.TRAP) {
      renderer.drawProjectile(e);
    }
  }

  // The local tank is drawn at its predicted position, everyone else at the
  // interpolated server position.
  for (const e of tanks) {
    const isSelf = e.id === selfId;
    const build = net.buildFor(e.styleId);
    const player = net.playerFor(e.id);
    if (isSelf && input.hasPrediction) {
      const shown = Object.assign({}, e, { x: input.px, y: input.py });
      renderer.drawTank(shown, build, player, true);
    } else {
      renderer.drawTank(e, build, player, false);
    }
  }

  renderer.drawParticles();
  renderer.end();
  renderer.drawOverlay();

  const v = renderer.viewSize();
  minimap.draw(ents, selfId, renderer.camX, renderer.camY, v.w, v.h);
}

// ------------------------------------------------------------------- startup

function resizeAll() {
  renderer.resize();
  minimap.resize();
  if (builder.open) builder.resize();
}

window.addEventListener('resize', resizeAll);
resizeAll();
applyLowFx(lowFx);
ui.setCheat(builder.cheat, builder.build);
if (builder.cheat) ui.setMode('sandbox');
ui.updateBuildSummary(builder.build);
ui.showMenu();
net.connect();
requestAnimationFrame(frame);

// Expose a little state for debugging in the console.
window.__tf = { state, net, vfx, renderer, input, builder };
