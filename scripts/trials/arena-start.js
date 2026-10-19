'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ensureTools, prepareServer, acceptedEula, javaVersion } = require('../lib/server-setup');
const { startServer, serverRunning, writeConsole } = require('../lib/server');
const { parseArguments } = require('./setup');

function repoRoot(here = path.resolve(__dirname, '../..')) {
  try { return path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (_) { return here; }
}

async function main(argv = process.argv.slice(2), { root = repoRoot(), env = process.env, say = console.log, ensureToolsImpl = ensureTools, startServerImpl = startServer, serverRunningImpl = serverRunning } = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    say('node scripts/trials/arena-start.js [--accept-eula] [--tools PATH] [--version VERSION] [--java EXECUTABLE] [--tools-only]\nARENA_DIR and ARENA_PORT select a server; the default is the shared checkout\'s .test-combat on port 25574. JAVA and SERVER_JAR override local tools.');
    return;
  }
  const directory = path.resolve(env.ARENA_DIR || path.join(root, '.test-combat')), port = Number(env.ARENA_PORT || 25574);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARENA_PORT must be an integer from 1 to 65535');
  if (!options.toolsOnly && !options.acceptEula && !acceptedEula(directory)) throw new Error('Minecraft EULA acceptance required. Read https://aka.ms/MinecraftEULA and pass --accept-eula.');
  const toolEnv = options.java ? { ...env, JAVA: options.java } : env;
  const tools = toolEnv.JAVA && env.SERVER_JAR && fs.existsSync(env.SERVER_JAR) && javaVersion(toolEnv.JAVA) >= 25
    ? { java: toolEnv.JAVA, serverJar: path.resolve(env.SERVER_JAR) }
    : await ensureToolsImpl({ root, tools: options.tools, version: options.version, vanilla: true, env: toolEnv, say });
  if (options.toolsOnly) { say(`Arena tools ready: ${tools.serverJar}`); return tools; }
  prepareServer(directory, { java: tools.java, jar: env.SERVER_JAR || tools.serverJar, port, arena: true, acceptEula: options.acceptEula });
  if (serverRunningImpl(directory)) throw new Error(`The arena or port ${port} is already running`);
  const child = startServerImpl(directory, { root, env: toolEnv, log: path.join(directory, 'logs', 'arena-console.log'), detached: false });
  const stop = () => writeConsole(directory, 'stop');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  child.once('exit', code => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code || 0; });
  child.once('error', error => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); console.error(error.message); process.exitCode = 1; });
  say(`Arena launcher started: ${directory} (port ${port}); log: logs/arena-console.log`);
  return { child, directory };
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repoRoot, main };
