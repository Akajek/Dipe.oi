// WebSocket transport plus the snapshot buffer that smooths 30 Hz server state
// into 60+ fps rendering.

import { readSnapshot, writeInput, writePing, MSG } from '../../shared/protocol.js';
import { lerp, lerpAngle } from '../../shared/math.js';

// Render this far in the past so there is always a newer snapshot to lerp
// toward. Roughly three server ticks.
const INTERP_DELAY = 100;
const MAX_SNAPSHOTS = 24;

export class Net {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.connected = false;
    this.snapshots = [];
    this.styles = new Map();    // styleId -> build definition
    this.players = new Map();   // entity id -> {name, team, boss}
    this.selfId = 0;
    this.ping = 0;
    this.clockOffset = 0;
    this.bytesIn = 0;
    this.lastSeq = 0;
    this.pingTimer = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.connected = true;
      this.handlers.onOpen && this.handlers.onOpen();
      this.pingTimer = setInterval(() => this.sendPing(), 2000);
      this.sendPing();
    };

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.onJSON(msg);
      } else {
        this.bytesIn += ev.data.byteLength;
        this.onBinary(new Uint8Array(ev.data));
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.handlers.onClose && this.handlers.onClose();
    };

    this.ws.onerror = () => { /* onclose always follows; handled there */ };
  }

  onJSON(msg) {
    if (msg.t === 'style') {
      this.styles.set(msg.id, msg.build);
      return;
    }
    if (msg.t === 'players') {
      this.players.clear();
      for (const p of msg.players) this.players.set(p.id, p);
      return;
    }
    this.handlers.onMessage && this.handlers.onMessage(msg);
  }

  onBinary(buf) {
    const kind = buf[0];

    if (kind === MSG.PONG) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const sent = view.getFloat32(1, true);
      // Stamps are truncated to the low 32 bits of performance.now().
      const rtt = (performance.now() % 4294967296) - sent;
      if (rtt >= 0 && rtt < 5000) this.ping = Math.round(this.ping * 0.7 + rtt * 0.3);
      return;
    }

    if (kind !== MSG.SNAPSHOT) return;
    const snap = readSnapshot(buf);
    if (!snap) return;

    snap.recv = performance.now();
    snap.map = new Map();
    for (const e of snap.ents) snap.map.set(e.id, e);
    this.selfId = snap.selfId;

    this.snapshots.push(snap);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();

    if (snap.events.length && this.handlers.onEvents) {
      this.handlers.onEvents(snap.events);
    }
  }

  sendJSON(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendInput(keys, aimAngle, aimDist) {
    if (this.ws && this.ws.readyState === 1) {
      this.lastSeq = (this.lastSeq + 1) & 0xff;
      this.ws.send(writeInput(this.lastSeq, keys, aimAngle, aimDist));
    }
  }

  sendPing() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(writePing(performance.now() % 4294967296));
    }
  }

  /**
   * Interpolated world state for the current frame.
   * Returns entities with smoothed x/y/angle/radius, plus the local player's
   * authoritative entity (uninterpolated) when present.
   * @returns {{ents: Array, self: object|null, t: number}}
   */
  sample(now) {
    const n = this.snapshots.length;
    if (n === 0) return { ents: [], self: null, t: 0 };
    if (n === 1) {
      const only = this.snapshots[0];
      return { ents: only.ents, self: only.map.get(this.selfId) || null, t: only.tick };
    }

    const target = now - INTERP_DELAY;

    // Find the snapshot pair bracketing the render time.
    let i = n - 1;
    while (i > 0 && this.snapshots[i - 1].recv > target) i--;
    const s1 = this.snapshots[i];
    const s0 = this.snapshots[i - 1] || s1;

    if (s0 === s1) {
      return { ents: s1.ents, self: s1.map.get(this.selfId) || null, t: s1.tick };
    }

    const span = s1.recv - s0.recv;
    const t = span > 0 ? Math.max(0, Math.min(1, (target - s0.recv) / span)) : 1;

    const out = [];
    for (const b of s1.ents) {
      const a = s0.map.get(b.id);
      if (!a) {
        // Newly visible this snapshot: show it where it is, no lerp.
        out.push(b);
        continue;
      }
      out.push({
        id: b.id,
        type: b.type,
        flags: b.flags,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        angle: lerpAngle(a.angle, b.angle, t),
        radius: lerp(a.radius, b.radius, t),
        team: b.team,
        hpRatio: lerp(a.hpRatio, b.hpRatio, t),
        styleId: b.styleId,
        aux: b.aux,
        // Velocity estimate, handy for motion-blur style trails.
        vx: span > 0 ? (b.x - a.x) / span : 0,
        vy: span > 0 ? (b.y - a.y) / span : 0,
      });
    }

    const latest = this.snapshots[n - 1];
    return { ents: out, self: latest.map.get(this.selfId) || null, t: s1.tick };
  }

  /** Most recent authoritative position of the local tank, or null. */
  latestSelf() {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const e = this.snapshots[i].map.get(this.selfId);
      if (e) return e;
    }
    return null;
  }

  buildFor(styleId) {
    return this.styles.get(styleId) || null;
  }

  playerFor(id) {
    return this.players.get(id) || null;
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.connected = false;
    this.snapshots.length = 0;
  }
}
