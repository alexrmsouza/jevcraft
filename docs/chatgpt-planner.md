# ChatGPT planner

The optional planner turns a chat request into one checked item goal. Jev still
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
This first version supports one obtain/craft goal at a time, conversation and
clarification. It asks for clarification about unsupported or ambiguous work.
Literal operator commands retain the existing authorization checks.

`Jev pare`, `Jev retome` and `Jev status` use local controls. A stop cancels
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
!jev chat aberto
!jev chat nome
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

Only the request and a compact game snapshot go to the planner: the player and
bot names, inventory, observed nearby block names, game mode, dimension and
current goal summary. It does not receive credentials or the full saved state.
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
