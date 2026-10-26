# Contextual Companion Implementation Plan

**Goal:** Give Jev bounded persistent conversational memory, useful questions and help requests, a consistent configurable personality, and event-driven initiative.

**Architecture:** Local per-world/player memory supplies sanitized recent events and compact older history to the existing planner. A local dialogue coordinator owns pending questions and communication timing. Session hooks observe actual execution and pause blocked work without disabling reactive safety. Personality changes expression and optional conversation, never action authorization.

**Tech Stack:** Native Windows, Node.js 22, CommonJS, existing Mineflayer session and node:test suite. No new dependencies.

**Execution constraint:** The user explicitly requires all testing at the end. Write tests with the components, but do not execute tests, smoke probes, or gameplay checks during development. Keep the bot disconnected. Use read-only code review during implementation.

## Tasks

- [x] Implement `src/conversation-memory.js` and behavior tests: atomic bounded persistence, player isolation, recent messages/actions/tasks, compact historical summary, safe planner context, damaged-file handling.
- [x] Implement `src/dialogue.js` and behavior tests: persistent pending questions, answer routing, expiration, cancellation, no repeated reminders, event-driven suggestions and help, danger/chat cooldown and narration gates.
- [x] Extend `src/planner.js` to receive bounded contextual memory, current vitals/equipment/location, execution progress, pending question, and personality. Preserve validated goal schema and current-state precedence.
- [x] Extend English configuration/commands for personality and initiative; persist overrides with existing communication policy and validate before connection/authentication.
- [x] Integrate session hooks: received and emitted messages, task lifecycle, observed actions/deaths/failures, active progress watchdog, blocked-task help, explicit continuation and optional suggestions. Preserve stop/cancel, multiplayer ownership and reactive defense.
- [x] Document configuration, behavior, limitations and separation of suggestions from permission to act.
- [x] Review all code and cross-module interfaces before running any test.
- [x] Final validation only: run new behavioral scenarios, full native Windows suite, portability checks. Repair actual failures and rerun the affected final checks. Do not start the bot or spend model tokens.

## Required final scenarios

Recent messages and task context survive restart; players/worlds stay isolated; actual inventory wins after death; a short clarification preserves the original request; help waits safely and does not repeat; unrelated chat does not authorize work; stale questions cannot resume replaced tasks; danger suppresses optional speech; off/important/full and initiative settings are respected; persona never invents observations or task completion; bounded input avoids growing token usage.

## Validation record

All implementation and initial static review preceded the first test execution, as requested. The first native Windows suite passed 4,501 tests. Final review added a stale-clarification regression and localized discovery names; the final complete suite passed 4,502/4,502 tests with zero failures, cancellations or skips (Node 22.23.3, npm with cmd.exe, concurrency 8, 202,990 ms). Portability checked 1,168 JavaScript files and 14 shell wrappers. No Minecraft session or live model inference was started.
