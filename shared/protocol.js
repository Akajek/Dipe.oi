// Binary wire format.
//
// WebSocket *binary* frames carry the high-frequency traffic: world snapshots
// down, input up. WebSocket *text* frames carry JSON control messages (join,
// build registry, leaderboard, chat, death). Splitting by frame type means
// neither side needs a discriminator byte on the JSON path.

import { TAU } from './math.js';

export const MSG = {
  SNAPSHOT: 1,
  INPUT: 2,
  PING: 3,
  PONG: 4,
};

// Input key bits.
export const KEY = {
  UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8,
  SHOOT: 16, AUTOFIRE: 32, AUTOSPIN: 64,
};

const ENTITY_BYTES = 17;
const EVENT_BYTES = 9;
const SNAPSHOT_HEADER = 9;

const angleToWire = (a) => {
  let v = Math.round(((a % TAU) / TAU) * 65536) % 65536;
  return v < 0 ? v + 65536 : v;
};
const wireToAngle = (v) => (v / 65536) * TAU;

/** Growable little-endian writer. */
export class Writer {
  constructor(size = 2048) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.off = 0;
  }
  _need(n) {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v)  { this._need(1); this.view.setUint8(this.off, v & 0xff); this.off += 1; return this; }
  i16(v) { this._need(2); this.view.setInt16(this.off, v | 0, true); this.off += 2; return this; }
  u16(v) { this._need(2); this.view.setUint16(this.off, v & 0xffff, true); this.off += 2; return this; }
  u32(v) { this._need(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  f32(v) { this._need(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  angle(a) { return this.u16(angleToWire(a)); }
  bytes() { return new Uint8Array(this.buf, 0, this.off); }
}

/** Little-endian reader over an ArrayBuffer. */
export class Reader {
  constructor(buf) {
    this.view = new DataView(buf.buffer !== undefined ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
    this.off = 0;
  }
  get left() { return this.view.byteLength - this.off; }
  u8()  { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  angle() { return wireToAngle(this.u16()); }
}

// ---------------------------------------------------------------- snapshots

// Entity flag bits.
export const EF = {
  BOSS: 1,
  INVULN: 2,
  HURT: 4,       // took damage this tick -> client flashes white
  AUTOSPIN: 8,
  SELF: 16,
  HOSTILE: 32,   // set per-viewer: this entity can hurt the player receiving it
};

/**
 * @param {number} tick
 * @param {number} selfId
 * @param {Array} ents  objects with {id,type,flags,x,y,angle,radius,team,hpRatio,styleId,aux}
 * @param {Array} events objects with {kind,x,y,a,b,c}
 */
export function writeSnapshot(tick, selfId, ents, events) {
  const w = new Writer(SNAPSHOT_HEADER + ents.length * ENTITY_BYTES + events.length * EVENT_BYTES + 4);
  w.u8(MSG.SNAPSHOT);
  w.u32(tick);
  w.u16(selfId);
  w.u16(ents.length);
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    w.u16(e.id);
    w.u8(e.type);
    w.u8(e.flags);
    w.i16(Math.round(e.x));
    w.i16(Math.round(e.y));
    w.angle(e.angle);
    w.u16(Math.min(65535, Math.round(e.radius * 4)));
    w.u8(e.team);
    w.u8(Math.max(0, Math.min(255, Math.round(e.hpRatio * 255))));
    w.u16(e.styleId);
    w.u8(e.aux);
  }
  const evs = events.length > 255 ? events.slice(0, 255) : events;
  w.u8(evs.length);
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    w.u8(ev.kind);
    w.i16(Math.round(ev.x));
    w.i16(Math.round(ev.y));
    w.angle(ev.a || 0);
    w.u8(ev.b || 0);
    w.u8(ev.c || 0);
  }
  return w.bytes();
}

export function readSnapshot(buf) {
  const r = new Reader(buf);
  const msg = r.u8();
  if (msg !== MSG.SNAPSHOT) return null;
  const tick = r.u32();
  const selfId = r.u16();
  const count = r.u16();
  const ents = new Array(count);
  for (let i = 0; i < count; i++) {
    ents[i] = {
      id: r.u16(),
      type: r.u8(),
      flags: r.u8(),
      x: r.i16(),
      y: r.i16(),
      angle: r.angle(),
      radius: r.u16() / 4,
      team: r.u8(),
      hpRatio: r.u8() / 255,
      styleId: r.u16(),
      aux: r.u8(),
    };
  }
  const evCount = r.left > 0 ? r.u8() : 0;
  const events = new Array(evCount);
  for (let i = 0; i < evCount; i++) {
    events[i] = { kind: r.u8(), x: r.i16(), y: r.i16(), a: r.angle(), b: r.u8(), c: r.u8() };
  }
  return { tick, selfId, ents, events };
}

// -------------------------------------------------------------------- input

export function writeInput(seq, keys, aimAngle, aimDist) {
  const w = new Writer(9);
  w.u8(MSG.INPUT);
  w.u8(seq & 0xff);
  w.u8(keys);
  w.angle(aimAngle);
  w.u16(Math.min(65535, Math.max(0, Math.round(aimDist))));
  return w.bytes();
}

export function readInput(buf) {
  const r = new Reader(buf);
  if (r.u8() !== MSG.INPUT) return null;
  return { seq: r.u8(), keys: r.u8(), aimAngle: r.angle(), aimDist: r.u16() };
}

/** Latency probe. Client stamps `t`, server echoes it back verbatim. */
export function writePing(t) {
  const w = new Writer(9);
  w.u8(MSG.PING);
  w.f32(t & 0xffffffff);
  return w.bytes();
}
