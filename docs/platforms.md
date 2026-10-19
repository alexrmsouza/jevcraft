# Windows, Linux and macOS

The bot, local server launcher and trial tools use Node entry points on all three platforms. Windows runs them natively in PowerShell or Command Prompt. Bash and WSL are optional.

## Prerequisites

| Tool | Needed for |
| --- | --- |
| Node.js 22+ and npm | The bot, tests, reports and trial commands |
| Git | Cloning the repository and creating baseline worktrees |
| Java 25+ | Hosting the Minecraft 26.1.2 trial server; an existing remote/LAN server needs no Java on the bot machine |
| Python 3.9+ | `scripts/extract-knowledge.py` and `scripts/plan-outcomes.py`; both use the standard library |
| `tar` on Linux/macOS | Extracting the JDK downloaded by setup; Windows ZIP extraction runs in Node |
| `lsof`, or Linux `ss` | Looking up local server listeners for trials; Windows uses built-in PowerShell or `netstat` |
| A TypeSafe key, or the configured OpenRouter provider | Live Jev decisions; offline unit tests and platform checks need no key |

Claude CLI is optional and used only by `scripts/trials/critic.js`. It must be installed, authenticated and available as `claude` on PATH, or selected with `CLAUDE_BIN`. The critic allows the CLI's scoped PowerShell tool on native Windows as well as Bash. See [Claude's Windows setup](https://code.claude.com/docs/en/setup#set-up-on-windows) for the installed CLI's shell requirements. Running the critic can use paid model access. It is not part of the offline checks.

A Minecraft client with ReplayMod is optional for viewing or editing `.mcpr` recordings. Bot connections, trial servers and reports do not require that client. The server-side recording mods installed by setup are separate from ReplayMod in a player client.

## Install and check

From PowerShell, Command Prompt or a Unix shell:

```text
git clone https://github.com/alexrmsouza/jevcraft.git
cd jevcraft
npm ci
node -e "require('node:fs').copyFileSync('.env.example', '.env')"
npm run check:portability
npm test
npm run trial -- --help
npm run server -- --help
```

Set the model key and `MC_HOST`, `MC_PORT`, `MC_USERNAME` and `MC_AUTH` in `.env`, then run `npm start` to join an existing server. Choose a separate Minecraft account for the bot when using Microsoft authentication.

PowerShell environment variables use `$env:NAME = 'value'`; Command Prompt uses `set NAME=value`; Unix shells can prefix a command with `NAME=value`. Quote paths containing spaces. Java and Git processes are started without constructing shell command strings.

## Prepare local servers

Setup stores tools in `<repo>/.tools/`. `JEV_TOOLS` changes that default; `--tools PATH` takes precedence. Downloads include the matching Java runtime, Minecraft server, and by default Fabric with server-side recording mods. `--vanilla` prepares a server without those mods.

Download and verify tools without accepting the Minecraft EULA or preparing a server:

```text
node scripts/trials/setup.js --tools-only
```

Read the [Minecraft EULA](https://aka.ms/MinecraftEULA) before preparing servers with acceptance:

```text
node scripts/trials/setup.js 1 --accept-eula
```

This prepares `.clean-run/` on port 25581. Larger counts add `.clean-run-25582/`, `.clean-run-25583/` and so on. A new server directory requires `--accept-eula`; an existing `eula.txt` containing `eula=true` preserves that acceptance. `--tools-only` never writes acceptance.

For another tools directory in PowerShell:

```powershell
$env:JEV_TOOLS = 'D:\Minecraft tools'
node scripts/trials/setup.js 2 --accept-eula
```

`--java "C:\path to Java 25\bin\java.exe"` selects an existing executable during setup. Setup records its resolved Java and JAR paths in each server's `server-launch.json`. Each server defaults to `-Xms1G -Xmx2G`; plan memory for each concurrent server and the Minecraft client.

## Launcher and console

Run a prepared server directly:

```text
node scripts/server/start.js --directory ".clean-run"
```

The launcher reads `.clean-run/server-launch.json`. A minimal configuration is:

```json
{
  "java": "java",
  "jar": "server.jar"
}
```

Use paths to your installed Java and server JAR. Relative JAR paths resolve inside the server directory. `JAVA` and `SERVER_JAR` environment variables override the saved values. Without configuration, the defaults are `java` and `server.jar`. An optional `args` array supplies the entire Java argument list, including JVM flags, `-jar`, the JAR path and `nogui`; when omitted the launcher uses `-Xms1G -Xmx2G -jar <jar> nogui`.

The launcher owns Java's stdin, refuses a second instance or an occupied port, and records its PID and session in `.jev-server.json`. Console commands go through `.jev-console/` as atomic files associated with that session. Commands from an earlier session are discarded. Sending a command before the launcher is ready returns an explicit error.

From another terminal in the repository:

```text
node -e "require('./scripts/lib/server').writeConsole('.clean-run', 'list')"
node -e "require('./scripts/lib/server').writeConsole('.clean-run', 'stop')"
```

The second command asks Minecraft to save and stop. Avoid terminating Java while it is saving. Unix `.sh` wrappers remain available; new automation should call the Node entry points. Legacy Unix console FIFOs are still supported by the console-file adapter.

## Trials on Windows

The first-days command starts the prepared server and a fresh bot:

```powershell
node scripts/first-days.js start first-days-1
node scripts/first-days.js verdict
node scripts/trials/trail-map.js 25581 --minutes 15
```

For the second server, prepare two folders first, then:

```powershell
$env:FIRST_DAYS_PORT = '25582'
node scripts/first-days.js start first-days-2
```

Trials start a supervisor automatically when needed. The same supervisor can be run explicitly in another terminal with `node scripts/trials/supervisor.js 25582`. It records its PID under `.bot-state/supervisors/` and restarts a missing bot or one whose flight record has been quiet for 60 seconds. It leaves a bot alone while a trial is starting or its server is down.

Supervisor startup uses an exclusive lock. A stale lock with a recorded dead PID can be recovered automatically. An incomplete lock or an abandoned recovery guard requires inspection: check the recorded PID before removing that specific file under `.bot-state/supervisors/` and retrying. The launcher also refuses a live owner or an occupied server port before recovering corrupt server metadata.

Other Node commands use the same arguments across platforms:

```text
node scripts/trials/watch.js auto --once
node scripts/trials/checkpoint.js auto --once
node scripts/trials/start-stage.js --list fortress
node scripts/trials/spectate.js YourPlayerName
node scripts/trials/janitor.js --once
```

The arena has its own disposable world and stays in the foreground:

```text
node scripts/trials/arena-start.js --accept-eula
```

Use another terminal for drills. `ARENA_DIR` and `ARENA_PORT` choose another arena. The new Node trial entry points and server launcher support `--help` without starting a server or making model calls. `npm run trial -- --help` lists the trial commands; `npm run server -- --help` describes the launcher.

## Recordings and Python tools

`REPLAY_RECORDINGS` accepts an absolute path to your client's `replay_recordings` directory. Without it, replay tools try the PrismLauncher instance named `Jev Replays` and then the vanilla Minecraft directory:

| Platform | PrismLauncher base | Vanilla base |
| --- | --- | --- |
| Windows | `%APPDATA%/PrismLauncher/` | `%APPDATA%/.minecraft/` |
| macOS | `~/Library/Application Support/PrismLauncher/` | `~/Library/Application Support/minecraft/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/PrismLauncher/` | `~/.minecraft/` |

The Prism path continues through `instances/Jev Replays/.minecraft/replay_recordings/` on Windows/Linux, or `instances/Jev Replays/minecraft/replay_recordings/` on macOS. The resolver also tries the alternate `minecraft`/`.minecraft` spelling and chooses an existing directory. Override the path for another launcher or instance; replay-editing commands report a missing folder when they need it.

Windows can run the Python tools with:

```powershell
py -3 scripts/extract-knowledge.py ".tools/server-26.1.2.jar"
py -3 scripts/plan-outcomes.py 2026-10-01T00
```

Use `python3` instead of `py -3` on Linux/macOS. The extractor writes the version-specific data file documented in its header; run it only when intentionally regenerating that data.

## Operational limits and validation

Checkpoints ask the server to flush its save, then copy world files and bot state. These copies are not a transaction across Minecraft and bot state, and a live writer can change files during the copy. Stop the server and bot before taking a backup that must be consistent.

The janitor archives active logs incrementally and retains the originals while writers are running. Those archives do not reclaim the originals' disk space. Stop or cooperatively rotate the writer before expecting that space back. Retention cleanup can remove old recordings and checkpoints; keep required evidence elsewhere.

The test workflow defines Windows, Ubuntu and macOS jobs with Node 22 and Python 3.12. Windows commands use Command Prompt explicitly. Local Windows tests exercise process launch, Unicode and spaced paths, CRLF properties, console sessions and native TCP listener lookup with fake server processes. These checks do not establish that a real Minecraft world or remote CI run has passed. Connecting to your actual Minecraft installation and authenticating live model providers remain separate checks.
