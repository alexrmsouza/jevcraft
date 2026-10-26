# Context, personality and conversation

Jev keeps a local record of recent conversations, observed actions and task outcomes. The ChatGPT planner receives a bounded selection of that record alongside current inventory, equipment, position, health, food, oxygen and execution state. Existing player notes, places and preferences are included too.

Current observations take priority. Remembering that Jev collected iron yesterday does not prove it still has that iron after a death. Planned steps are recorded as task state, not successful actions. Historical text cannot grant permission to start work or execute commands.

## Configuration

All configuration keys and command values are English. Player-facing replies follow `JEV_LANGUAGE`.

| Setting | Values | Default |
| --- | --- | --- |
| `JEV_PERSONALITY` | `reserved`, `companion`, `playful` | `companion` |
| `JEV_INITIATIVE` | `off`, `help`, `full` | `help` |
| `JEV_LANGUAGE` | `en-US`, `pt-BR` | `en-US` |
| `JEV_NARRATION` | `off`, `important`, `full` | `full` |

`reserved` is brief and calm. `companion` is cooperative and curious. `playful` allows light situational humor. The profile affects the planner's wording and local proactive messages. It never changes safety, task capabilities or permissions.

`off` initiative answers players without starting optional conversations. `help` also asks for assistance when work becomes blocked. `full` permits optional comments and suggestions after observed events. Narration also applies: `off` suppresses automatic questions, `important` permits help but suppresses optional suggestions, and `full` permits both. Direct replies and clarifying questions remain available in every narration mode.

Change settings without interrupting a task:

```text
!jev personality playful
!jev initiative full
!jev narration important
!jev language pt-BR
```

Omit the value to query a setting. The existing `JEV_CHAT_ADMINS` permission policy applies to changes. Saved choices override environment defaults and survive restarts.

## Questions and help

Each player can have one pending question. Clarifications retain the original request for 90 seconds; an exact offered option, its number or an ordinal such as `the second` or `a segunda` can answer without repeating Jev's name. A new explicitly addressed subject dismisses the old question.

Help and suggestion questions expire after five minutes. Jev does not send repeated reminders. A suggestion accepts consent only from the player it addressed, and the resulting request goes through the same validation as a typed request. State is checked again before accepting a delivery suggestion.

For help, `yes` or `sim` acknowledges the question while Jev waits. Say `resume`, `try again`, `pode continuar` or `pronto` once assistance is complete. `later`/`depois` dismisses the question without resuming. `cancel`/`pare` uses the normal task controls. Questions cannot revive a replaced task or take over another player's task.

Automatic questions wait until the bot is ready, reasonably healthy, breathing normally and free of an immediate threat. Optional speech waits for five seconds of conversational quiet and at least 30 seconds between proactive messages. Questions that could not be sent safely are reconsidered while the same task still needs them. Expired or dismissed questions are not replayed.

The conversation watchdog pauses work after three separately observed repetitions of the same failure, or three minutes without measurable progress. Inventory gains relevant to the task, cumulative movement toward a stable target, deliveries, completed subtasks and construction progress renew the budget. Renaming a step or wandering does not. Explicit bounded waits, such as waiting for dawn, are respected. An explicit retry starts a new budget. Existing reactive protection remains available while the task is paused; this does not guarantee survival.

## Local memory

Files live under `.bot-state/`, using the server, bot identity and optional `MC_WORLD_ID`. Conversation and dialogue files are separate from credentials. Each player's conversation is isolated within that world. Set a new `MC_WORLD_ID` when replacing a world at the same server address; the bot cannot reliably infer that replacement.

Recent messages, actions and tasks survive reconnects. Older records compact into a small deterministic historical summary without model calls. Conversation context is capped at 8 KiB per request and the existing notebook at 4 KiB; these are byte budgets, not token estimates. Additional context increases input tokens, but it cannot grow indefinitely with play time. Background conversation scheduling does not call a model.

Save a lasting note explicitly:

```text
Jev remember that our base is beside the river
Jev lembre que eu prefiro construções de carvalho
!jev memory
!jev memory clear
```

The clear command removes your saved conversation and notebook entries for this world. It does not remove another player's memory or cancel current work. New observations can be recorded afterward.

The first version's optional next-step suggestion offers delivery of completed obtain/craft items when the observed inventory still contains them. World discoveries can also produce brief factual comments. It does not invent a new mission or start a background gameplay objective.

## Validation

Behavior tests cover persistence, player/world isolation, bounded context, current state after death, clarification continuity, help ownership, task replacement, progress budgets, narration policy and consent before delivery. Planner tests inspect the actual generated input and contract using a local response fixture; they do not establish that a remote model will always sound natural or choose the best answer. Adjusting personality quality still benefits from future play sessions.
