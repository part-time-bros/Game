/**
 * save.js — settings + career record persisted to localStorage.
 * Every access is guarded: private-mode browsers throw on access, and the game
 * must run identically with storage completely unavailable.
 */

const KEY = 'nova-lance/v1';

const DEFAULT_SETTINGS = {
  master: 0.85,
  music: 0.6,
  sfx: 0.9,
  quality: 'auto',      // auto | low | medium | high
  shake: 1.0,
  damageNumbers: true,
  scanlines: true,
  flashes: true,
  showPerf: false,
  cameraRotate: true,   // camera eases toward aim direction
};

const DEFAULT_RECORD = {
  runs: 0,
  wins: 0,
  kills: 0,
  bestWave: 0,
  bestScore: 0,
  bestEndlessWave: 0,
  bestTime: 0,          // fastest victory, seconds
  playtime: 0,
  deaths: 0,
  lastShip: 'striker',
  lastDifficulty: 'pilot',
  lastMode: 'campaign',
  unlockedShips: ['striker'],
  endless: false,
  seenIntro: false,
};

function readRaw() {
  try {
    const s = window.localStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}

export class SaveData {
  constructor() {
    this.available = true;
    this.settings = { ...DEFAULT_SETTINGS };
    this.record = { ...DEFAULT_RECORD };
    this.load();
  }

  load() {
    const raw = readRaw();
    if (!raw) {
      // Probe once so the UI can tell the player their progress will not stick.
      try {
        window.localStorage.setItem(KEY + '/probe', '1');
        window.localStorage.removeItem(KEY + '/probe');
      } catch (e) { this.available = false; }
      return;
    }
    if (raw.settings) {
      for (const k in DEFAULT_SETTINGS) {
        if (raw.settings[k] !== undefined && typeof raw.settings[k] === typeof DEFAULT_SETTINGS[k]) {
          this.settings[k] = raw.settings[k];
        }
      }
    }
    if (raw.record) {
      for (const k in DEFAULT_RECORD) {
        const v = raw.record[k];
        if (v === undefined) continue;
        if (Array.isArray(DEFAULT_RECORD[k])) { if (Array.isArray(v)) this.record[k] = v.slice(); }
        else if (typeof v === typeof DEFAULT_RECORD[k]) this.record[k] = v;
      }
    }
    if (!this.record.unlockedShips.includes('striker')) this.record.unlockedShips.push('striker');
  }

  save() {
    if (!this.available) return false;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ v: 1, settings: this.settings, record: this.record }));
      return true;
    } catch (e) {
      this.available = false;
      return false;
    }
  }

  set(key, value) { this.settings[key] = value; this.save(); }

  isShipUnlocked(id) { return this.record.unlockedShips.includes(id); }
  unlockShip(id) {
    if (this.record.unlockedShips.includes(id)) return false;
    this.record.unlockedShips.push(id);
    this.save();
    return true;
  }

  /**
   * Fold a finished run into the career record.
   * Returns the list of things newly unlocked so the results screen can shout about them.
   */
  commitRun(summary) {
    const r = this.record;
    const unlocked = [];
    r.runs++;
    r.kills += summary.kills || 0;
    r.playtime += summary.time || 0;
    if (!summary.victory) r.deaths++;
    if (summary.mode === 'endless') {
      if (summary.wave > r.bestEndlessWave) r.bestEndlessWave = summary.wave;
    } else if (summary.wave > r.bestWave) r.bestWave = summary.wave;
    if (summary.score > r.bestScore) r.bestScore = Math.floor(summary.score);
    if (summary.victory) {
      r.wins++;
      if (!r.bestTime || summary.time < r.bestTime) r.bestTime = summary.time;
    }
    const reachedWave = summary.wave;
    if (reachedWave >= 5 && !r.unlockedShips.includes('bastion')) { r.unlockedShips.push('bastion'); unlocked.push('BASTION chassis'); }
    if ((reachedWave >= 10 || summary.victory) && !r.unlockedShips.includes('phantom')) { r.unlockedShips.push('phantom'); unlocked.push('PHANTOM chassis'); }
    if (summary.victory && !r.endless) { r.endless = true; unlocked.push('ENDLESS mission'); }
    r.lastShip = summary.ship || r.lastShip;
    r.lastDifficulty = summary.difficulty || r.lastDifficulty;
    r.lastMode = summary.mode || r.lastMode;
    this.save();
    return unlocked;
  }

  wipe() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.record = { ...DEFAULT_RECORD, unlockedShips: ['striker'] };
    try { window.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }
}

export const save = new SaveData();
