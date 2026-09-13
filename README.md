# TurretForge.io

A multiplayer arena shooter in the diep.io vein, with one difference: **you design your own turrets.**
Barrel angle, length, width, reload, spread, projectile type — all of it is yours to tune, priced
against a fixed points budget so a custom build is a set of trade-offs rather than a wish list.

Three modes: **Free For All**, **Team Deathmatch**, and **Boss Fight** (one player becomes a giant boss
everyone else has to bring down before the timer runs out).

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

Seven presets ship as starting points (Basic, Twin, Sniper, Scatter, Swarm, Fortress, Spinner).
Builds are saved to `localStorage`; changing your build mid-game takes effect on your next respawn.

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

## Tuning

Most balance lives in two files:

- `shared/constants.js` — world size, tick rate, shape values, stat curves, physics.
- `shared/builds.js` — turret field ranges, the cost model (`turretCost`), the budget, presets.

Because both are shared, editing them changes the client preview and the server's validation
together. `npm test` checks that every preset still fits the budget and can still deal damage,
which catches most accidental balance breakage.

## License

MIT
