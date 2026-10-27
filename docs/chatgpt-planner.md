# ChatGPT planner

The optional planner turns a chat request into a checked supported goal. Jev still
chooses how to gather, craft, move and survive. It still needs its TypeSafe or
OpenRouter credentials.

## Sign in and verify access

Use Node.js 22 or newer from the repository directory:

```sh
npm run chatgpt:login
npm run chatgpt:status
npm run chatgpt:models
npm run chatgpt:verify
```

Open the OpenAI URL printed by `chatgpt:login` in your browser. Complete the
account login and review the JevCraft authorization. Keep the terminal running
until the local callback finishes. A successful login is separate from model
access: `chatgpt:verify` must also finish a real response. It makes one small
model request using the ChatGPT plan authorized for JevCraft.

`chatgpt:models` lists the models available to that account. Without an explicit
model, verification uses the first visible model in the account catalog. To
choose another listed model:

```sh
npm run chatgpt:verify -- --model MODEL_SLUG
```

Plan availability and limits are enforced by OpenAI. An expired login, denied
permission or usage limit stops the request; the client does not switch to a
paid API key or retry inference automatically.

## Enable the planner

Add these settings to the repository's `.env` file, choosing a model from your
account's catalog:

```dotenv
JEV_PLANNER=chatgpt
CHATGPT_MODEL=gpt-6-luna
```

Keep `TYPESAFE_API_KEY` or the existing OpenRouter Jev configuration available.
Set `MC_HOST` and `MC_PORT` to your server, then run `npm start`. Startup checks
ChatGPT access and model availability before connecting to Minecraft. In
ChatGPT mode the bot waits for a player request, including after reconnecting
or finishing work. It does not start collecting supplies, exploring, crafting
or pursuing dreams while waiting. It can react to an actual threat or physical
danger, then return to waiting. Quiet waiting makes no model inference calls;
reactive defense can use Jev/TypeSafe. The OpenAI planner handles player
requests only. Chat, clarification and status do not start an autonomous task.

Try `Jev colete 16 troncos de carvalho` or `Jev faça 8 gravetos para mim`.
Supported goals include obtaining/crafting items or bounded lists, following or
coming to a player, finding targets, visiting remembered places, building and
bounded exploration. See [player-like gameplay](player-mode.md) for perception,
consent and compatibility limits. Unsupported or ambiguous work is clarified.
Literal operator commands retain the existing authorization checks.

`Jev stop`, `Jev resume` and `Jev status` use local controls. A stop cancels
pending planning so a late model response cannot restart work. English controls
remain available. Use `JEV_PLANNER=jev` to restore the original interpreter.
That original mode also retains JevCraft's autonomous work between requests.

## Chat addressing

On a loopback server (`localhost`, `127.0.0.1` or `::1`), the ChatGPT planner
listens to player chat without requiring the bot's name. Other servers default
to automatic addressing. Three modes are available:

| Mode | Behavior |
| --- | --- |
| `open` | Respond to player chat without a name prefix. |
| `named` | Require the bot's name for ordinary requests. |
| `auto` | Open with one other connected player; named with two or more. |

The count excludes Jev and uses the server's connected-player list, including
players outside its current view. The bot always ignores its own chat.

Use ordinary chat messages, not Minecraft slash commands:

```text
!jev chat
!jev chat open
!jev chat named
!jev chat auto
```

These controls run locally and preserve the task in progress. Changes survive
restarts in the ignored local state directory. `JEV_CHAT_ADMINS` lists the player
names allowed to change modes; when empty, a sole other player on a loopback
server may change them. These permissions are separate from operator commands.

An explicit `JEV_CHAT_MODE=open|named|auto` in the environment fixes the mode and
overrides saved chat settings. Leave it unset to allow persistent chat changes.
Open mode sends ordinary player messages to the planner, so it can use more
ChatGPT plan allowance than named mode. Clarification and local task controls
retain their existing handling.

## Language and narration

These settings work with both `JEV_PLANNER=chatgpt` and the original Jev
interpreter. They change player-facing language and unsolicited chat without
adding model calls or interrupting the current task. Commands and configuration
names remain in English in either language.

```dotenv
JEV_LANGUAGE=pt-BR
JEV_NARRATION=full
```

The defaults are `en-US` and `full`. Supported languages are `en-US` and `pt-BR`.
Language and narration choices saved in game override environment defaults on
the next connection. Invalid environment defaults fail startup before
authentication or the Minecraft connection.

```text
!jev language
!jev language pt-BR
!jev language en-US
!jev narration
!jev narration off
!jev narration important
!jev narration full
```

| Narration | Unsolicited messages |
| --- | --- |
| `off` | None; direct replies and control acknowledgements still work. |
| `important` | Dangers, failures, blockages and task completion. |
| `full` | Important messages, startup greetings and task progress. |

Status replies, clarification questions, task acknowledgements and command
permission errors are direct replies and remain available in every mode.
Changing narration affects chat only; defensive behavior continues as usual.
The selected language also goes to the ChatGPT planner for its replies and
clarification options. Minecraft item identifiers remain unchanged internally.

Any known player may query settings. Mutations require a name in
`JEV_CHAT_ADMINS`; without that list, only the sole other player on a loopback
server may change them. The bot ignores its own chat. Changes take effect
immediately and are saved per server/port/bot identity in the ignored
`<identity>-communication.json` state file. Existing chat addressing settings
stay in their separate chat-policy file; an explicit `JEV_CHAT_MODE` still fixes
that addressing mode.

The request and bounded contextual memory go to the planner: the player and
bot names, inventory, equipment, vitals, position, observed nearby block names,
game mode, dimension, current execution state, recent messages/actions/tasks,
player notes and the pending question. It does not receive credentials or the
full saved state. [Conversation and personality](companion.md) describes the
local storage, context budgets and initiative settings.
Responses use `store:false` and `stream:true`; only completed, locally validated
goals reach the executor. ChatGPT plan limits are separate from Jev usage.

## Session storage

JevCraft stores its own OAuth registration and session under
`.bot-state/chatgpt/`, which Git ignores. Windows protects credentials with
DPAPI for the current Windows user; Linux and macOS use owner-only file
permissions. The login uses PKCE and a callback bound to `127.0.0.1`.

To disconnect:

```sh
npm run chatgpt:logout
```

Logout clears local tokens and attempts remote revocation. If revocation cannot
be confirmed, disconnect JevCraft in ChatGPT Settings as well. The local
installation identity is retained for later sign-in.

The integration follows OpenAI's [Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [model inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
