// Dev helper: connect N bot players that wander and shoot, so multiplayer,
// interpolation and VFX sync can be checked with a real browser client.
import WebSocket from 'ws';
import { STARTER_BUILDS } from '../shared/builds.js';
import { writeInput, readSnapshot, KEY } from '../shared/protocol.js';

const COUNT = Number(process.argv[2] || 3);
const MODE = process.argv[3] || 'ffa';
const URL = process.argv[4] || 'ws://localhost:3000';
const NAMES = ['Ripper', 'Cogsworth', 'Nova', 'Tinhead', 'Vex', 'Bolt', 'Rust', 'Quasar'];
// Optional rally point: `node bots.mjs 4 ffa ws://host 4500,4500`
const RALLY = process.argv[5]
  ? { x: Number(process.argv[5].split(',')[0]), y: Number(process.argv[5].split(',')[1]) }
  : null;

for (let i = 0; i < COUNT; i++) spawnBot(i);

function spawnBot(i) {
  const ws = new WebSocket(URL);
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? i : '');
  const build = STARTER_BUILDS[(i + 1) % STARTER_BUILDS.length].build;
  let angle = Math.random() * Math.PI * 2;
  let keys = 0;
  let seq = 0;
  let timer = null;
  const self = { x: 4500, y: 4500 };

  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'join', name, mode: MODE, build }));
    timer = setInterval(() => {
      if (RALLY) {
        // Head for the rally point so a human can actually see them.
        keys = 0;
        if (self.x < RALLY.x - 120) keys |= KEY.RIGHT;
        else if (self.x > RALLY.x + 120) keys |= KEY.LEFT;
        if (self.y < RALLY.y - 120) keys |= KEY.DOWN;
        else if (self.y > RALLY.y + 120) keys |= KEY.UP;
      } else if (Math.random() < 0.04) {
        keys = 0;
        if (Math.random() < 0.7) keys |= [KEY.UP, KEY.DOWN, KEY.LEFT, KEY.RIGHT][(Math.random() * 4) | 0];
      }
      angle += (Math.random() - 0.5) * 0.25;
      seq = (seq + 1) & 0xff;
      ws.send(writeInput(seq, keys | KEY.AUTOFIRE, angle, 600));
    }, 33);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const snap = readSnapshot(new Uint8Array(data));
      if (snap) {
        const me = snap.ents.find((e) => e.id === snap.selfId);
        if (me) { self.x = me.x; self.y = me.y; }
      }
      return;
    }
    const m = JSON.parse(data.toString());
    if (m.t === 'dead') {
      // Respawn after a beat and keep the arena busy.
      setTimeout(() => ws.send(JSON.stringify({ t: 'respawn', build })), 1200);
    }
    if (m.t === 'self' && m.points > 0) {
      ws.send(JSON.stringify({ t: 'upgrade', stat: (Math.random() * 8) | 0 }));
    }
  });

  ws.on('close', () => clearInterval(timer));
  ws.on('error', (e) => console.error(name, e.message));
  console.log('bot', name, 'using', build.name);
}
