// Procedural sound effects.
//
// Everything is synthesised at runtime from oscillators and a noise buffer --
// no audio files, so nothing to download and nothing to keep in sync with the
// repo. Sounds are driven by the same server FX events as the particles, so
// what you hear matches what everyone else hears.

import { FX } from '../../shared/constants.js';
import { clamp } from '../../shared/math.js';

const HEARING_RANGE = 1900;   // world units past which a sound is inaudible

/**
 * Per-event throttle. A dozen players on autofire would otherwise queue
 * hundreds of oscillators a second and turn into white noise (and a CPU load).
 */
const THROTTLE_MS = {
  [FX.FIRE]: 45,
  [FX.HIT]: 55,
  [FX.EXPLODE]: 70,
  [FX.SHAPE_DEATH]: 70,
  [FX.TANK_DEATH]: 120,
  [FX.LEVEL_UP]: 200,
  [FX.SPAWN]: 150,
  [FX.BOSS_ROAR]: 900,
  [FX.BOSS_SLAM]: 400,
};

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.enabled = localStorage.getItem('turretforge.sfx') !== '0';
    this.volume = Number(localStorage.getItem('turretforge.volume') || 0.7);
    this.lastAt = new Map();
    this.voices = 0;
  }

  /**
   * Browsers refuse to start audio before a user gesture, so this is called
   * from the first click rather than at load.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused by every percussive sound.
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  setEnabled(on) {
    this.enabled = on;
    localStorage.setItem('turretforge.sfx', on ? '1' : '0');
    if (this.master) this.master.gain.value = on ? this.volume : 0;
    if (on) this.unlock();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    localStorage.setItem('turretforge.volume', String(this.volume));
    if (this.master && this.enabled) this.master.gain.value = this.volume;
  }

  /** True if this event kind is allowed to make a sound right now. */
  allow(kind) {
    const gap = THROTTLE_MS[kind];
    if (gap === undefined) return false;
    const now = performance.now();
    const last = this.lastAt.get(kind) || 0;
    if (now - last < gap) return false;
    this.lastAt.set(kind, now);
    return true;
  }

  /** A short-lived oscillator voice. */
  tone(type, freqFrom, freqTo, dur, gain, delay = 0) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t0);
    if (freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A filtered burst of the shared noise buffer. */
  burst(dur, gain, filterFrom, filterTo, q = 1) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = q;
    filt.frequency.setValueAtTime(filterFrom, t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /**
   * Turn one server FX event into sound.
   * @param {object} ev  {kind, x, y, a, b, c}
   * @param {number} selfX @param {number} selfY  listener position
   */
  handle(ev, selfX, selfY) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;

    const dist = Math.hypot(ev.x - selfX, ev.y - selfY);
    const big = ev.kind === FX.BOSS_ROAR || ev.kind === FX.BOSS_SLAM;
    if (dist > HEARING_RANGE && !big) return;
    if (!this.allow(ev.kind)) return;

    // Inverse falloff, squared so distant fights stay firmly in the background.
    const near = 1 - clamp(dist / HEARING_RANGE, 0, 1);
    const vol = big ? Math.max(0.35, near) : near * near;
    if (vol < 0.02) return;

    switch (ev.kind) {
      case FX.FIRE: {
        // Barrel width sets the pitch, so a cannon sounds heavier than a pea
        // shooter -- the same data the muzzle flash is sized from.
        const width = Math.max(6, ev.b);
        const base = clamp(900 - width * 18, 150, 900);
        this.tone('square', base, base * 0.45, 0.09, 0.055 * vol);
        this.burst(0.05, 0.05 * vol, 2400, 500);
        break;
      }

      case FX.HIT:
        this.burst(0.045, 0.05 * vol, 5200, 1600, 2);
        break;

      case FX.EXPLODE:
        this.burst(0.16, 0.07 * vol, 1500, 240);
        this.tone('triangle', 340, 120, 0.14, 0.035 * vol);
        break;

      case FX.SHAPE_DEATH:
        this.burst(0.13, 0.06 * vol, 2600, 420, 1.5);
        this.tone('square', 520, 190, 0.1, 0.03 * vol);
        break;

      case FX.TANK_DEATH:
        this.burst(0.42, 0.13 * vol, 1300, 90);
        this.tone('sawtooth', 240, 48, 0.36, 0.07 * vol);
        this.tone('sine', 120, 40, 0.5, 0.05 * vol);
        break;

      case FX.LEVEL_UP:
        // Rising major triad.
        this.tone('sine', 523, 523, 0.1, 0.05 * vol, 0);
        this.tone('sine', 659, 659, 0.1, 0.05 * vol, 0.07);
        this.tone('sine', 784, 784, 0.16, 0.06 * vol, 0.14);
        break;

      case FX.SPAWN:
        this.tone('sine', 180, 760, 0.22, 0.05 * vol);
        break;

      case FX.BOSS_ROAR:
        this.tone('sawtooth', 90, 34, 1.1, 0.14 * vol);
        this.tone('square', 46, 22, 1.3, 0.09 * vol);
        this.burst(0.9, 0.09 * vol, 700, 70);
        break;

      case FX.BOSS_SLAM:
        this.tone('sine', 130, 32, 0.5, 0.14 * vol);
        this.burst(0.36, 0.11 * vol, 900, 90);
        break;

      default:
        break;
    }
  }

  /** Small UI click, used by menu and Forge buttons. */
  ui(kind) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (kind === 'error') {
      this.tone('square', 260, 150, 0.16, 0.05);
    } else if (kind === 'ok') {
      this.tone('sine', 660, 880, 0.1, 0.045);
    } else {
      this.tone('sine', 440, 520, 0.05, 0.03);
    }
  }
}
