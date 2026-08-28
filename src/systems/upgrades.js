/**
 * upgrades.js — the module catalogue drafted between waves.
 *
 * A module is pure data: it declares how many times it can stack and mutates a
 * derived-stat object. The player recomputes stats from scratch (base ship +
 * every stack) whenever the loadout changes, so ordering never matters and
 * nothing can drift out of sync.
 */
import { clamp } from '../core/util.js';

const ICON = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  gauge: '<path d="M12 21a9 9 0 1 1 9-9" fill="none" stroke-width="2"/><path d="M12 12l5-4"/>',
  split: '<path d="M4 20 12 4l8 16" fill="none" stroke-width="2"/><path d="M12 4v16" stroke-width="2"/>',
  bounce: '<path d="M3 18c4-10 8 6 12-4s4 4 6 2" fill="none" stroke-width="2"/>',
  pierce: '<path d="M2 12h20" stroke-width="2"/><path d="M16 7l5 5-5 5" fill="none" stroke-width="2"/>',
  target: '<circle cx="12" cy="12" r="8" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="2"/>',
  chain: '<path d="M4 8l6 4-6 4" fill="none" stroke-width="2"/><path d="M13 6l6 6-6 6" fill="none" stroke-width="2"/>',
  battery: '<rect x="3" y="7" width="15" height="10" fill="none" stroke-width="2"/><path d="M19 10h2v4h-2z"/><path d="M7 12h7"/>',
  dash: '<path d="M3 12h9" stroke-width="2"/><path d="M13 5l7 7-7 7" fill="none" stroke-width="2"/>',
  flame: '<path d="M12 2c4 5 6 7 6 11a6 6 0 0 1-12 0c0-2 1-4 3-6 0 3 3 3 3 0z"/>',
  nova: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3" stroke-width="2"/>',
  heart: '<path d="M12 21S3 14 3 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 2.5C21 14 12 21 12 21z"/>',
  shield: '<path d="M12 2l8 3v7c0 5-4 8-8 10-4-2-8-5-8-10V5z" fill="none" stroke-width="2"/>',
  hull: '<path d="M4 6h16v12H4z" fill="none" stroke-width="2"/><path d="M4 12h16M10 6v12"/>',
  boom: '<path d="M12 2l2 6 6-2-4 5 5 4-6 1 1 6-4-4-4 4 1-6-6-1 5-4-4-5 6 2z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3" fill="none" stroke-width="2"/><path d="M3 14h15a3 3 0 1 1-3 3" fill="none" stroke-width="2"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" fill="none" stroke-width="2"/>',
  repair: '<path d="M12 5v14M5 12h14" stroke-width="3"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke-width="2"/><path d="M12 7v5l3 3" fill="none" stroke-width="2"/>',
  star: '<path d="M12 3l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16.9 6.4 20.2l1.5-6.3L3 9.7l6.4-.5z"/>',
  drone: '<circle cx="12" cy="12" r="3.5" fill="none" stroke-width="2"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>',
  speed: '<path d="M4 16h8M4 12h12M4 8h16" stroke-width="2"/>',
  armor: '<path d="M12 2l7 3v6c0 5-3 8-7 11-4-3-7-6-7-11V5z"/>',
  snow: '<path d="M12 2v20M4 7l16 10M20 7L4 17" stroke-width="2"/>',
  siphon: '<path d="M12 3a9 9 0 1 0 9 9h-9z" fill="none" stroke-width="2"/><path d="M12 3v9h9" fill="none" stroke-width="2"/>',
};

const RARITY = {
  common: { weight: 62, color: '#7fd4ff', label: 'STANDARD' },
  rare: { weight: 30, color: '#ff8ad0', label: 'ADVANCED' },
  epic: { weight: 10, color: '#ffc24a', label: 'PROTOTYPE' },
};

/** id -> module. `apply(stats, stacks)` runs once per draft recompute. */
export const MODULES = {
  overclock: {
    id: 'overclock', name: 'OVERCLOCK', rarity: 'common', max: 5, icon: ICON.gauge,
    desc: () => 'Weapon cadence +16%.',
    apply: (s, n) => { s.fireRate *= Math.pow(1.16, n); },
  },
  heavySlugs: {
    id: 'heavySlugs', name: 'HEAVY SLUGS', rarity: 'common', max: 5, icon: ICON.bolt,
    desc: () => 'Damage +22%, cadence −6%.',
    apply: (s, n) => { s.damage *= Math.pow(1.22, n); s.fireRate *= Math.pow(0.94, n); },
  },
  splitBarrel: {
    id: 'splitBarrel', name: 'SPLIT BARREL', rarity: 'rare', max: 3, icon: ICON.split,
    desc: () => '+1 projectile, −13% damage each.',
    apply: (s, n) => { s.projectiles += n; s.damage *= Math.pow(0.87, n); s.spread += 0.035 * n; },
  },
  ricochet: {
    id: 'ricochet', name: 'RICOCHET', rarity: 'rare', max: 2, icon: ICON.bounce,
    desc: () => 'Shots bounce to a new target once more.',
    apply: (s, n) => { s.ricochet += n; },
  },
  piercing: {
    id: 'piercing', name: 'PIERCING ROUNDS', rarity: 'rare', max: 3, icon: ICON.pierce,
    desc: () => 'Shots pass through +1 hostile.',
    apply: (s, n) => { s.pierce += n; },
  },
  homing: {
    id: 'homing', name: 'SEEKER CHIPS', rarity: 'rare', max: 2, icon: ICON.target,
    desc: () => 'Shots curve toward nearby hostiles.',
    apply: (s, n) => { s.homing += n * 2.6; },
  },
  chainArc: {
    id: 'chainArc', name: 'CHAIN ARC', rarity: 'epic', max: 3, icon: ICON.chain,
    desc: () => 'Hits arc to +1 nearby hostile for 45% damage.',
    apply: (s, n) => { s.chainCount += n; },
  },
  optics: {
    id: 'optics', name: 'PRECISION OPTICS', rarity: 'common', max: 4, icon: ICON.target,
    desc: () => 'Crit chance +8%, crit damage +0.15x.',
    apply: (s, n) => { s.critChance += 0.08 * n; s.critMult += 0.15 * n; },
  },
  battery: {
    id: 'battery', name: 'KINETIC BATTERY', rarity: 'common', max: 4, icon: ICON.battery,
    desc: () => 'Energy +25, recharge +5/s.',
    apply: (s, n) => { s.maxEnergy += 25 * n; s.energyRegen += 5 * n; },
  },
  phaseDrive: {
    id: 'phaseDrive', name: 'PHASE DRIVE', rarity: 'rare', max: 2, icon: ICON.dash,
    desc: () => '+1 dash charge, recharge 12% faster.',
    apply: (s, n) => { s.dashCharges += n; s.dashCooldown *= Math.pow(0.88, n); },
  },
  afterburn: {
    id: 'afterburn', name: 'AFTERBURN', rarity: 'rare', max: 3, icon: ICON.flame,
    desc: (n) => `Dash scorches a trail for ${Math.round(26 * n)} damage.`,
    apply: (s, n) => { s.afterburn += 26 * n; },
  },
  novaAmp: {
    id: 'novaAmp', name: 'NOVA AMPLIFIER', rarity: 'common', max: 4, icon: ICON.nova,
    desc: () => 'Nova pulse +35% damage, +18% radius.',
    apply: (s, n) => { s.pulseDamage *= Math.pow(1.35, n); s.pulseRadius *= Math.pow(1.18, n); },
  },
  vampiric: {
    id: 'vampiric', name: 'VAMPIRIC COILS', rarity: 'rare', max: 3, icon: ICON.heart,
    desc: (n) => `Each kill restores ${3 * n} hull.`,
    apply: (s, n) => { s.lifesteal += 3 * n; },
  },
  plating: {
    id: 'plating', name: 'REACTIVE PLATING', rarity: 'common', max: 4, icon: ICON.shield,
    desc: () => 'Shield +22, shield recharge +4/s.',
    apply: (s, n) => { s.maxShield += 22 * n; s.shieldRegen += 4 * n; },
  },
  hullWeave: {
    id: 'hullWeave', name: 'HULL WEAVE', rarity: 'common', max: 4, icon: ICON.hull,
    desc: () => 'Max hull +26 (and repairs the same).',
    apply: (s, n) => { s.maxHull += 26 * n; },
    onTake: (player) => { player.heal(26); },
  },
  volatile: {
    id: 'volatile', name: 'VOLATILE CORES', rarity: 'rare', max: 3, icon: ICON.boom,
    desc: (n) => `Slain hostiles detonate for ${Math.round(24 * n)} damage.`,
    apply: (s, n) => { s.explodeOnKill += 24 * n; },
  },
  adrenal: {
    id: 'adrenal', name: 'ADRENAL LINK', rarity: 'common', max: 4, icon: ICON.wind,
    desc: () => 'Move speed +9%, acceleration +8%.',
    apply: (s, n) => { s.moveSpeed *= Math.pow(1.09, n); s.accel *= Math.pow(1.08, n); },
  },
  scavenger: {
    id: 'scavenger', name: 'SCAVENGER FIELD', rarity: 'common', max: 3, icon: ICON.magnet,
    desc: () => 'Collection radius +60%, shard value +40%.',
    apply: (s, n) => { s.magnetRadius *= Math.pow(1.6, n); s.shardValue *= Math.pow(1.4, n); },
  },
  nanoRepair: {
    id: 'nanoRepair', name: 'NANO-REPAIR', rarity: 'rare', max: 3, icon: ICON.repair,
    desc: (n) => `Regenerate ${(1.2 * n).toFixed(1)} hull per second.`,
    apply: (s, n) => { s.regen += 1.2 * n; },
  },
  dilation: {
    id: 'dilation', name: 'TIME DILATION', rarity: 'epic', max: 1, icon: ICON.clock,
    desc: () => 'Dashing slows the world for a heartbeat.',
    apply: (s) => { s.slowmoOnDash = 0.34; },
  },
  odCapacitor: {
    id: 'odCapacitor', name: 'OD CAPACITOR', rarity: 'rare', max: 3, icon: ICON.star,
    desc: () => 'Overdrive charges 25% faster and lasts +1.2s.',
    apply: (s, n) => { s.overdriveGain *= Math.pow(1.25, n); s.overdriveDuration += 1.2 * n; },
  },
  guardian: {
    id: 'guardian', name: 'GUARDIAN DRONE', rarity: 'epic', max: 3, icon: ICON.drone,
    desc: () => 'Deploy an orbiting drone that fires on its own.',
    apply: (s, n) => { s.guardians += n; },
  },
  momentum: {
    id: 'momentum', name: 'MOMENTUM CORE', rarity: 'rare', max: 3, icon: ICON.speed,
    desc: () => 'Up to +12% damage while moving at full speed.',
    apply: (s, n) => { s.momentum += 0.12 * n; },
  },
  bulwark: {
    id: 'bulwark', name: 'BULWARK MESH', rarity: 'common', max: 4, icon: ICON.armor,
    desc: () => 'Incoming damage −7%.',
    apply: (s, n) => { s.damageReduction = 1 - Math.pow(0.93, n); },
  },
  cryo: {
    id: 'cryo', name: 'CRYO ROUNDS', rarity: 'rare', max: 3, icon: ICON.snow,
    desc: (n) => `Hits chill hostiles: −${Math.round(clamp(18 * n, 0, 55))}% speed.`,
    apply: (s, n) => { s.chill = clamp(0.18 * n, 0, 0.55); },
  },
  siphon: {
    id: 'siphon', name: 'SIPHON FIELD', rarity: 'epic', max: 1, icon: ICON.siphon,
    desc: () => 'Nova pulse converts each hit into 14 shield.',
    apply: (s) => { s.pulseSiphon = 14; },
  },
};

export const MODULE_LIST = Object.values(MODULES);
export const RARITY_INFO = RARITY;

/** Fresh derived-stat block from a chassis definition. */
export function baseStats(ship) {
  return {
    ...ship.stats,
    pierce: 0, ricochet: 0, homing: 0, chainCount: 0,
    lifesteal: 0, explodeOnKill: 0, afterburn: 0, guardians: 0, regen: 0,
    shardValue: 1, overdriveGain: 1, overdriveDuration: 6.0,
    momentum: 0, slowmoOnDash: 0, damageReduction: 0, chill: 0, pulseSiphon: 0,
  };
}

/**
 * Draft `count` distinct offers. Rarity weight drifts toward prototypes as the
 * run deepens, and maxed modules are excluded so a draft is never a dead pick.
 */
export function draftModules(rng, owned, count, wave, forceIds = null) {
  if (forceIds) return forceIds.map((id) => MODULES[id]).filter(Boolean);
  const pool = [];
  const depth = Math.min(1, wave / 12);
  for (const m of MODULE_LIST) {
    const have = owned.get(m.id) || 0;
    if (have >= m.max) continue;
    let w = RARITY[m.rarity].weight;
    if (m.rarity === 'epic') w *= 0.45 + depth * 1.5;
    if (m.rarity === 'rare') w *= 0.75 + depth * 0.6;
    if (have > 0) w *= 1.25;                 // gently encourage build focus
    pool.push({ m, weight: w });
  }
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    const pick = rng.weighted(pool, (p) => p.weight);
    out.push(pick.m);
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

export function moduleLabel(mod, stacks) {
  const next = (stacks || 0) + 1;
  return {
    name: mod.name,
    desc: typeof mod.desc === 'function' ? mod.desc(1) : mod.desc,
    rarity: RARITY[mod.rarity],
    stackText: stacks ? `INSTALLED ${stacks}/${mod.max} → ${next}` : (mod.max > 1 ? `0/${mod.max} INSTALLED` : 'UNIQUE'),
    icon: mod.icon,
  };
}
