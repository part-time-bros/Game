/**
 * ships.js — chassis and difficulty definitions.
 *
 * These are the base stats every run starts from; modules layer on top in
 * upgrades.js. Numbers are tuned so a clean wave-1 pilot kills a Skitter in
 * three hits and a Sentinel in about two seconds of sustained fire.
 */

export const SHIPS = {
  striker: {
    id: 'striker',
    name: 'STRIKER',
    role: 'ALL-ROUNDER',
    blurb: 'The service standard. Good guns, good legs, forgiving shield.',
    unlock: null,
    stats: {
      maxHull: 110, maxShield: 55, shieldRegen: 11, shieldDelay: 3.4,
      maxEnergy: 100, energyRegen: 17,
      moveSpeed: 25.5, accel: 128, drag: 4.4,
      dashCharges: 2, dashCooldown: 2.3, dashSpeed: 54, dashTime: 0.185,
      fireRate: 7.4, damage: 9.2, projectileSpeed: 68, spread: 0.030, projectiles: 1,
      critChance: 0.07, critMult: 2.0,
      pulseDamage: 40, pulseRadius: 10, pulseCost: 42, pulseCooldown: 0.85,
      magnetRadius: 7,
    },
    bars: { firepower: 0.62, mobility: 0.62, durability: 0.60 },
  },
  bastion: {
    id: 'bastion',
    name: 'BASTION',
    role: 'ASSAULT BRICK',
    blurb: 'Heavy plating and a wide nova pulse. Slow, mean, hard to kill.',
    unlock: 'Reach wave 5',
    stats: {
      maxHull: 155, maxShield: 80, shieldRegen: 15, shieldDelay: 3.0,
      maxEnergy: 115, energyRegen: 19,
      moveSpeed: 21.5, accel: 96, drag: 4.0,
      dashCharges: 2, dashCooldown: 2.9, dashSpeed: 46, dashTime: 0.2,
      fireRate: 5.6, damage: 14.5, projectileSpeed: 62, spread: 0.045, projectiles: 1,
      critChance: 0.05, critMult: 2.0,
      pulseDamage: 58, pulseRadius: 13.5, pulseCost: 40, pulseCooldown: 0.8,
      magnetRadius: 8,
    },
    bars: { firepower: 0.72, mobility: 0.34, durability: 0.92 },
  },
  phantom: {
    id: 'phantom',
    name: 'PHANTOM',
    role: 'GLASS SCALPEL',
    blurb: 'Three dash charges and a shredding cadence. One mistake is fatal.',
    unlock: 'Reach wave 10',
    stats: {
      maxHull: 78, maxShield: 42, shieldRegen: 13, shieldDelay: 2.6,
      maxEnergy: 120, energyRegen: 23,
      moveSpeed: 29.5, accel: 152, drag: 4.8,
      dashCharges: 3, dashCooldown: 1.85, dashSpeed: 60, dashTime: 0.17,
      fireRate: 11.0, damage: 6.4, projectileSpeed: 76, spread: 0.038, projectiles: 1,
      critChance: 0.13, critMult: 2.15,
      pulseDamage: 32, pulseRadius: 9, pulseCost: 38, pulseCooldown: 0.7,
      magnetRadius: 9,
    },
    bars: { firepower: 0.80, mobility: 0.95, durability: 0.30 },
  },
};

export const DIFFICULTIES = {
  recruit: {
    id: 'recruit', name: 'RECRUIT',
    hint: 'Softer hostiles and a generous shield. Learn the arena.',
    enemyHp: 0.78, enemyDamage: 0.70, enemySpeed: 0.94, spawnRate: 0.86,
    playerHp: 1.2, scoreMult: 0.75, refitTime: 16,
  },
  pilot: {
    id: 'pilot', name: 'PILOT',
    hint: 'The intended fight. Balanced pressure from wave one.',
    enemyHp: 1.0, enemyDamage: 1.0, enemySpeed: 1.0, spawnRate: 1.0,
    playerHp: 1.0, scoreMult: 1.0, refitTime: 14,
  },
  ace: {
    id: 'ace', name: 'ACE',
    hint: 'Tougher, faster, angrier. Bigger score, no slack.',
    enemyHp: 1.28, enemyDamage: 1.32, enemySpeed: 1.08, spawnRate: 1.18,
    playerHp: 0.9, scoreMult: 1.45, refitTime: 12,
  },
};

export const MODES = {
  campaign: { id: 'campaign', name: 'CAMPAIGN', hint: 'Fifteen waves, three bosses, one stabilizer. Survive to win.', waves: 15 },
  endless: { id: 'endless', name: 'ENDLESS', hint: 'No finish line. Scaling forever — how deep can you cut?', waves: Infinity, unlock: 'Win a campaign run' },
};

export function shipList() { return Object.values(SHIPS); }
export function difficultyList() { return Object.values(DIFFICULTIES); }
export function modeList() { return Object.values(MODES); }
