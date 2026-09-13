// DOM layer: menu, HUD, leaderboard, upgrades, chat, killfeed, death screen.

import { STATS, STAT_MAX, TEAM_COLORS, TEAM, GAME_MODES } from '../../shared/constants.js';
import { buildCost, BUDGET } from '../../shared/builds.js';

const el = (id) => document.getElementById(id);

export class UI {
  constructor(hooks) {
    this.hooks = hooks;
    this.mode = localStorage.getItem('turretforge.mode') || 'ffa';
    this.stats = new Array(8).fill(0);
    this.points = 0;
    this.chatOpen = false;
    this.cheat = false;
    this.buildUpgrades();
    this.buildModes();
    this.bind();
    this.bindSettings();
  }

  /** Select a mode programmatically (cheat mode forces Sandbox). */
  setMode(mode) {
    if (!GAME_MODES[mode]) return;
    this.mode = mode;
    localStorage.setItem('turretforge.mode', mode);
    for (const n of el('modeRow').children) n.classList.toggle('active', n.dataset.mode === mode);
  }

  /** Cheat mode limits which modes are joinable; reflect that in the menu. */
  setCheat(on, build) {
    this.cheat = on;
    if (build) this.updateBuildSummary(build);

    // Keep both toggles (menu and Forge) showing the same state. Setting
    // `checked` directly does not fire `change`, so this cannot loop.
    for (const id of ['menuCheat', 'cheatToggle']) {
      const cb = el(id);
      if (!cb) continue;
      cb.checked = on;
      const label = cb.closest('label');
      if (label) {
        label.classList.toggle('on', on);
        const state = label.querySelector('.cheatState');
        if (state) state.textContent = on ? 'ON' : 'OFF';
      }
    }

    for (const n of el('modeRow').children) {
      const locked = on && n.dataset.mode !== 'sandbox';
      n.classList.toggle('locked', locked);
      n.title = locked ? 'Cheat builds only run in Sandbox' : '';
    }
  }

  bindSettings() {
    const low = el('lowFx');
    low.checked = localStorage.getItem('turretforge.lowfx') === '1';
    low.addEventListener('change', () => this.hooks.onLowFx(low.checked));

    const snd = el('sfxToggle');
    snd.checked = localStorage.getItem('turretforge.sfx') !== '0';
    snd.addEventListener('change', () => this.hooks.onSfx(snd.checked));

    const vol = el('volume');
    vol.value = String(Number(localStorage.getItem('turretforge.volume') || 0.7));
    vol.addEventListener('input', () => this.hooks.onVolume(Number(vol.value)));

    const cheat = el('menuCheat');
    cheat.addEventListener('change', () => this.hooks.onCheat(cheat.checked));
  }

  // -------------------------------------------------------------------- menu

  buildModes() {
    const row = el('modeRow');
    row.innerHTML = '';
    for (const m of Object.values(GAME_MODES)) {
      const d = document.createElement('div');
      d.className = 'modeBtn' + (m.id === this.mode ? ' active' : '');
      d.dataset.mode = m.id;
      const b = document.createElement('b');
      b.textContent = m.name;
      const s = document.createElement('small');
      s.textContent = m.id === 'ffa' ? 'Everyone for themselves'
        : m.id === 'tdm' ? 'Blue versus red'
        : m.id === 'boss' ? 'One player is the boss'
        : 'Cheat builds allowed';
      d.appendChild(b); d.appendChild(s);
      d.addEventListener('click', () => {
        if (this.cheat && m.id !== 'sandbox') {
          this.toast('Turn off cheat mode to play ' + m.name, 'bad');
          return;
        }
        this.setMode(m.id);
      });
      row.appendChild(d);
    }
  }

  bind() {
    const name = el('nameInput');
    name.value = localStorage.getItem('turretforge.name') || '';
    name.addEventListener('input', () => localStorage.setItem('turretforge.name', name.value));

    el('playBtn').addEventListener('click', () => this.hooks.onPlay(name.value.trim(), this.mode));
    el('forgeBtn').addEventListener('click', () => this.hooks.onForge());
    el('forgeBtn2').addEventListener('click', () => this.hooks.onForge());
    el('respawnBtn').addEventListener('click', () => this.hooks.onRespawn());
    el('menuBtn').addEventListener('click', () => this.hooks.onMenu());

    const chat = el('chatInput');
    chat.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = chat.value.trim();
        if (v) this.hooks.onChat(v);
        chat.value = '';
        this.toggleChat(false);
      } else if (e.key === 'Escape') {
        this.toggleChat(false);
      }
    });

    window.addEventListener('keydown', (e) => {
      // Enter opens chat only while playing; the menu owns Enter otherwise.
      if (e.key === 'Enter' && !this.chatOpen && el('menu').classList.contains('hidden') && el('forge').classList.contains('hidden') && el('death').classList.contains('hidden')) {
        this.toggleChat(true);
      }
    });
  }

  showMenu() {
    el('menu').classList.remove('hidden');
    el('hud').classList.add('hidden');
    el('death').classList.add('hidden');
    this.toggleChat(false);
  }

  showGame() {
    el('menu').classList.add('hidden');
    el('death').classList.add('hidden');
    el('hud').classList.remove('hidden');
  }

  showDeath(info) {
    el('death').classList.remove('hidden');
    el('dScore').textContent = info.score ?? 0;
    el('dLevel').textContent = info.level ?? 1;
    el('dKills').textContent = info.kills ?? 0;
    el('deathTitle').textContent = info.title || 'You were destroyed';
    el('deathBy').textContent = info.killer ? 'by ' + info.killer : '';
    this.toggleChat(false);
  }

  hideDeath() { el('death').classList.add('hidden'); }

  updateBuildSummary(build) {
    const cost = buildCost(build);
    // In cheat mode the budget is not a rule, so do not nag about it -- say
    // what it actually means for where you can play instead.
    const over = !this.cheat && cost > BUDGET + 0.5;
    const box = el('buildSummary');
    box.innerHTML = '';
    box.classList.toggle('over', over);
    box.classList.toggle('cheat', this.cheat);

    const turretText = build.turrets.length + ' turret' + (build.turrets.length === 1 ? '' : 's')
      + ' · ' + build.body + ' hull';

    const left = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'bName';
    nm.textContent = build.name || 'Custom';
    const meta = document.createElement('div');
    meta.className = 'bCost';
    meta.textContent = this.cheat ? turretText + ' · Sandbox only'
      : over ? 'Over budget — open the Forge to trim it'
      : turretText;
    left.appendChild(nm); left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'bCost';
    right.textContent = this.cheat ? cost.toFixed(0) + ' pts · unlimited' : cost.toFixed(0) + ' / ' + BUDGET + ' pts';
    box.appendChild(left); box.appendChild(right);
  }

  setServerInfo(text) { el('serverInfo').textContent = text; }
  setMenuPing(ms) { el('menuPing').textContent = ms + ' ms'; }

  // --------------------------------------------------------------- upgrades

  buildUpgrades() {
    const box = el('upgrades');
    box.innerHTML = '';
    this.upBtns = [];
    STATS.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'upBtn';
      d.style.borderLeft = '3px solid ' + s.color;

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = s.name;

      const pips = document.createElement('span');
      pips.className = 'pips';
      const pipEls = [];
      for (let p = 0; p < STAT_MAX; p++) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pips.appendChild(pip);
        pipEls.push(pip);
      }

      d.appendChild(key); d.appendChild(nm); d.appendChild(pips);
      d.addEventListener('click', () => this.hooks.onUpgrade(i));
      box.appendChild(d);
      this.upBtns.push({ node: d, pips: pipEls, color: s.color });
    });
    this.renderUpgrades();
  }

  setStats(stats, points) {
    this.stats = stats;
    this.points = points;
    this.renderUpgrades();
  }

  renderUpgrades() {
    const box = el('upgrades');
    // Hide the whole panel when there is nothing to spend.
    box.style.visibility = this.points > 0 ? 'visible' : 'hidden';
    this.upBtns.forEach((b, i) => {
      const lvl = this.stats[i] || 0;
      const maxed = lvl >= STAT_MAX;
      b.node.toggleAttribute('disabled', maxed || this.points <= 0);
      b.pips.forEach((p, k) => {
        p.style.background = k < lvl ? b.color : 'rgba(255,255,255,0.16)';
      });
    });
  }

  // -------------------------------------------------------------------- HUD

  setLevel(level, xpRatio) {
    el('xpFill').style.width = (xpRatio * 100).toFixed(1) + '%';
    el('levelText').textContent = 'Lv ' + level + (this.points > 0 ? '  (+' + this.points + ')' : '');
  }

  setScore(score, ratio) {
    el('scoreFill').style.width = (ratio * 100).toFixed(1) + '%';
    el('scoreText').textContent = 'Score ' + score.toLocaleString();
  }

  setNameTag(name) { el('nameTag').textContent = name; }

  setNet(ping, fps) {
    el('pingVal').textContent = ping;
    el('fpsVal').textContent = fps;
  }

  setModeBanner(text) { el('modeBanner').textContent = text; }

  setLeaderboard(rows, selfId, mode, teamScores) {
    const list = el('lbList');
    list.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      if (r.id === selfId) li.className = 'me';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = r.boss ? TEAM_COLORS[TEAM.BOSS] : (TEAM_COLORS[r.team] || '#b6c2d4');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = r.name;
      const sc = document.createElement('span');
      sc.className = 'sc';
      sc.textContent = r.score.toLocaleString();
      li.appendChild(dot); li.appendChild(nm); li.appendChild(sc);
      list.appendChild(li);
    }

    const title = el('lbTitle');
    if (mode === 'tdm' && teamScores) {
      title.textContent = 'Blue ' + teamScores.blue.toLocaleString() + '  -  ' + teamScores.red.toLocaleString() + ' Red';
    } else {
      title.textContent = 'Leaderboard';
    }
  }

  setBossBar(info) {
    const bar = el('bossBar');
    if (!info) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    el('bossLabel').textContent = 'BOSS  ' + info.name;
    el('bossTimer').textContent = info.secondsLeft != null ? info.secondsLeft + 's' : '';
    el('bossFill').style.width = (Math.max(0, info.hp) * 100).toFixed(1) + '%';
  }

  addKill(killer, victim) {
    const box = el('killfeed');
    const d = document.createElement('div');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = killer;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = ' destroyed ';
    const vic = document.createElement('span');
    vic.textContent = victim;
    d.appendChild(k); d.appendChild(v); d.appendChild(vic);
    box.appendChild(d);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => d.remove(), 5200);
  }

  addChat(name, msg) {
    const log = el('chatLog');
    const d = document.createElement('div');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name + ': ';
    const body = document.createElement('span');
    body.textContent = msg;
    d.appendChild(who); d.appendChild(body);
    log.appendChild(d);
    while (log.children.length > 7) log.firstChild.remove();
    setTimeout(() => d.remove(), 22000);
  }

  toggleChat(open) {
    this.chatOpen = open;
    const input = el('chatInput');
    input.classList.toggle('hidden', !open);
    if (open) input.focus(); else input.blur();
    this.hooks.onChatState && this.hooks.onChatState(open);
  }

  toast(msg, kind) {
    const box = el('toast');
    const d = document.createElement('div');
    d.textContent = msg;
    if (kind) d.className = kind;
    box.appendChild(d);
    setTimeout(() => d.remove(), 3900);
  }
}
