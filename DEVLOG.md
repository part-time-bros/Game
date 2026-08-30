# NOVA LANCE — development log

`README.md` describes **what the game is**. This file describes **how it got
that way**: the decisions that would be expensive to re-derive, the bugs whose
root causes were not obvious, and what each guard in the test suite is actually
protecting. It is written for whoever — or whatever — picks this up next.

---

## Start here

**The project.** A 3D arena roguelite that runs in a browser. Zero runtime
dependencies beyond three.js; every mesh, texture, sound and note is generated
in code at load time. There are no asset files. The art direction is a western
canyon at golden hour.

**Orient yourself in five minutes:**

```bash
npm run check      # every module parses, every named import resolves
npm run verify     # build, then boot AND PLAY all three builds (~20s)
npm test           # the full suite, 113 checks (~12 min, runs a whole campaign)
npm run test:quick # the same minus the campaign (~4 min)
npm run shots      # render diagnostic scenes to docs/shots-visual/
```

If `npm run verify` passes, the game works. If you change rendering, look at
`npm run shots -- arena wall rocks` before and after — a screenshot catches
things no assertion will.

**The three builds must all work.** `index.html` loads ES modules from `src/`
directly; `dist/nova-lance.html` is a single self-contained file; the artifact
build is the same wrapped for hosting. The bundler strips imports and
concatenates, so anything import-shaped that survives into a name is a hazard.
A bundle-only crash has shipped once. `npm run verify` is the gate that exists
because of it.

---

## Invariants

Things that are true on purpose. Breaking one will look like it works and fail
somewhere far away.

| Invariant | Where | Why |
| --- | --- | --- |
| Every file under `src/` appears in `ORDER` in `tools/build.js` | `assertComplete()` throws otherwise | The bundle ships silently broken otherwise |
| The camera azimuth is never driven by anything derived from the camera azimuth | `camera.js` `LEAN_MAX` | Closes a feedback loop; see **The spin** below |
| Props are seated by measuring their bounding box, never by a guessed offset | `terrain.js` `seat()` | See **Floating rocks** below |
| The ground mesh stays just *below* y=0 inside the play radius | `terrain.js` `buildGround` | The simulation treats the ground as the y=0 plane |
| Everything spatial derives from `ARENA_RADIUS` | `world.js` | Resizing the arena is one number; two places that did not derive from it were bugs |
| Injected GLSL locals are prefixed `nova*` / `f*` | `materials.js` | They share a scope with three's own chunk internals |
| Materials write to `diffuseColor`, never `gl_FragColor` | `materials.js` | Writing the latter skips shadows, IBL, the BRDF, fog and tone mapping |

---

## Architecture decisions worth not re-litigating

**three.js 0.160.0, vendored, UMD.** The last version shipping a UMD global
build. That matters because the single-file bundle has no module loader and the
artifact host allows scripts only from an allowlist of CDNs. Addons (including
`BufferGeometryUtils`) are *not* in the UMD build, which is why `terrain.js`
hand-rolls `mergeGeometries` and `weld`.

**Everything procedural.** Not a purity exercise — it is what makes a whole game
in one ~560KB file possible, and it means an art-direction change is a code
change rather than a re-export.

**One draw call per entity.** `MeshBuilder` merges primitives into a single
non-indexed geometry carrying `aColor` (per-vertex albedo) and `aEmit`
(per-vertex emissive). One material paints a whole model.

**Rigid-bind skinning, one bone per vertex.** `rig.js` puts an `aBone` index on
each vertex and a `uBones[]` uniform array in the shader. No weights, no
inverse-bind matrices — a pose is one matrix multiply. Enough for hard-surface
models, and it keeps an articulated model at one draw call.

**Hand-written post chain.** HDR target → bright pass → two blur levels →
composite. AgX tone mapping *with its look transform* — the sigmoid alone is
deliberately flat and desaturated, which is a trap worth knowing about.

**Custom shaders extend `MeshStandardMaterial` via `onBeforeCompile`.** They do
not replace it. This was the single biggest visual change in the project's
history; see **The PBR migration** below.

---

## The log

Every commit that changed the game, in order. Each entry is: what was asked,
what was actually wrong, what was done, and how it was checked.

### 1. Build the game (`af83901`)

A complete arena roguelite from nothing: engine, procedural assets, six enemy
archetypes, three bosses, fifteen waves, upgrades, UI, audio, and a Playwright
harness. The harness existed from day one, which is the only reason the later
rewrites were safe.

### 2–7. Hardening (`9c657c3` … `9211b08`)

Sim robustness, onboarding, touch input, floater caps, and the audio mix.

**The audio mix was balanced by measurement, not by ear**, because there is no
ear here. `tools/audiomix.mjs` renders every effect through an
`OfflineAudioContext` and prints peak, RMS and audible duration. It found three
effectively-silent cues and an enemy-louder-than-the-player imbalance. This
approach — *build an instrument when you cannot perceive the thing you are
judging* — recurs throughout and is the most transferable idea in the project.

### 8–12. Animation and cinematics (`3b55842` … `e2fdc71`)

Skeletal animation, a rigged cast, rigged bosses, a cinematic layer, and a
combat feedback pass.

**Bug: a bundle-only crash.** Fixed, and it is why `npm run verify` exists.

### 13. The publish gate (`462fca8`)

`verify-bundle.mjs`: builds, then boots *and plays* all three builds.

### 14. Mobile black screen (`4e11c91`)

**Reported:** the HUD rendered over a completely black viewport on Android.

**Root cause:** the HDR render target type was chosen from `isWebGL2`. Some
devices report WebGL 2 but cannot actually *render* to half-float. The
capability was assumed rather than tested.

**Fix:** `_probeHalfFloat()` — an extension check *plus* a real framebuffer
completeness probe — and a three-stage degrade ladder, with a watchdog that
samples frames and demotes the pipeline if they come back empty.

**Gotcha found while building it:** the watchdog demoted the pipeline during
the deliberate context-loss test. `if (err === gl.CONTEXT_LOST_WEBGL) return;`.

### 15. Camera rigs (`6d4d495`)

**Reported:** "the viewing angle is from upwards so it feels like 2D".

Three rigs — `pov`, `chase`, `tactical` — differing in pitch, distance, FOV and
whether the rig turns. Plus a horizontal-FOV cap: a 70° vertical rig on a 21:9
phone is a 113° fisheye where the ship is a speck.

### 16. Backwards-facing rigs (`3b57a8f`)

**Reported:** "the shooting happens via back of spaceship".

**Root cause:** `MeshBuilder.build(name, faceZ)` spins a model 180° at build
time because parts are authored nose-toward-−Z. `RigBuilder.build()` never
received `faceZ`. Every rigged model — which, after the animation work, meant
*every* model — flew and fired tail-first.

**Fix:** rotate the root bone rather than the vertices.

### 17. Western conversion (`8768421`)

Art direction pivot, chosen by the user from four options: full western
setting. World, lighting and palette converted to a canyon at golden hour.

### 18. The PBR migration (`4a073cf`)

**Reported:** "the arena looks trash… I need the proper graphics." With an
instruction to research rather than guess.

**What the research established:** WebGPU would *not* have helped. The gap was
rendering *features*, not API throughput. The actual cause was architectural —
hand-rolled `ShaderMaterial`s were bypassing three's entire lighting pipeline.

**Fix:** every surface material became `MeshStandardMaterial` +
`onBeforeCompile`, writing into `diffuseColor` so shadows, IBL, the BRDF, fog
and tone mapping all apply for free. Added a real `DirectionalLight` with
`PCFSoftShadowMap`, image-based lighting via `PMREMGenerator` from the already
baked sky, and AgX tone mapping.

**Calibration notes** (three's light units are not the old hand-rolled
lambert's): sun 3.1 → 1.95, hemisphere 0.55 → 0.18, environment 0.85 → 0.30,
exposure 1.0 → 0.55.

**Bugs found on the way, all instructive:**

- **AgX came out milky.** The sigmoid was implemented but not the look
  transform. Contrast and saturation live in the look.
- **`scene.fog` was never set.** `fog: true` on a material does nothing on its
  own.
- **`patch` is a GLSL reserved word.** The floor shader would not compile.
  Caught only because an `onShaderError` reporter had been added.
- **`dxy` and `det` collided with three's chunk internals.** Hence the `nova*`
  prefix rule.
- **Block rewrites sliced just after `export`,** silently un-exporting four
  symbols. `node --check` parses files in isolation and is blind to this, so
  `tools/check.mjs` now verifies every named import resolves at the other end.

### 19. Landform terrain (`6bacaa4`)

**Reported:** "make it proper game graphics not boxy and cylinders".

**What was actually there:** the canyon was 64 five-sided cylinder slabs, the
spires were stacked tapered cylinders, the mesas were cylinders with a talus
shoulder, the floor was a flat disc. A cylinder is a cylinder from every angle.

**New `src/render/terrain.js`.** Landforms generated rather than assembled:

- `buildRock` — dense icosphere, welded so it can shade smooth, displaced by
  fbm plus a squared ridged term, stepped along bedding planes, then **sliced
  against 6–9 fracture planes**. The planes are the important part; noise alone
  only ever makes blobs. The first attempt without them produced potatoes.
- `buildCanyon` — one continuous displaced surface: alcoves at the largest
  scale, ~29 gullies around the ring, buttresses between them, bedding shelves
  whose frequency **drifts with angle** so they do not line up into a layer
  cake. Gullies are cut with a *soft minimum* so the wall can never reach past
  the play radius and swallow the player.
- `buildBranchTree` / `buildSaguaro` — tapering tubes swept along bent spines,
  so limbs flow out of their parent instead of telescoping. The saguaro's
  cross-section is fluted; that is most of what makes it read as a cactus.

**Two shading changes did as much work as the geometry:**

- **Baked cavity occlusion.** Each point's radius is compared against a local
  average of its neighbours and darkened if it sits behind them. The sun only
  ever lights one side of a ring — without this, the relief was invisible on
  the other three. This was the fix for "the wall still looks like a smooth
  curtain".
- **Triplanar derivative bump** (Mikkelsen). Below the size of a triangle,
  relief has to come from the normal. No UVs, no tangents. **Fades with
  distance** — a derivative bump has no mip chain and turns to speckle at range.

**Diagnostic method that mattered:** when the rocks came out smooth, extracting
the noise functions into a standalone script and measuring the displacement
range proved the noise was fine and the *sampling* was the problem — the
icosphere at detail 3 could not represent the frequencies being asked of it, so
the high octaves aliased into a smooth ovoid.

### 20. Spin and floating props (`36eb8a8`)

Two bugs reported from play.

#### The spin — "the vehicle keeps spinning and spinning"

**Root cause: a closed feedback loop.** The aim stick is expressed relative to
the camera. `Input.sample()` rotates the raw stick reading by `rigYaw` to get a
world direction; the ship turns to face it; the rig then damped toward the
ship's yaw. So the stick's world direction is *rig + stickAngle*, the ship
follows it, the rig follows the ship, and next frame the same held stick points
somewhere new again. **For any stick angle off screen-up there is no fixed
point.** Straight up is the only angle that settles, which is why it looked
intermittent.

Reproduced numerically before touching anything:

| stick held at | before | after |
| --- | --- | --- |
| straight up | 0 rotations / 10s | 0 |
| 15° off | 1.79 | 0.01 |
| 45° off | 5.38 | 0.01 |
| 90° off | 10.76 | 0.01 |
| 150° off | 17.93 | 0.01 |

**Fix:** the rig *leans* toward the ship rather than chasing it — clamped to
26° off world north and **recomputed from that absolute reference every frame**.
Removing the integration removes the runaway; the offset saturates and stops.

**Why the bot never caught it:** the scripted aim wrote straight into world
space, bypassing the rotation entirely. `Input` now also accepts a raw stick
override (`override.aimStick`) that goes through the camera-relative path, so
the regression test drives the same code a thumb does.

**An existing test asserted the bug.** `stick aiming swings the rig behind the
ship` required more than 0.5 rad of swing — the runaway, written down as a
requirement. It now asserts the bounded lean. Worth remembering: a failing test
after a fix is not automatically the fix's fault.

#### Floating rocks

**Root cause: arithmetic.** `buildRock` returns a body whose flat base already
sits near y=0, but `_spire()` then lifted it by `h * 0.42` as though it were
centred. A seven-unit spire hovered 2.4 units in the air.

**Fix:** `seat()` — translate by the measured bounding box, which is exact
where guessing from intended height was not. Two things fell out: spires were
also 40% short (the vertical scale had been compensating), and the ground
inside the arena dipped to −0.6 while entities sit at 0.

### 21. Controls, arena, camera, sound (`45dedaf`)

Four things, all reported from play.

#### Controls — the drive scheme

**Reported:** navigation is hard; proposal was one stick for the whole ship,
the other only for shooting.

**Diagnosis agreed with the report.** The ship slid one way while pointing
another — a twin-stick convention that works top-down and reads badly from a
low camera, where the nose is the only heading cue.

**Built:** `drive` (now the default) — the left stick steers, the ship points
where it is going. **Amended the proposal in one place:** the right stick can
still aim, not just fire, because fire-only removes the fighting retreat. It is
a trigger unless you push it, and pushing it hands the nose over for as long as
you hold. `freeaim` keeps the old scheme under Settings.

Supporting changes: `aim.held` (non-latching, unlike `aim.active`) so the nose
returns to the throttle the moment you let go; a bounded turn rate so the hull
swings rather than snapping like a cursor; and aim assist disabled in the
hold-facing branch, because otherwise an idle ship rotated to track enemies on
its own.

#### Arena — 46 → 66 radius

A little over twice the floor. Everything derived from `ARENA_RADIUS` scaled
automatically; **the two places that did not were both bugs** — the spawn ring
kept a fixed inner radius that crowded spawns into the middle, and the ground's
outer lift started at `0.92 ×` the radius, which on a bigger arena began inside
the play area and pushed the floor up through the entity plane.

Cover went 12 → 26 props across two rings, with **buttes** joining the spires:
wide, flat-topped masses cut with a horizontal cap (`buildRock`'s `flatTop`),
because an arena of only tall narrow rocks reads as a field of cones. Scatter
counts scale with **area**, not radius. The shadow frustum now **follows the
player**, snapped to whole texels — smaller than the old fixed box and sharper,
on an arena twice the size. (Unsnapped, a moving frustum makes every shadow
edge crawl.)

#### Camera — boom collision

With that much standing rock, a rig that ignores the scenery spends half a
fight inside a butte. `_solveBoom()` now solves against the arena's collision
cylinders every frame — one quadratic per obstacle, not a mesh raycast.

Three remedies, in order, because each has a case the others cannot handle:

1. **Wind the boom in** to the first blocking intersection. Preferred: keeps
   the framing.
2. **Climb over** — raise the eye until the sight line clears the top. For rock
   too close to back away from.
3. **Step around** — a bounded bearing offset, up to 78°, with hysteresis so
   the search does not hunt between two equally good bearings.

Plus a hard ejection after damping, because the solve is damped and the ship
can be shoved by an explosion faster than the boom retracts.

Measured over 75 placements, the ship pressed against every obstacle from five
bearings:

| | before | after |
| --- | --- | --- |
| camera inside rock | 11 | **0** |
| ship hidden behind rock | 12 | **0** |

**Debugging note worth keeping:** three of the intermediate readings were
wrong, not the code. The first sweep killed all enemies, which ended the wave,
which stopped `follow()` running at all — so the camera never moved. A later
sweep did not step long enough for the avoidance swing to finish. Check the
harness before concluding the subject is broken.

#### Sound

**Reported:** "the sounds are now goofy".

The weapon cue was a sawtooth sweeping 900Hz → 290Hz. That is a textbook
sci-fi laser however you tune it. Firearms are now built the way one is
*shaped*: a sub-millisecond broadband **crack**, a low muzzle **blast**, and a
**tail** rolling back off the canyon into the existing convolution reverb.

The score kept its D-minor vamp — always right for the genre — and lost the
synthwave voicing: plucked guitar chord tones, upright bass, hand drum and
woodblock instead of a kick and snare, and a two-reed harmonica lead that only
speaks at phrase boundaries. Tempos came down to a walk (menu 76, combat 104,
boss 118).

**`tools/gunshape.mjs` was built for this**, because `audiomix.mjs` measures
loudness and loudness cannot tell a revolver from a laser. It reports
time-to-peak, energy inside the first 10ms and 100ms, tail energy, and how high
the crack sits:

| | before | after |
| --- | --- | --- |
| crack pitch | 967 Hz | 2292 Hz |
| energy inside 10ms | 37% | 51% |
| tail | none | present |

It also caught a real bug by accident: `startMusic()` never applied its mode's
tempo, so starting into a mode inherited whatever bpm was left over from the
last one.

### 22. The cast and the ambience (`HEAD`)

Asked "what would make this better". The honest answer was that the world had
been converted and the cast had not: `rig-models.js` used the void / magenta /
violet palette in 78 places, so a western canyon was populated by purple sci-fi
drones. Every other visual improvement was fighting that.

**The cast was re-skinned, not rebuilt.** Bone hierarchies and every authored
clip survived untouched — what makes a coyote a coyote is geometry and palette,
not skeleton, and a four-legged rusher with a diagonal gait and a lunge was
already a coyote wearing the wrong colour.

| was | is | why it fits |
| --- | --- | --- |
| Skitter | **Coyote** | four legs, diagonal gait, lunge |
| Drone | **Buzzard** | the three hover fins became two wings and a tail |
| Splitter | **Powder Keg** | wobbles, spins, bursts into two smaller things |
| Seeder | **Mortar Cart** | lobs shells; the four legs became wheels |
| Lancer | **Longhorn** | a centre bone and two side bones is a skull and horns |
| Sentinel | **Gatling Walker** | tall, slow, jointed legs — weird-west by material |
| Warden | **Wagon Fort** | a turning ring of plates around a core is circled wagons |
| Harrower | **Iron Horse** | a spear, side arms and a four-segment tail is a locomotive |
| Maw | **Rattler** | jaws, an eye and a coil |

**Two bugs the renders caught, both worth remembering:**

- **The horns came out crossed.** A spike points along +Y, and rotating +Y
  about Z by θ gives `(-sinθ, cosθ, 0)` — so a *positive* angle swings it
  toward **-X**. The left horn needed a negative angle, which is the opposite
  of what reads naturally in the code.
- **Dark neutrals rendered lavender.** A desaturated near-black takes its hue
  from the ambient, and the ambient here is a prefiltered sky with blue in it.
  The feather palette had to be warmed to stay brown in shade. Worth knowing
  before reaching for "neutral" anything under IBL.

World-space effect colours followed the cast: telegraph rings, beams, explosion
tints and per-type colours moved from magenta and violet to ember and dust. The
HUD was deliberately left alone — HUD is allowed to be HUD.

**Ambience.** There was none at all, which left dead air between gunshots. Two
looping noise beds with their filter cutoff and gain driven by slow oscillators
wired straight to the AudioParams, so it costs nothing per frame and never
needs scheduling. Gusts swell and die on their own timer; a buzzard calls, but
only when the fighting has stopped.

Measured, since it cannot be heard: **7.5x level swing** across a rendered
minute — the number that separates weather from hiss, because a bed that never
moves stops being heard inside a minute — and it ducks to under half in combat.
`tools/audiomix.mjs` grew a section for continuous sources to check both.

---

## What each guard protects

The suite is 113 checks. Most are self-explanatory; these exist because
something specific went wrong, and weakening them would let it back in.

| Check | Protects against |
| --- | --- |
| `a held aim stick does not spin the ship` | The feedback loop above |
| `stick aiming leans the rig, and only so far` | Re-introducing an unbounded chase |
| `drive: the ship points where the left stick points` | Silently losing the drive scheme |
| `an idle ship does not turn on its own` | Aim assist flying the ship for you |
| `the camera never ends up inside rock` | The boom solve regressing |
| `the ship is never hidden behind rock` | Same, from the other direction |
| `no prop floats above the ground` | Guessed placement offsets returning |
| `the floor stays just under the entity plane` | Ground displacement drifting above y=0 |
| `every named import resolves` | Block rewrites un-exporting symbols |
| `draw calls under 150` | The shadow pass draws every caster twice |
| `no console errors across the whole suite` | Shader compile failures, which are otherwise silent |

---

## Working on this

| Tool | What it answers |
| --- | --- |
| `tools/check.mjs` | Does every module parse and every import resolve? |
| `tools/build.js` | Bundle; throws if a `src/` file is missing from `ORDER` |
| `tools/verify-bundle.mjs` | Do all three builds boot *and play*? |
| `tools/playtest.mjs` | The full suite; `--quick` skips the campaign, `--shots` only captures |
| `tools/visual.mjs` | Staged scenes for art review (`arena`, `wall`, `rocks`, …) |
| `tools/audiomix.mjs` | Is every cue audible, and does anything clip? |
| `tools/gunshape.mjs` | Is a weapon cue shaped like a gunshot or a laser? |
| `tools/balance.mjs` | Bot campaigns at every difficulty, wave-by-wave clear times |
| `tools/endurance.mjs` | Long-run stability |

**Gotchas, learned the hard way:**

- `node --check` parses files in isolation. It cannot see a broken import.
- GLSL has reserved words you would not expect (`patch`). A shader that fails
  to compile is silent unless something reports it.
- Injected shader locals share a scope with three's chunk internals.
- Running the suite piped into `tail` buffers all output until it exits. Write
  to a file instead if you want to watch progress.
- The full suite runs a whole 15-wave campaign; it takes ~12 minutes. Use
  `--quick` while iterating.
- Editing `src/` while the suite is running affects it — `index.html` serves
  modules from disk. Finish your edits, then run.

---

## Open threads

Deliberately not done, or not done yet.

- **The player vehicle is the user's to supply.** They said they would model a
  3D one. `src/render/rig-models.js` builds the current ships; a supplied model
  would need `position`/`normal`/`aColor`/`aEmit` and, to animate, an `aBone`
  index per vertex.
- **Weapons that differ in kind, not degree.** The three chassis fire the same
  single projectile with the same pulse — they are stat sliders, not different
  guns. A revolver / scattergun / rifle split would change how the game is
  played rather than how fast things die. This is the next real gameplay lever,
  and the one carrying the most risk, because feel cannot be measured here.
- **Destructible cover.** `buildRock` and the debris system already exist;
  shooting a chunk off a butte would be a large feel win for medium cost.
- **Enemy behaviour past wave 25** still leans on HP rather than new mechanics.
- **The water tower is still boxes and cylinders.** Deliberate — it is sawn
  timber, and sawn timber is boxes — but it has had no weathering pass.
- **`main` is not the repository's default branch.** Not settable from here;
  it is under Settings → General on GitHub.
- **Nothing here has ever been heard or played by a human on the team.** Timbre
  is inferred from synthesis and feel is inferred from measurement. Both have
  been wrong before, which is why the user's play reports have been the most
  valuable input in the project.
