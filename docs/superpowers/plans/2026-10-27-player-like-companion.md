# Player-like Companion Implementation Plan

**Goal:** Give Jev player-like perception, natural interaction, cooperative and broader supported requests, and explicit modpack compatibility boundaries.

**Architecture:** Keep the Mineflayer transport/physics intact and give gameplay a filtered observation facade. All planners, tactical decisions and navigation operate on visible or last-observed state, with unknown space explicitly unknown. Independent action and cooperation policies enforce observable, authorized interactions. Reuse existing goal executors behind an expanded validated planner contract.

**Execution constraint:** Keep the bot disconnected. The user requires tests only at the end: write behavioral tests during implementation but execute no tests or probes until all implementation and static review are complete.

- [x] Build central perception with LOS/FOV/light/range, stale observations, own HUD/inventory, perceived entities and coarse hearing; audit pathfinder and direct world access.
- [x] Add bounded gradual look/interaction behavior without changing physics or emergency controls.
- [x] Extend validated planner goals to existing follow/come/build/find/visit/bundle capabilities and grounded task explanations.
- [x] Add cooperative decisions for player distance, shared resources and destructive/building consent; protect pending questions against stale/foreign answers.
- [x] Add version/loader/content compatibility reporting and adapter boundaries without claiming support for an unspecified modpack. Ask for a concrete modpack in parallel.
- [x] Wire English configuration, local controls, settings persistence and selected-language output; document behavior and limitations.
- [x] Complete static cross-module review before tests.
- [x] Final tests only: new behavior scenarios, full native Windows suite, portability checks; no live bot or paid inference.

## Acceptance scenarios

Hidden ore cannot influence target selection; an unseen changed chest/block/entity does not update remembered state; darkness/FOV/range reduce observations; pathfinding cannot inspect raw unknown terrain; physics retains transport data; own inventory remains exact; hidden creatures can produce coarse sound cues without exposing exact positions or health. Supported composite/social requests validate against real players/items/capabilities. Suggestions never authorize unrelated work, cooperative pauses preserve defense, natural camera movement is cancellable, and unavailable mod mechanics fail explicitly.

## Final validation

Tests began only after implementation and static review were complete. The first focused run found one hearing initialization defect; after reproducing and correcting its cause, perception passed 25/25 and the combined focused suite passed 243/243. The full native Windows suite passed 4,589/4,589 (Node22.23.3, cmd.exe, concurrency8, 196,230ms), with zero failures/cancellations/skips. Portability checked 1,184 JavaScript files and 14 shell wrappers. The compatibility CLI reported the configured vanilla26.1 capability boundary without connecting to Minecraft or a model. A concrete modpack integration remains dependent on the requested pack/version/loader; none is claimed supported by this change.

Final review added three reproduced regressions for physical interaction through glass and stale block targets. The corrected perception suite passed 28/28 and the combined focused suite passed 246/246. The full suite and cross-platform CI are rerun for this correction before merge; their final results are recorded in the pull request.
