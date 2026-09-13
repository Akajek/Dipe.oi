# TurretForge.io

A multiplayer arena shooter in the diep.io vein, with one difference: **you design your own turrets.**
Barrel angle, length, width, reload, spread, projectile type — all of it is yours to tune, priced
against a fixed points budget so a custom build is a set of trade-offs rather than a wish list.

Four modes: **Free For All**, **Team Deathmatch**, **Boss Fight** (one player becomes a giant boss
everyone else has to bring down before the timer runs out), and **Sandbox**, where cheat builds are
allowed.

---

## Quick start

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

To see multiplayer without a second machine, run some bots in another terminal:

```bash
npm run bots
```

Run the regression tests:

```bash
npm test
```

---

## How it plays

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| Left click / `Space` | Fire |
| `E` | Toggle autofire |
| `R` | Toggle auto-spin (barrels rotate on their own) |
| `1`–`8` | Spend a skill point |
| `Enter` | Chat |

Farm the polygons for XP, level up to 45, and spend points across the eight classic stats.
Everything else is decided by the turrets you brought.

## The Forge

The build editor. Every turret has fourteen tunable fields and three projectile types:

- **bullet** — fire and forget
- **drone** — persistent, chases your cursor, comes home when you stop shooting
- **trap** — coasts a short distance, then parks as area denial

Each turret is priced by a cost model dominated by sustained DPS, so "fast, huge and everywhere"
is unaffordable. Spread and self-recoil are *discounts* — accepting a drawback buys you damage.
You get **120 points** and up to **10 turrets**.

Every property has both a slider (for sweeping) and a number box (for exact values). **Duplicate**
copies a turret, **Mirror** reflects one across the centre line -- symmetric builds take two clicks.
Twelve presets ship as starting points; builds are saved to `localStorage`, and changing your build
mid-game takes effect on your next respawn.

### Cheat mode

The **Cheat mode** switch sits in two places: on the main menu under the settings row, and in the
Forge's top bar next to Save & Close. It removes the points budget entirely and unlocks every slider: damage to 1000,
penetration to 100000, up to 48 turrets. Cheat builds are accepted **in Sandbox only**, so the
competitive modes stay honest -- flipping the switch moves you there automatically, and turning it
off clamps your build back to legal values.

The caps that remain are the ones that keep the server alive rather than the ones that keep the game
fair: a per-tank live-projectile budget and a room-wide entity cap mean a 48-barrel build firing
1152 shots per volley is merely ridiculous instead of fatal. Non-finite values are rejected
everywhere, because a NaN position produces an entity that can never be drawn, hit or removed.

> The client and the server price builds with **the same module** (`shared/builds.js`), and the server
> re-validates every build on arrival. A build that fails validation is replaced with the starter
> build rather than clamped, because ten individually-legal max-stat turrets are still wildly
> over budget together.

---

## Architecture

```
shared/     code both sides import verbatim (no build step)
  constants.js   tuning, entity/team/FX enums
  math.js        small helpers, deterministic PRNG
  protocol.js    binary encoder/decoder for snapshots and input
  builds.js      turret schema, cost model, validation, presets
server/
  index.js       express + ws, matchmaking, the fixed-step loop
  room.js        one arena: physics, collisions, modes, snapshots
  entities.js    tanks, projectiles, shapes, stat formulas
client/
  js/net.js      transport + snapshot interpolation
  js/renderer.js Canvas2D world rendering
  js/vfx.js      particle system
  js/builder.js  the Forge
  js/sfx.js      procedural WebAudio sound effects
  js/sprites.js  pre-rendered sprites + the glow-path calibration
  js/input.js    input capture + client-side prediction
  js/ui.js       HUD, menu, leaderboard, chat
tools/
  test.mjs       headless regression tests (npm test)
  bots.mjs       bot clients for local multiplayer testing
  observe.mjs    headless observer that reports what the server sends
```

### Networking

WebSocket **binary** frames carry the hot path; **text** frames carry JSON control messages.
Splitting by frame type means neither side needs a discriminator byte on the JSON path.

- **Snapshots** (server → client, 30 Hz): 17 bytes per visible entity, view-culled per player.
  Roughly **13 KB/s per client** with 12 players and 465 entities.
- **Input** (client → server, 30 Hz): 9 bytes.
- Builds are sent once and cached by `styleId`; snapshots only carry the id, so a ten-turret
  layout costs the same bandwidth as a one-turret one.

The client renders 100 ms in the past and interpolates between the two bracketing snapshots, so
other players move smoothly. Your own tank is **predicted locally** and reconciled against the
server each frame — small drift is blended away, a big gap snaps.

### Synced VFX

Effects are not guessed client-side. The server appends an **event stream** to each snapshot
(`FIRE`, `HIT`, `EXPLODE`, `TANK_DEATH`, `SHAPE_DEATH`, `LEVEL_UP`, `SPAWN`, `HEAL`, `BOSS_ROAR`,
`BOSS_SLAM`) and every client turns those into particles at the same world position. Muzzle flashes,
shatter debris, shockwaves, screen shake and level-up rings are therefore identical for everyone
watching, and events are culled to what each player can actually see.

Particle density scales itself down automatically if a client's frame rate drops.

### Sound

Effects are synthesised at runtime from oscillators and a shared noise buffer -- no audio files to
download or keep in sync. Sound is driven by the same event stream as the particles, attenuated by
distance and throttled per event type so a dozen players on autofire cannot turn into white noise.
Barrel width sets the pitch of a shot, so a cannon sounds heavier than a pea shooter.

### Authority

The server owns everything: movement, collisions, damage, XP and build validation. The client
sends only intent (key bits and an aim angle). Viewport size is clamped server-side so nobody can
request the whole map.

---

## Deploying to Render (Frankfurt)

The repo ships a `render.yaml` blueprint pinned to the **Frankfurt** region.

1. Push this repository to GitHub.
2. In the Render dashboard: **New → Blueprint**, point it at the repo, and apply.
   Render reads `render.yaml` and creates the web service — region, build and start commands included.
3. Wait for the first deploy, then open the service URL.

If the Blueprint route asks you to upgrade, skip it and create the service by hand instead
(**New → Web Service → connect the repo**). The dashboard lets you pick the Free instance type
directly, and `render.yaml` is then ignored:

| Setting | Value |
| --- | --- |
| Type | Web Service |
| Region | **Frankfurt** |
| Instance type | **Free** |
| Runtime | Node |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Notes:

- `render.yaml` ships with **`plan: free`**, so the blueprint applies without a card on file.
  The catch: free instances spin down after ~15 minutes of inactivity, so the first player back
  waits through a cold start (roughly a minute), and they get a fraction of a CPU. That is fine
  for testing and for a handful of friends. Change `plan: free` to `plan: starter` when the
  cold starts start to hurt — it is a one-line edit and a redeploy.
- Empty rooms are frozen rather than simulated, so an idle server costs almost nothing.
- WebSockets work over the normal HTTPS port — the client derives `wss://` from `location.host`,
  so there is nothing to configure.
- `PORT` is injected by Render and read automatically.
- One instance only. Rooms live in process memory, so a second instance would be a second,
  invisible world. Scale up, not out, unless you add shared state first.

### Why Frankfurt matters

Ping is the whole game here. With a 30 Hz tick and 100 ms interpolation, a player at 30 ms RTT
feels immediate and one at 150 ms feels like they are fighting through syrup. Frankfurt keeps most
of Europe under ~40 ms. The in-game HUD shows live ping in the top-right corner.

---

## Performance

If the game stutters, turn on **Low graphics** in the menu. It drops render resolution to 0.75x,
cuts the live particle ceiling from 1400 to 260, and skips the fill-rate-heavy effects (bullet
trails, the full-screen vignette, soft glows). There is also an automatic tier: particle density
thins out below 40 fps, and render resolution drops below 28 fps.

One decision worth knowing about. Soft glows can be drawn as a radial gradient or as a pre-rendered
sprite, and **which one is faster depends entirely on the machine**: with GPU-accelerated canvas the
gradient wins by about 2.5x, while under software rendering (common on Linux, or any machine where
the GPU is blocklisted) the sprite wins because it is a straight blit instead of a per-pixel
gradient evaluation. Rather than guess, `calibrateGlow()` times both at startup and picks the
winner. Measured, not assumed -- guessing wrong roughly triples the cost of every explosion.

## Deploy gotcha: stale assets

Module URLs carry no content hash, so production serves them with
`Cache-Control: no-cache` (revalidate, 304 when unchanged) rather than a long
max-age. With a long TTL a redeploy can leave a browser holding **new HTML and
stale JS** — the page renders controls whose event handlers do not exist in the
cached bundle, so buttons appear and do nothing. That is much harder to
diagnose than an outright error.

The server's build id is shown in the menu footer and at `/api/version`, so
"are you on the current deploy?" is answerable instead of guesswork.

## Tuning

Most balance lives in two files:

- `shared/constants.js` — world size, tick rate, shape values, stat curves, physics.
- `shared/builds.js` — turret field ranges, the cost model (`turretCost`), the budget, presets.

Because both are shared, editing them changes the client preview and the server's validation
together. `npm test` checks that every preset still fits the budget and can still deal damage,
which catches most accidental balance breakage.

## License

MIT
