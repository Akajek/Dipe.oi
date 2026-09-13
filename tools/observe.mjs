// Headless observer: drives to the rally point and reports what it sees,
// including per-viewer hostility flags. No browser throttling involved.
import WebSocket from 'ws';
import { STARTER_BUILDS } from '../shared/builds.js';
import { writeInput, readSnapshot, KEY, EF } from '../shared/protocol.js';

const TARGET = { x: 4500, y: 4500 };
const ws = new WebSocket('ws://localhost:3000');
const me = { x: 4500, y: 4500 };
let selfId = 0;
const players = new Map();
let seq = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', name: 'Observer', mode: 'ffa', build: STARTER_BUILDS[0].build }));
  setInterval(() => {
    let k = 0;
    if (me.x < TARGET.x - 100) k |= KEY.RIGHT; else if (me.x > TARGET.x + 100) k |= KEY.LEFT;
    if (me.y < TARGET.y - 100) k |= KEY.DOWN; else if (me.y > TARGET.y + 100) k |= KEY.UP;
    seq = (seq + 1) & 0xff;
    ws.send(writeInput(seq, k | KEY.AUTOFIRE, 0.4, 500));
  }, 33);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const s = readSnapshot(new Uint8Array(data));
    if (!s) return;
    selfId = s.selfId;
    const mine = s.ents.find((e) => e.id === selfId);
    if (mine) { me.x = mine.x; me.y = mine.y; }
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.t === 'players') { players.clear(); for (const p of m.players) players.set(p.id, p); }
});

setTimeout(() => {
  ws.close();
}, 26000);

setTimeout(() => {
  ws.send(JSON.stringify({ t: 'view', w: 2400, h: 1400 }));
}, 1000);

// Report once we should have arrived.
setTimeout(() => {
  const orig = ws.listeners('message')[0];
  void orig;
  ws.once('message', function report(data, isBinary) {
    if (!isBinary) { ws.once('message', report); return; }
    const s = readSnapshot(new Uint8Array(data));
    if (!s) return;
    const at = s.ents.find((e) => e.id === s.selfId);
    console.log('observer at', at ? [Math.round(at.x), Math.round(at.y)] : '?');
    const tanks = s.ents.filter((e) => e.type === 0);
    const projs = s.ents.filter((e) => e.type >= 1 && e.type <= 3);
    console.log('tanks in view:', tanks.length, ' projectiles:', projs.length);
    for (const e of tanks) {
      const p = players.get(e.id);
      console.log('  tank', String(e.id).padStart(4),
        (p ? p.name : '?').padEnd(10),
        'team=' + e.team,
        'SELF=' + !!(e.flags & EF.SELF),
        'HOSTILE=' + !!(e.flags & EF.HOSTILE));
    }
    const hostileProjs = projs.filter((e) => e.flags & EF.HOSTILE).length;
    console.log('projectiles flagged hostile:', hostileProjs, 'of', projs.length);
    console.log('shapes flagged hostile (want 0):', s.ents.filter((e) => e.type === 4 && (e.flags & EF.HOSTILE)).length);
    process.exit(0);
  });
}, 22000);
