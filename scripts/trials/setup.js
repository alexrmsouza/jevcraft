'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { VERSION, ensureTools, prepareServer, acceptedEula, writeMissing } = require('../lib/server-setup');

function parseArguments(argv) {
  const options = { count: 4, version: VERSION, acceptEula: false, vanilla: false, toolsOnly: false, help: false };
  let countSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--accept-eula') options.acceptEula = true;
    else if (arg === '--vanilla') options.vanilla = true;
    else if (arg === '--tools-only') options.toolsOnly = true;
    else if (['--tools', '--version', '--java'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (!arg.startsWith('-') && !countSeen) { options.count = Number(arg); countSeen = true; }
    else throw new Error(`Unknown setup argument: ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 39955) throw new Error('Server count must be an integer from 1 to 39955');
  return options;
}

async function main(argv = process.argv.slice(2), { root = path.resolve(__dirname, '../..'), env = process.env, say = console.log, ensureToolsImpl = ensureTools } = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    say('node scripts/trials/setup.js [N=4] [--accept-eula] [--vanilla] [--tools-only] [--tools PATH] [--version VERSION] [--java EXECUTABLE]\nTools default to JEV_TOOLS or <repo>/.tools. --tools-only downloads/verifies binaries without accepting the Minecraft EULA.');
    return;
  }
  const directories = Array.from({ length: options.count }, (_, i) => path.join(root, i ? `.clean-run-${25581 + i}` : '.clean-run'));
  if (!options.toolsOnly && !options.acceptEula && directories.some(directory => !acceptedEula(directory))) throw new Error('Minecraft EULA acceptance required. Read https://aka.ms/MinecraftEULA and pass --accept-eula, or use --tools-only.');
  const tools = await ensureToolsImpl({ root, tools: options.tools, version: options.version, vanilla: options.vanilla, env: options.java ? { ...env, JAVA: options.java } : env, say });
  if (options.toolsOnly) { say(`Tools ready: Java ${tools.java}; Minecraft ${tools.serverJar}`); return tools; }
  for (const directory of ['.trial-sources', '.bot-state', 'artifacts']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const [i, directory] of directories.entries()) {
    const port = 25581 + i;
    prepareServer(directory, { java: tools.java, jar: options.vanilla ? tools.serverJar : tools.fabricJar, port, acceptEula: options.acceptEula });
    if (!options.vanilla) {
      fs.mkdirSync(path.join(directory, 'mods'), { recursive: true });
      for (const mod of tools.mods) {
        const destination = path.join(directory, 'mods', path.basename(mod.file));
        fs.copyFileSync(mod.file, destination);
      }
      fs.mkdirSync(path.join(directory, 'config', 'server-replay'), { recursive: true });
      const jar = tools.serverJar.replaceAll('\\', '/').replaceAll(':', '\\:');
      writeMissing(path.join(directory, 'fabric-server-launcher.properties'), `serverJar=${jar}\n`);
      writeMissing(path.join(directory, 'config', 'server-replay', 'config.json'), `${JSON.stringify({ world_name: `Jev trial ${port}`, server_name: `trial ${port}`, automatically_record: true, player_predicate: { type: 'has_name', names: ['Jev'] } }, null, 2)}\n`);
    }
  }
  say(`${options.count} trial servers ready (25581-${25580 + options.count}). Start one with node scripts/server/start.js --directory "${directories[0]}"`);
  return { tools, directories };
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArguments, main };
