# NOVA LANCE

A complete 3D hover-combat arena roguelite that runs in a browser tab.
Fifteen waves, three boss encounters, twenty-six stackable modules, three
chassis — and **not one asset file**. Every mesh, texture, sound effect and
note of the soundtrack is generated in code at load time.

![menu](docs/screenshots/01-menu.jpg)

---

## Run it

```bash
npm start          # static dev server -> http://localhost:8080
```

Any static server works — the project has **zero runtime dependencies** and no
build step for development. Open `index.html` through a server (ES modules need
HTTP, not `file://`).

**Single file:** `dist/nova-lance.html` is the whole game in one HTML file
(three.js from cdnjs, everything else inline). Open it, host it, mail it.

```bash
npm run build      # regenerate dist/nova-lance.html
npm test           # 52-check automated playtest in headless Chromium
```

## Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows / left stick | Thrusters |
| Mouse / right stick | Aim — the lance tracks your cursor |
| `LMB` / `RT` / right stick | Fire repeater |
| `RMB` / `E` / `X` | **Nova pulse** — radial blast that also deletes incoming bullets |
| `SPACE` / `SHIFT` / `RB` | **Phase dash** — invulnerable for the whole dash |
| `Q` / `F` / `Y` | **Overdrive** — when the meter is full |
| `ESC` / `P` / `Start` | Pause |
| `1` `2` `3` | Pick a module in the refit bay |
| `F1` | Performance readout |

Keyboard + mouse, gamepad (twin-stick with rumble) and touch (on-screen sticks)
are all first-class; the game switches between them automatically.

## The loop

1. **Fight a wave.** Hostiles arrive through telegraphed rifts in groups. Kill
   them all to clear the wave.
2. **Refit.** Draft one of three modules. They stack, and the draft biases
   toward what you already own so builds converge instead of scattering.
3. **Escalate.** Waves 5, 10 and 15 are bosses. Everything else gets tougher,
   faster and more numerous on a curve tuned against bot playtests.
4. **Bank the combo.** Kills chain a multiplier; taking damage cuts it. Shards
   and kills fill Overdrive, a six-second window of doubled cadence and an
   damage aura that turns a losing fight around.
5. **Win or die**, get ranked, unlock the next chassis, run it again.

![gameplay](docs/screenshots/07-gameplay-wave8.jpg)

## What is in the box

**Six enemy archetypes**, each attacking a different player habit:

| | Threat |
| --- | --- |
| **Skitter** | Swarm rusher. Lunges and detonates — punishes standing still. |
| **Drone** | Standoff gunnery. Orbits at range and chips — punishes passivity. |
| **Splitter** | Breaks into two Skitters on death — punishes greedy clears. |
| **Seeder** | Lobs mortars at where you are *going* — punishes camping. |
| **Lancer** | Winds up, then crosses the deck — punishes tunnel vision. |
| **Sentinel** | Paints a line, then deletes it — punishes lazy positioning. |

**Three bosses** with phase ladders, telegraphed attack scripts and distinct
mechanics — the Warden (orbital plates, spiral fire, arena slam), the Harrower
(sweeping beams, charge runs, minefields) and the Void Maw (jaw shockwaves,
void zones, a vacuum phase that exposes its eye as a weak point).

**Twenty-six modules** across three rarities: multishot, ricochet, pierce,
chain lightning, seekers, lifesteal, volatile cores, guardian drones, time
dilation on dash, siphon pulses, and more. Everything stacks and recomputes
from base stats, so no combination can desync.

**Three chassis** — Striker (balanced), Bastion (slow brick, wide pulse),
Phantom (three dashes, glass) — unlocked by reaching waves 5 and 10.
**Three threat levels** and an **Endless** mission unlocked by winning.

![refit](docs/screenshots/11-refit.jpg)

## Everything is procedural

| Asset | How it is made |
| --- | --- |
| Meshes | `MeshBuilder` composes primitives into one merged non-indexed geometry per model, carrying per-vertex colour and emissive attributes. One draw call per entity. |
| Deck | A two-tier hex lattice evaluated in the fragment shader, with travelling scan pulses and eight live impact ripples. |
| Sky | An equirectangular nebula painted once into a canvas: fbm cloud layers sampled on a circle (so it tiles), three star populations, cross flares. |
| Particles | Canvas-painted glow/smoke/shard sprites over a data-oriented `Points` system — one draw call per blend mode. |
| Sound | WebAudio synthesis: oscillators, filtered noise bursts and a procedural convolution reverb. Thirty-six distinct effects. |
| Music | A generative sequencer — drums, bass, arp and pads over a D-minor progression — whose layers, tempo and filter cutoffs follow combat intensity. |

## Architecture

```
index.html            markup + HUD/menu skeleton
src/
  main.js             bootstrap, WebGL/asset failure handling, debug surface
  game.js             state machine, frame loop, damage/score/explosion rules
  core/
    util.js           math, seeded RNG, object pools, rolling statistics
    input.js          keyboard+mouse / gamepad / touch -> one intent surface
    audio.js          synthesis engine + generative soundtrack
    save.js           settings and career record (storage-failure tolerant)
  render/
    renderer.js       WebGL setup + hand-written bloom & composite passes
    materials.js      the shader family (surface, floor, energy, particles…)
    models.js         every mesh in the game
    textures.js       every texture in the game
    world.js          arena assembly
    camera.js         chase rig with two-target boss framing
    particles.js      GPU particle systems + named effects
    vfx.js            rings, beams, telegraphs, debris, blob shadows, screen FX
  entities/           player, enemies + AI, projectiles, pickups, bosses
  systems/            ships, upgrade catalogue, wave director
  ui/                 screens, HUD, feedback, stylesheet
tools/
  serve.js            zero-dep dev server
  build.js            zero-dep bundler -> dist/nova-lance.html
  playtest.mjs        automated QA suite (52 checks)
  balance.mjs         scripted bot campaigns for tuning
  visual.mjs          staged scene capture for art review
  check.mjs           syntax check across all modules
```

Rendering is a bespoke pipeline because three.js's UMD build ships no
post-processing addons: the scene renders into an HDR target, a bright pass
feeds two blur levels, and one composite pass does bloom, ACES tone mapping,
sRGB encode, vignette, chromatic aberration, grain and the overdrive grade.

## Performance

Everything that spawns during play is pooled — projectiles, enemies, particles,
rings, decals, beams, debris, pickups and even the floating damage numbers.
A frame at wave 15 with a boss on screen costs **~56 draw calls**, and the
simulation runs in well under a millisecond of CPU. Quality auto-tunes down a
tier if the 90th-percentile frame time stays over budget.

## Testing

`npm test` boots the real game in headless Chromium and drives it through the
same input path a human uses:

- boot, every menu screen, and a scripted wave-1 fight
- all three boss encounters
- all 26 modules installed at once, checked for NaN
- refit draft, reroll, card pick, and the resume path
- pause/resume spam, death → results, boss kill → victory
- **a complete 15-wave campaign played end to end by a bot**
- resource-leak checks across 12 restarts (geometries, textures, DOM, scene graph)
- abuse passes: restart/dash/pulse/overdrive spam, wave 60, pickup floods,
  quality switching, viewport storms
- audio: all 36 effects and the music scheduler
- performance and draw-call budgets

`node tools/balance.mjs` runs bot campaigns at every difficulty and prints
wave-by-wave clear times, which is how the pacing above was tuned.

## Known limitations

- Bloom is a two-level Gaussian rather than a proper mip pyramid; on very wide
  displays the largest halos are slightly blocky at the Low quality tier.
- The soundtrack is generative, not composed — it never resolves to a chorus.
- Enemies path around obstacles by steering and separation, not a navmesh, so a
  Lancer occasionally clips a pillar corner during a charge (it stuns, which is
  the intended punish, but the collision reads as slightly abrupt).
- Touch play works and is tested, but the arena is genuinely harder on a phone
  than with a mouse; the camera does not compensate.
- Career progress lives in `localStorage`; private-mode browsers report this in
  Options and the run still plays normally.

## Licence

MIT. Built with [three.js](https://threejs.org) (MIT).
