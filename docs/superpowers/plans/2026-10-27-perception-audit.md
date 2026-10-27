# Player Perception Boundary Audit

## Scope and execution

Static inspection only during development; no tests, runtime probes or checks were executed until the final validation phase was explicitly announced. No model calls or Minecraft connections were used. Implementation ownership: `src/perception.js` and `test/perception.test.js`. Session integration, action guards, navigation, configuration and planner sanitization belong to other workers.

## Public API

`createPerception(rawBot, { mode = 'player', coordinates = 'hud', range = 32, horizontalFov = 110, verticalFov = 80, maxBlocks = 12000, now = Date.now })` returns `{ bot, context, refresh, setMode, setCoordinates, close }`.

The gameplay bot exposes `bot.perception` with `mode`, `coordinates`, `canSeeBlock(position)`, `visibleEntity(entity)`, `canInteract(target, reach = 4.5)`, `lastSeenPlayer(name)` and `context()`. No public method exposes raw terrain or the raw bot.

`lastSeenPlayer(name)` returns a detached `{ name, position: Vec3, dimension, observedAt, visible }` snapshot or `null`. Player tab names remain available through `bot.players`; hidden players have no `.entity` property.

Model context has `{ mode, coordinates, range, visibleBlocks, visibleEntities, sounds, position?, biome? }`. `hud` allows observed absolute positions; `relative` uses eight relative directions and distances rounded to two blocks; `off` omits object spatial fields. Sounds always contain only `{ sound, direction, proximity, at }` and expire after five seconds. The planner must independently remove positions from every other context source when coordinates are restricted.

## Closed data paths

| Surface | Player-mode behavior |
| --- | --- |
| `blockAt`, world `getBlock` | Current FOV/range/face LOS/lighting observations; bounded detached last-observed snapshots otherwise; unknown is `null`. |
| `findBlock`, `findBlocks`, `findBlocksAsync` | Search only observation memory after a bounded camera-cone refresh. No raw chunk or palette matching. |
| world `raycast` | Only filtered observations; unknown cells return an opaque, non-diggable `unknown` sentinel rather than reporting clear space. |
| world chunk aliases | `getColumn`, `getColumnAt`, `getColumns`, `sections`, `async` and raw column storage are absent. |
| entity/player queries | Visible entities only; stable detached references, no live position updates while hidden. Player tab presence is separate from visible position. |
| entity metadata | Own body remains the real HUD/physics identity. Other entities omit health, attributes, effect durations, full metadata and equipment NBT. A small whitelist retains rendered pose/size/aggression flags. |
| container blocks | Snapshots omit block entity data, NBT and contents. Actual open window UI/inventory remains available. |
| raw protocol subscription | Hidden entity/terrain packets suppressed. Actual own damage retains source IDs but strips source coordinates. Own HUD, chat and actual opened container properties remain available. |
| gameplay events | Raw block payloads sanitized, hidden entities suppressed, visible entities mapped to stable snapshots, foreign effect details suppressed. Own hurt still arrives when its source is hidden. |
| `listeners`/`rawListeners` | Only gameplay-owned subscriptions are returned; internal transport callback closures are hidden. |
| `getExplosionDamages` | Hidden in player mode because upstream uses raw-world exposure raycasts. |
| gameplay plugin injection | `loadPlugin` wraps upstream injection so the plugin receives the facade. |

## Existing call sites requiring integration care

- `src/block-search.js` accesses raw section palettes and state IDs. Its fast-path capability checks become false because column getters are absent; `worldCells` also refuses the facade. Its captured `_worldBlockAt` can only be the filtered reader. Do not install a raw block-search helper on the gameplay facade afterward.
- `src/nether-coverage.js` has another column/state shortcut; the facade forces its `blockAt` fallback. Coverage can retain previously observed space but cannot refresh hidden terrain.
- `src/discovery.js` reads `block.biome`; only body-contact cells expose current F3 biome under `hud`. Remote biome guesses from exact server cells are unavailable.
- `src/fortress-map.js` identifies spawner types from block entity data. Player mode strips this data; the executor must rely on observed spawned creatures or report uncertainty, rather than silently restoring NBT access.
- `src/furnace-properties.js` observes `craft_progress_bar`. The facade permits packets only for the player's inventory or an actually opened/recently opened window. Full raw hidden-container subscriptions remain unavailable.
- `src/compatibility.js` corrects transport velocity, oxygen, passengers and overlapping body physics. Install it on the raw bot before creating/loading gameplay plugins on the facade.
- Mineflayer internal block/entity/physics plugins already capture the raw transport and keep it. The custom pathfinder must receive the facade; its movement and physics adapters call the filtered `blockAt`.
- Mineflayer `lookAt`, digging and inventory methods close over the raw bot. Natural rotation wrappers must deliberately cover these internal action calls; wrapping facade reads alone is insufficient. The action worker and parent coordinate this separately.
- Recorder terrain scans become filtered when attached to the facade. Such scans can be CPU intensive because they historically queried every loaded cell; they no longer grant observation of hidden blocks.
- Existing persisted resource/world/goal files may contain old unrestricted coordinates and hidden ore routes. The parent must separate player-mode state from old unrestricted state. Switching sensing mode clears the facade's own observation cache.

## Conservative choices and limits

Visibility is deterministic geometry and light, not rendered Minecraft pixels. Collision shapes approximate visible faces; glass is optically transparent, while unknown space remains blocked. Interaction uses a separate physical ray: glass blocks reaching an ore or entity behind it, and a block interaction requires the requested block to be the first physical hit. Stale supplied block types/states are rejected. Sparse camera rays can miss a small exposed resource until a direct look or movement samples it. Opaque block lighting uses the exterior visible face because opaque interiors normally have zero light. Complete darkness hides remote targets; actual night-vision effects are honored. Night skylight reduces effective distance.

Full camera-cone scans are throttled independently of movement to one per 200 ms; own-body contact and on-demand queries remain current. A bounded per-frame raw read cache shares overlapping ray cells and invalidates on movement, rotation, time or block updates. Blindness/darkness and underwater/lava body states reduce sight range.

The bot can identify blocks intersecting its own body or supporting its feet even without a camera view. This is the deliberate local contact exception required for reliable own-body safety; it does not extend to buried blocks underneath the supporting cell.

Observation memory is bounded and explicitly stale when not visible. It is not an authorization source, and an old block snapshot is not proof a resource or path is still available. Actions must call `canInteract` or current visibility guards; navigation needs an observed frontier rather than treating unknown terrain as air.

This is a gameplay data boundary, not a JavaScript security sandbox against malicious plugins. Trusted transport diagnostics and internal physics remain raw by design, and must not feed their world objects directly into model input.

## Final validation

The isolated perception suite passed 28/28 tests with pinned native Windows Node 22.23.3, the canonical `test/support/jev-stand-in.js` preload and `JEV_NONE_GOOD=0`. The first hearing test exposed a real initialization bug: a sound received before the first visual refresh was erased by initial dimension assignment. This was reproduced in isolation, fixed by distinguishing initialization from a dimension change and establishing the sound's world at reception, and covered by an additional world-transition regression. Final review also exposed optical visibility being reused for physical interactions; three new regressions first failed for through-glass block/entity interaction and stale block targets, then passed after adding a separate collision ray. Clear-air targets and the glass itself remain interactable. No live bot, model inference or Minecraft server was involved.
