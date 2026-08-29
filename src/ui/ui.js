/**
 * ui.js — every pixel of interface: screens, HUD, feedback.
 *
 * The HUD is DOM rather than in-world geometry: it stays crisp at any
 * resolution, costs no draw calls, and lets CSS do the animation work. All
 * per-frame writes are diffed against a cache so a steady frame touches the
 * DOM only when a value actually changes.
 */
import { clamp, clamp01, formatScore, formatTime, formatTimeMs, lerp } from '../core/util.js';
import { SHIPS, DIFFICULTIES, MODES, shipList, difficultyList, modeList } from '../systems/ships.js';
import { MODULES, moduleLabel, RARITY_INFO } from '../systems/upgrades.js';
import { ENEMY_LIST } from '../entities/enemies.js';

const $ = (id) => document.getElementById(id);

const CONTROLS = [
  ['W A S D', 'Thrusters (also arrow keys / left stick)'],
  ['MOUSE', 'Aim — the lance tracks your cursor'],
  ['LMB / RT', 'Fire repeater'],
  ['RMB / E', 'Nova pulse — clears bullets, knocks back'],
  ['SPACE', 'Phase dash — invulnerable while dashing'],
  ['Q / F', 'Overdrive — when the meter is full'],
  ['ESC / P', 'Pause'],
  ['1 2 3', 'Pick a module in the refit bay'],
  ['F1', 'Toggle performance readout'],
];

export class UI {
  constructor(game) {
    this.game = game;
    this.el = {};
    const ids = [
      'boot', 'boot-fill', 'boot-status', 'menu', 'hangar', 'options', 'manual', 'records',
      'refit', 'pause', 'results', 'hud', 'wave-label', 'wave-sub', 'wave-bar-fill',
      'score-value', 'combo-value', 'combo-bar-fill', 'boss-bar', 'boss-name', 'boss-fill',
      'boss-lag', 'boss-phase', 'hull-fill', 'hull-lag', 'hull-num', 'shield-fill', 'shield-num',
      'dash-charges', 'energy-fill', 'overdrive-bar', 'overdrive-fill', 'overdrive-label',
      'module-strip', 'crosshair', 'indicators', 'floaters', 'banner', 'toast-stack', 'perf',
      'damage-flash', 'overdrive-tint', 'ship-cards', 'difficulty-seg', 'difficulty-hint',
      'mode-seg', 'mode-hint', 'opt-list', 'keylist', 'codex', 'stat-grid', 'unlock-list',
      'upgrade-cards', 'refit-sub', 'refit-timer', 'reroll-btn', 'pause-stats', 'result-rank',
      'result-title', 'result-sub', 'result-stats', 'result-modules', 'menu-best', 'menu-tip',
      'menu-records-sub', 'menu-launch-sub', 'touch-controls', 'stick-move', 'stick-aim',
      'tbtn-dash', 'tbtn-pulse', 'tbtn-over', 'tbtn-pause',
    ];
    for (const id of ids) this.el[id] = $(id);

    this.screen = 'boot';
    this.prevScreen = null;
    this.cache = {};
    this.floatPool = [];
    this.indPool = [];
    this.bossVisible = false;
    this._bannerTimer = 0;
    this._selectedShip = 'striker';
    this._selectedDifficulty = 'pilot';
    this._selectedMode = 'campaign';
    this._cards = [];
    this._refitTimer = 0;
    this._hoverIndex = 0;

    this._buildStatic();
    this._bindActions();
  }

  // ==================================================================
  //  static content
  // ==================================================================
  _buildStatic() {
    this.el.keylist.innerHTML = CONTROLS.map(([k, d]) => `<li><kbd>${k}</kbd><span>${d}</span></li>`).join('');
    this.el.codex.innerHTML = ENEMY_LIST.map((t) => `
      <div class="codex-entry">
        <div class="codex-swatch" style="background:#${t.color.toString(16).padStart(6, '0')};color:#${t.color.toString(16).padStart(6, '0')}"></div>
        <div><h4>${t.name}</h4><p>${t.codex}</p></div>
      </div>`).join('');

    const seg = (host, items, selected, onPick, lockCheck) => {
      host.innerHTML = '';
      for (const it of items) {
        const b = document.createElement('button');
        b.textContent = it.name;
        b.dataset.id = it.id;
        if (it.id === selected) b.dataset.selected = '1';
        const locked = lockCheck ? lockCheck(it) : false;
        if (locked) { b.disabled = true; b.title = it.unlock || 'Locked'; }
        b.addEventListener('click', () => { this.click(); onPick(it.id); });
        b.addEventListener('pointerenter', () => this.hover());
        host.appendChild(b);
      }
    };
    this._seg = seg;
  }

  _bindActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      this.click();
      this.handleAction(a);
    });
    document.addEventListener('pointerenter', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.btn, .card, .ship-card, .segmented button')) this.hover();
    }, true);
  }

  handleAction(a) {
    const g = this.game;
    switch (a) {
      case 'to-hangar': this.showHangar(); break;
      case 'to-menu': g.toMenu(); break;
      case 'to-options': this.show('options'); this.buildOptions(); break;
      case 'to-options-ingame': this.prevScreen = 'pause'; this.show('options'); this.buildOptions(); break;
      case 'to-manual': this.show('manual'); break;
      case 'to-records': this.buildRecords(); this.show('records'); break;
      case 'back': this.back(); break;
      case 'start-run': g.startRun(this._selectedShip, this._selectedDifficulty, this._selectedMode); break;
      case 'resume': g.resume(); break;
      case 'restart': g.restartRun(); break;
      case 'abort': g.abortRun(); break;
      case 'retry': g.startRun(this._selectedShip, this._selectedDifficulty, this._selectedMode); break;
      case 'wipe-save': this.confirmWipe(); break;
      case 'reroll': g.rerollDraft(); break;
      default: break;
    }
  }

  // ==================================================================
  //  screens
  // ==================================================================
  show(name) {
    const cur = this.el[this.screen];
    if (cur) cur.removeAttribute('data-active');
    if (name && this.el[name]) {
      if (name !== this.screen) this.prevScreen = this.screen;
      this.el[name].setAttribute('data-active', '1');
    }
    this.screen = name;
    document.body.classList.toggle('playing', name === null);
    this.game.input.lock(0.2);
  }

  back() {
    const target = this.prevScreen && this.prevScreen !== 'boot' ? this.prevScreen : 'menu';
    if (target === 'pause') { this.show('pause'); this.prevScreen = null; }
    else if (target === 'hangar') this.showHangar();
    else this.show('menu');
  }

  hideAll() { this.show(null); }

  setHudVisible(v) { this.el.hud.hidden = !v; }

  showMenu() {
    this.show('menu');
    this.setHudVisible(false);
    const r = this.game.save.record;
    this.el['menu-best'].textContent = r.bestScore
      ? `BEST — ${formatScore(r.bestScore)} · WAVE ${r.bestWave}`
      : 'BEST — no runs logged';
    this.el['menu-records-sub'].textContent = r.runs ? `${r.runs} run${r.runs === 1 ? '' : 's'} · ${r.wins} won` : 'no runs logged';
    this.el['menu-launch-sub'].textContent = `${SHIPS[this._selectedShip].name} · ${DIFFICULTIES[this._selectedDifficulty].name}`;
    const tips = [
      'Tip: dash through fire — you are invulnerable mid-dash.',
      'Tip: the nova pulse deletes incoming bullets, not just enemies.',
      'Tip: Sentinels track you slowly while charging. Keep moving sideways.',
      'Tip: Lancers commit to a straight line. Sidestep, never backpedal.',
      'Tip: kills feed the overdrive meter. Bank it for a boss phase.',
      'Tip: shards top up overdrive — sweep the deck between spawns.',
      'Tip: pillars block enemy fire. Use them against Drones and Seeders.',
      'Tip: chained modules beat scattered ones. Commit to a build.',
    ];
    this.el['menu-tip'].textContent = tips[Math.floor(Math.random() * tips.length)];
  }

  showHangar() {
    this.buildHangar();
    this.show('hangar');
  }

  buildHangar() {
    const save = this.game.save;
    const host = this.el['ship-cards'];
    host.innerHTML = '';
    for (const ship of shipList()) {
      const unlocked = save.isShipUnlocked(ship.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ship-card';
      card.setAttribute('aria-pressed', String(ship.id === this._selectedShip));
      if (!unlocked) { card.dataset.locked = '1'; card.disabled = true; }
      if (ship.id === this._selectedShip && unlocked) card.dataset.selected = '1';
      const bar = (label, v) => `<div class="ship-stat"><span>${label}</span><i style="--v:${Math.round(v * 100)}%"></i></div>`;
      card.innerHTML = `
        ${unlocked ? '' : `<div class="lock-tag">LOCKED</div>`}
        <h4>${ship.name}</h4>
        <div class="role">${ship.role}</div>
        <div class="blurb">${unlocked ? ship.blurb : ship.unlock}</div>
        <div class="ship-stats">
          ${bar('GUNS', ship.bars.firepower)}
          ${bar('SPEED', ship.bars.mobility)}
          ${bar('ARMOR', ship.bars.durability)}
        </div>`;
      if (unlocked) {
        card.addEventListener('click', () => {
          this._selectedShip = ship.id;
          this.click();
          this.buildHangar();
        });
      }
      host.appendChild(card);
    }

    this._seg(this.el['difficulty-seg'], difficultyList(), this._selectedDifficulty, (id) => {
      this._selectedDifficulty = id;
      this.buildHangar();
    });
    this.el['difficulty-hint'].textContent = DIFFICULTIES[this._selectedDifficulty].hint;

    this._seg(this.el['mode-seg'], modeList(), this._selectedMode, (id) => {
      this._selectedMode = id;
      this.buildHangar();
    }, (m) => m.id === 'endless' && !save.record.endless);
    this.el['mode-hint'].textContent = MODES[this._selectedMode].hint
      + (this._selectedMode === 'endless' || save.record.endless ? '' : ' (locked)');
  }

  setLoadout(ship, difficulty, mode) {
    if (ship) this._selectedShip = ship;
    if (difficulty) this._selectedDifficulty = difficulty;
    if (mode && (mode !== 'endless' || this.game.save.record.endless)) this._selectedMode = mode;
  }

  buildOptions() {
    const s = this.game.save.settings;
    const host = this.el['opt-list'];
    host.innerHTML = '';
    const row = (label, control, valueText) => {
      const d = document.createElement('div');
      d.className = 'opt-row';
      d.innerHTML = `<label>${label}</label>`;
      d.appendChild(control);
      const out = document.createElement('output');
      out.textContent = valueText || '';
      d.appendChild(out);
      host.appendChild(d);
      return out;
    };
    const slider = (label, key, fmt = (v) => `${Math.round(v * 100)}%`, min = 0, max = 1, step = 0.05) => {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.value = s[key];
      const out = row(label, input, fmt(s[key]));
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.game.setSetting(key, v);
        out.textContent = fmt(v);
      });
      input.addEventListener('change', () => this.click());
    };
    const toggle = (label, key) => {
      const t = document.createElement('div');
      t.className = 'toggle';
      t.setAttribute('role', 'switch');
      t.tabIndex = 0;
      if (s[key]) t.dataset.on = '1';
      const flip = () => {
        const v = !t.hasAttribute('data-on');
        if (v) t.dataset.on = '1'; else t.removeAttribute('data-on');
        this.game.setSetting(key, v);
        this.click();
      };
      t.addEventListener('click', flip);
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      row(label, t, '');
    };
    const choice = (label, key, options) => {
      const wrap = document.createElement('div');
      wrap.className = 'segmented';
      for (const o of options) {
        const b = document.createElement('button');
        b.textContent = o.label;
        if (s[key] === o.value) b.dataset.selected = '1';
        b.addEventListener('click', () => {
          this.game.setSetting(key, o.value);
          this.click();
          this.buildOptions();
        });
        wrap.appendChild(b);
      }
      row(label, wrap, '');
    };

    slider('MASTER', 'master');
    slider('MUSIC', 'music');
    slider('EFFECTS', 'sfx');
    choice('QUALITY', 'quality', [
      { value: 'auto', label: 'AUTO' }, { value: 'low', label: 'LOW' },
      { value: 'medium', label: 'MED' }, { value: 'high', label: 'HIGH' },
    ]);
    slider('SCREEN SHAKE', 'shake', (v) => `${Math.round(v * 100)}%`, 0, 1.5, 0.05);
    toggle('DAMAGE NUMBERS', 'damageNumbers');
    toggle('SCANLINES', 'scanlines');
    toggle('SCREEN FLASHES', 'flashes');
    toggle('CAMERA LEAD', 'cameraRotate');
    toggle('PERF READOUT', 'showPerf');

    if (!this.game.save.available) {
      const warn = document.createElement('p');
      warn.style.cssText = 'margin-top:14px;color:#ffb347;font-size:13px';
      warn.textContent = 'Storage is unavailable in this browser context — settings and records will not persist.';
      host.appendChild(warn);
    }
  }

  confirmWipe() {
    const btn = document.querySelector('[data-action="wipe-save"]');
    if (!btn) return;
    if (btn.dataset.armed) {
      this.game.wipeSave();
      btn.textContent = 'WIPED';
      delete btn.dataset.armed;
      setTimeout(() => { btn.textContent = 'WIPE RECORD'; }, 1400);
    } else {
      btn.dataset.armed = '1';
      btn.textContent = 'CONFIRM WIPE?';
      setTimeout(() => {
        if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'WIPE RECORD'; }
      }, 3200);
    }
  }

  buildRecords() {
    const r = this.game.save.record;
    const stat = (k, v, sub) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}${sub ? ` <small>${sub}</small>` : ''}</div></div>`;
    this.el['stat-grid'].innerHTML = [
      stat('BEST SCORE', formatScore(r.bestScore)),
      stat('BEST WAVE', r.bestWave || '—'),
      stat('RUNS', r.runs),
      stat('VICTORIES', r.wins),
      stat('KILLS', formatScore(r.kills)),
      stat('TIME FLOWN', formatTime(r.playtime)),
      stat('BEST ENDLESS', r.bestEndlessWave || '—'),
      stat('FASTEST WIN', r.bestTime ? formatTime(r.bestTime) : '—'),
    ].join('');

    const unlocks = [
      { name: 'BASTION chassis', have: r.unlockedShips.includes('bastion'), how: 'Reach wave 5' },
      { name: 'PHANTOM chassis', have: r.unlockedShips.includes('phantom'), how: 'Reach wave 10' },
      { name: 'ENDLESS mission', have: r.endless, how: 'Win a campaign run' },
    ];
    this.el['unlock-list'].innerHTML = unlocks.map((u) =>
      `<div class="unlock${u.have ? '' : ' locked'}"><b>${u.have ? '◆' : '◇'} ${u.name}</b><span>${u.have ? 'unlocked' : u.how}</span></div>`).join('');
  }

  // ==================================================================
  //  refit draft
  // ==================================================================
  showRefit(wave, offers, rerolls, autoSeconds) {
    const host = this.el['upgrade-cards'];
    host.innerHTML = '';
    this._cards = [];
    this.el['refit-sub'].textContent = `Wave ${wave} cleared — install one module`;
    this._refitTimer = autoSeconds;
    this.el['reroll-btn'].textContent = `REROLL (${rerolls})`;
    this.el['reroll-btn'].disabled = rerolls <= 0;

    offers.forEach((mod, i) => {
      const owned = this.game.player.modules.get(mod.id) || 0;
      const info = moduleLabel(mod, owned);
      const card = document.createElement('button');
      card.className = 'card';
      card.style.setProperty('--tint', info.rarity.color);
      card.innerHTML = `
        <div class="rarity">${info.rarity.label}</div>
        <div class="glyph"><svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">${mod.icon}</svg></div>
        <h3>${info.name}</h3>
        <div class="desc">${info.desc}</div>
        <div class="stack">${info.stackText}</div>
        <div class="keyhint">${i + 1}</div>`;
      card.addEventListener('click', () => this.game.pickModule(mod.id));
      card.addEventListener('pointerenter', () => { this._hoverIndex = i; this.hover(); });
      host.appendChild(card);
      this._cards.push(card);
    });
    this._hoverIndex = 0;
    this.show('refit');
  }

  updateRefitTimer(dt) {
    if (this.screen !== 'refit') return;
    this._refitTimer -= dt;
    const t = Math.max(0, Math.ceil(this._refitTimer));
    this.el['refit-timer'].textContent = `AUTO-INSTALL IN ${t}`;
    if (this._refitTimer <= 0) {
      const idx = clamp(this._hoverIndex, 0, this._cards.length - 1);
      if (this._cards[idx]) this._cards[idx].click();
      this._refitTimer = 999;
    }
  }

  pickCardByIndex(i) {
    if (this.screen !== 'refit') return false;
    if (this._cards[i]) { this._cards[i].click(); return true; }
    return false;
  }

  // ==================================================================
  //  results
  // ==================================================================
  showResults(summary) {
    const g = this.game;
    this.setHudVisible(false);
    this.el['result-title'].textContent = summary.victory ? 'STABILIZER HELD' : 'LANCE DESTROYED';
    this.el['result-rank'].textContent = summary.rank;
    this.el['result-rank'].style.color = summary.victory ? '#7dff9e' : '#ffc24a';
    this.el['result-sub'].textContent = summary.victory
      ? `${MODES[summary.mode].name} · ${DIFFICULTIES[summary.difficulty].name} · ${SHIPS[summary.ship].name}`
      : `Fell on wave ${summary.wave} · ${DIFFICULTIES[summary.difficulty].name} · ${SHIPS[summary.ship].name}`;

    const stat = (k, v, sub) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}${sub ? ` <small>${sub}</small>` : ''}</div></div>`;
    const acc = summary.shotsFired > 0 ? Math.round((summary.shotsHit / summary.shotsFired) * 100) : 0;
    this.el['result-stats'].innerHTML = [
      stat('SCORE', formatScore(summary.score)),
      stat('WAVE', summary.wave),
      stat('KILLS', summary.kills),
      stat('TIME', formatTimeMs(summary.time)),
      stat('ACCURACY', `${acc}%`),
      stat('BEST COMBO', `x${summary.bestCombo.toFixed(1)}`),
      stat('DAMAGE DEALT', formatScore(summary.damageDealt)),
      stat('DAMAGE TAKEN', formatScore(summary.damageTaken)),
    ].join('');

    const mods = [...summary.modules.entries()].map(([id, n]) => {
      const m = MODULES[id];
      return `<span style="border-color:${RARITY_INFO[m.rarity].color}55;color:${RARITY_INFO[m.rarity].color}">${m.name}${n > 1 ? ` ×${n}` : ''}</span>`;
    });
    const unlockLines = (summary.unlocked || []).map((u) => `<span style="border-color:#7dff9e;color:#7dff9e">UNLOCKED — ${u}</span>`);
    this.el['result-modules'].innerHTML = unlockLines.concat(mods).join('');
    this.show('results');
  }

  showPauseStats() {
    const g = this.game;
    const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    this.el['pause-stats'].className = 'stat-grid';
    this.el['pause-stats'].innerHTML = [
      stat('WAVE', g.waves.wave),
      stat('SCORE', formatScore(g.score)),
      stat('KILLS', g.runStats.kills),
      stat('TIME', formatTime(g.runTime)),
    ].join('');
  }

  // ==================================================================
  //  HUD
  // ==================================================================
  setWave(n, total) {
    this.el['wave-label'].textContent = `WAVE ${n}${Number.isFinite(total) ? ` / ${total}` : ''}`;
  }

  setWaveProgress(p) {
    const v = `${clamp01(p) * 100}%`;
    if (this.cache.waveProg !== v) { this.cache.waveProg = v; this.el['wave-bar-fill'].style.width = v; }
  }

  update(dt, player, game) {
    if (this.el.hud.hidden) return;
    const c = this.cache;

    // vitals
    const hull = Math.ceil(player.hull);
    if (c.hull !== hull) {
      c.hull = hull;
      this.el['hull-num'].textContent = hull;
      const pct = `${player.hullPct * 100}%`;
      this.el['hull-fill'].style.width = pct;
      this.el['hull-lag'].style.width = pct;
    }
    const shield = Math.ceil(player.shield);
    if (c.shield !== shield) {
      c.shield = shield;
      this.el['shield-num'].textContent = shield;
      this.el['shield-fill'].style.width = `${player.shieldPct * 100}%`;
    }
    const en = Math.round(player.energyPct * 100);
    if (c.energy !== en) { c.energy = en; this.el['energy-fill'].style.width = `${en}%`; }
    const od = Math.round(player.overdrivePct * 100);
    if (c.od !== od) {
      c.od = od;
      this.el['overdrive-fill'].style.width = `${od}%`;
      const ready = od >= 100 && player.overdriveActive <= 0;
      this.el['overdrive-bar'].classList.toggle('ready', ready);
      this.el['overdrive-label'].textContent = player.overdriveActive > 0 ? 'OVERDRIVE ACTIVE'
        : ready ? 'OVERDRIVE — PRESS Q' : 'OVERDRIVE';
    }

    // dash pips
    const maxDash = player.stats.dashCharges;
    if (c.maxDash !== maxDash) {
      c.maxDash = maxDash;
      this.el['dash-charges'].innerHTML = Array.from({ length: maxDash }, () => '<i class="dash-pip"></i>').join('');
      c.dashState = null;
    }
    const partial = player.dashCharge < maxDash
      ? clamp01(player.dashRecharge / (player.stats.dashCooldown || 1)) : 0;
    const dashKey = `${player.dashCharge}:${Math.round(partial * 10)}`;
    if (c.dashState !== dashKey) {
      c.dashState = dashKey;
      const pips = this.el['dash-charges'].children;
      for (let i = 0; i < pips.length; i++) {
        const pip = pips[i];
        pip.className = 'dash-pip';
        if (i < player.dashCharge) pip.classList.add('full');
        else if (i === player.dashCharge && partial > 0) {
          pip.classList.add('charging');
          pip.style.setProperty('--p', `${partial * 100}%`);
        }
      }
    }

    // score / combo
    const score = Math.floor(game.displayScore);
    if (c.score !== score) { c.score = score; this.el['score-value'].textContent = formatScore(score); }
    const combo = game.combo;
    const comboText = `x${combo.toFixed(1)}`;
    if (c.combo !== comboText) {
      c.combo = comboText;
      this.el['combo-value'].textContent = comboText;
      this.el['combo-value'].classList.add('bump');
      clearTimeout(this._comboTimer);
      this._comboTimer = setTimeout(() => this.el['combo-value'].classList.remove('bump'), 120);
    }
    const comboBar = combo > 1 ? clamp01(game.comboTimer / game.comboWindow) : 0;
    const cb = `${comboBar * 100}%`;
    if (c.comboBar !== cb) { c.comboBar = cb; this.el['combo-bar-fill'].style.width = cb; }

    // hostiles remaining
    const alive = game.enemies.threatCount;
    const sub = game.waves.state === 'boss' ? 'BOSS ENGAGED'
      : game.waves.state === 'cleared' ? 'DECK CLEAR'
        : `HOSTILES ${alive}`;
    if (c.waveSub !== sub) { c.waveSub = sub; this.el['wave-sub'].textContent = sub; }

    // crosshair follows the aim point
    if (game.aimScreen && !game.input.hasTouch) {
      this.el.crosshair.style.transform = `translate(${game.aimScreen.x}px, ${game.aimScreen.y}px)`;
    }

    this._updateIndicators(game);
    this._updateModuleStrip(player);
  }

  _updateModuleStrip(player) {
    const key = [...player.modules.entries()].map(([k, v]) => `${k}${v}`).join(',');
    if (this.cache.mods === key) return;
    this.cache.mods = key;
    const host = this.el['module-strip'];
    host.innerHTML = [...player.modules.entries()].map(([id, n]) => {
      const m = MODULES[id];
      const color = RARITY_INFO[m.rarity].color;
      return `<div class="mod-chip" style="color:${color}"><i></i><b>${m.name}</b>${n > 1 ? ` ×${n}` : ''}</div>`;
    }).join('');
  }

  /** Edge arrows for threats you cannot see. */
  _updateIndicators(game) {
    const w = game.width, h = game.height;
    const margin = 42;
    const list = [];
    if (game.boss.active) list.push({ x: game.boss.x, z: game.boss.z, y: game.boss.y, cls: 'boss' });
    const enemies = game.enemies.active;
    for (let i = 0; i < enemies.length && list.length < 10; i++) {
      const e = enemies[i];
      if (e.dying || e.type.hidden) continue;
      list.push({ x: e.x, z: e.z, y: e.y, cls: '' });
    }
    let used = 0;
    for (const t of list) {
      const p = game.camera.worldToScreen(t.x, t.y, t.z, w, h);
      const off = p.behind || p.x < margin || p.x > w - margin || p.y < margin || p.y > h - margin;
      if (!off) continue;
      let dx = p.x - w / 2, dy = p.y - h / 2;
      if (p.behind) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy) || 1;
      const maxX = w / 2 - margin, maxY = h / 2 - margin;
      const scale = Math.min(maxX / Math.abs(dx || 0.001), maxY / Math.abs(dy || 0.001));
      const sx = w / 2 + dx * scale, sy = h / 2 + dy * scale;
      const el = this._indicator(used++);
      el.className = `ind ${t.cls}`;
      el.style.transform = `translate(${sx}px, ${sy}px) rotate(${Math.atan2(dy, dx) + Math.PI / 2}rad)`;
      el.style.display = '';
    }
    for (let i = used; i < this.indPool.length; i++) this.indPool[i].style.display = 'none';
  }

  _indicator(i) {
    while (this.indPool.length <= i) {
      const d = document.createElement('div');
      d.className = 'ind';
      this.el.indicators.appendChild(d);
      this.indPool.push(d);
    }
    return this.indPool[i];
  }

  // ==================================================================
  //  feedback
  // ==================================================================
  floatText(worldPos, text, cls = '') {
    if (!this.game.save.settings.damageNumbers && (cls === '' || cls === 'crit')) return;
    const g = this.game;
    const p = g.camera.worldToScreen(worldPos.x, (worldPos.y || 1) + 1.4, worldPos.z, g.width, g.height);
    if (p.behind) return;
    const el = this.floatPool.pop() || document.createElement('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    this.el.floaters.appendChild(el);
    const done = () => {
      el.removeEventListener('animationend', done);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (this.floatPool.length < 40) this.floatPool.push(el);
    };
    el.addEventListener('animationend', done);
    // safety net in case the animation event never fires (tab hidden)
    setTimeout(done, 1500);
  }

  damageNumber(worldPos, amount, crit) {
    this.floatText(worldPos, crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`, crit ? 'crit' : '');
  }

  banner(line, sub = '', cls = '') {
    const host = this.el.banner;
    host.innerHTML = `<div class="banner-line ${cls}">${line}</div>${sub ? `<div class="banner-line sub">${sub}</div>` : ''}`;
    clearTimeout(this._bannerTimeout);
    this._bannerTimeout = setTimeout(() => { host.innerHTML = ''; }, 1950);
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.el['toast-stack'].appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2700);
  }

  damageFlash(severity) {
    if (!this.game.save.settings.flashes) return;
    const el = this.el['damage-flash'];
    el.classList.add('hit');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => el.classList.remove('hit'), 60);
  }

  setCritical(on) {
    if (!this.game.save.settings.flashes) { this.el['damage-flash'].classList.remove('critical'); return; }
    this.el['damage-flash'].classList.toggle('critical', on);
  }

  setOverdrive(on) {
    this.el['overdrive-tint'].classList.toggle('on', on && this.game.save.settings.flashes);
    this.el.crosshair.classList.toggle('od', on);
  }

  overdriveReady() {
    const now = performance.now();
    if (this._odToast && now - this._odToast < 4000) return;
    this._odToast = now;
    this.toast('OVERDRIVE READY — Q', 'warn');
  }
  flashEnergy() { this.el['energy-fill'].animate([{ filter: 'brightness(2.4)' }, { filter: 'none' }], { duration: 260 }); }
  flashOverdrive() { this.el['overdrive-bar'].animate([{ filter: 'brightness(2.4)' }, { filter: 'none' }], { duration: 260 }); }

  hitMarker(kill) {
    const c = this.el.crosshair;
    c.classList.add(kill ? 'kill' : 'hit');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => c.classList.remove('hit', 'kill'), kill ? 130 : 80);
  }

  showBoss(name, pct, phase) {
    this.el['boss-bar'].hidden = false;
    this.el['boss-name'].textContent = name;
    this.el['boss-phase'].textContent = phase;
    this.setBossHealth(pct);
    this.bossVisible = true;
  }

  setBossHealth(pct) {
    const v = `${clamp01(pct) * 100}%`;
    this.el['boss-fill'].style.width = v;
    this.el['boss-lag'].style.width = v;
  }

  setBossPhase(text) { this.el['boss-phase'].textContent = text; }
  hideBoss() { this.el['boss-bar'].hidden = true; this.bossVisible = false; }

  setPerf(text, visible) {
    const el = this.el.perf;
    el.hidden = !visible;
    if (visible) el.textContent = text;
  }

  setBootProgress(p, label) {
    this.el['boot-fill'].style.width = `${clamp01(p) * 100}%`;
    if (label) this.el['boot-status'].textContent = label;
  }

  setTouch(on) {
    this.el['touch-controls'].hidden = !on;
    document.body.classList.toggle('touch', on);
  }

  hover() { this.game.audio.play('uiHover'); }
  click() { this.game.audio.play('uiClick'); }

  clearTransient() {
    this.el.floaters.innerHTML = '';
    this.el['toast-stack'].innerHTML = '';
    this.el.banner.innerHTML = '';
    for (const el of this.indPool) el.style.display = 'none';
    this.floatPool.length = 0;
    this.setCritical(false);
    this.setOverdrive(false);
    this.hideBoss();
    this.cache = {};
  }
}
