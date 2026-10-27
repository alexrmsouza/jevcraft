# Player-like gameplay

The default session uses limited observations, natural interaction and cooperative permission checks. The Minecraft transport and physics keep the raw network world; gameplay plugins, tactical decisions, pathfinding and the conversational planner receive an observation facade instead.

## Settings

These settings are read before authentication/connection and apply to the next connection. Values and commands are English.

| Variable | Values | Default |
| --- | --- | --- |
| `JEV_PERCEPTION` | `player`, `unrestricted` | `player` |
| `JEV_COORDINATES` | `hud`, `relative`, `off` | `hud` |
| `JEV_ACTIONS` | `natural`, `unrestricted` | `natural` |
| `JEV_COOPERATION` | `ask`, `off` | `ask` |
| `MC_LOADER` | `vanilla`, `fabric`, `forge`, `neoforge` | `vanilla` |

`unrestricted` restores legacy world queries. It does not mean that every mod or game version is supported. Cooperation `off` disables the new consent checks; existing command and chat permissions still apply.

## Observations

Player perception limits vision to 32 blocks and a camera cone, with obstruction checks against block shapes and visibility affected by illumination. Glass permits sight. Darkness reduces visual detection; an actual night-vision effect can improve it. A small body-contact region is readable for immediate footing and collision awareness. This is a structured approximation of player perception, not a pixel-identical simulation of human eyesight.

Searches cannot inspect loaded chunk palettes for hidden ore. An ore target must come from visible or previously observed terrain. Stored observations are snapshots: a block or entity changing outside the field of view does not silently update the snapshot. Unknown terrain stays unknown to navigation. Distant trips progress through observed walkable legs; when no observed route is available, Jev asks for guidance rather than inspecting hidden terrain.

The bot retains exact information about its own inventory, equipment and HUD. Other entities expose visible appearance and movement, not their hidden inventory, exact health or effect duration. Real received sounds produce coarse direction/proximity cues without revealing hidden creature coordinates. The public online-player list does not imply that those players are visible.

`hud` allows F3-like coordinates. `relative` sends direction and approximate distance to the planner; `off` omits spatial coordinates there. Fixed coordinate announcements are also filtered. Internal body positions remain necessary for movement and physics. General recipe/tool knowledge remains available; knowing how diamonds are mined does not reveal a vein's location.

Player-mode goals, terrain/resource memories and conversation state use a separate namespace, including `MC_WORLD_ID` when configured. Older unrestricted records are retained on disk and are not imported into the restricted view. The Minecraft player's actual inventory and equipment are not reset. This starts a clean observation history without reusing earlier oracle-derived terrain.

## Natural actions and cooperation

Natural actions use Mineflayer's gradual rotation, enforce block/entity reach and require observable interaction targets. Combat keeps its existing attack cadence. Idle attention can turn toward a visible nearby speaker, with throttling; it does not take over active travel, combat or an open inventory interface.

The owner of an active task must approve replacing it with another player's request. Editing an existing recorded construction asks its recorded creator when known. Unknown shared containers require consent before opening; opening a container is not permission to treat every other chest as shared. Confirmed placements establish ownership for the bot's own containers. Approvals are limited to the exact task, requester, connection generation and target, with an expiry. Being near the bot's home does not establish ownership.

Questions accept a short `yes`/`sim` or `no`/`não` from the addressed player. A declined or stale question cannot start work. A container approval resumes the same saved task without invalidating its permission scope. Stopping or replacing work prevents old answers from authorizing a different action. Reactive defense remains available during cooperative pauses.

Following uses current sight and last-observed information, without tracking an unseen player's live coordinates. If contact is lost, Jev asks the player to return within view. Following nearby naturally waits for that player instead of completing the task immediately.

## Broader requests

The ChatGPT planner can now select existing validated executors for:

- Obtaining/crafting an item or a bounded list of up to eight item goals.
- Coming to or following an online player.
- Finding a supported biome, creature or block.
- Visiting a uniquely remembered place.
- Building a house or using the existing building designer/continuation resolver.
- Exploring one to four new areas, with a five-minute exploration budget and saved partial observations.

Names, materials, places and quantities are checked against the local registry and actual remembered/online context. Unsupported requests produce clarification. The model still cannot send arbitrary code, operator commands or unrestricted action sequences. A short conversational plan or explanation must describe supported actions and actual observations.

## Modpack compatibility

```text
npm run compatibility
```

This reports the configured loader, the built-in Minecraft 26.1 content family and supported capability boundary without connecting to Minecraft or a model. Fabric means vanilla-protocol-compatible servers only. Forge, NeoForge, another content version, custom networking, machines or mod items need a matching adapter. The preflight rejects unsupported configurations instead of advertising full modpack support.

`content-compatibility.js` accepts a trusted integration adapter with explicit loader/version/item declarations. This is an extension boundary, not a shipped Forge/NeoForge bridge. A concrete modpack name, Minecraft version and loader are required before implementing and validating its actual networking, recipe data and interactions. A bridge inside a real modded Minecraft client remains a separate integration target.

## Validation scope

Tests cover occlusion, hidden ore, darkness, field of view, stale observations, raw-physics separation, protocol/event sanitation, cooperative ownership, bounded approvals, current player visibility, validated extended goals and observed navigation. Offline fixtures do not establish compatibility with an unspecified modpack or guarantee survival in every situation. No live bot connection is needed for those tests.
