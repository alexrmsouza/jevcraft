'use strict';
const path = require('node:path');
const ops = require('../lib/trial-ops');
async function scan(player, options = {}) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(player || '')) throw new Error('a Minecraft player name is required');
  const { root = ops.ROOT, seen = new Map(), pause = ops.pause, say = console.log } = options;
  const { serverRunning = require('../lib/server').serverRunning, writeConsole = require('../lib/server').writeConsole } = options;
  for (const dir of ops.serverDirs(root)) {
    if (!await serverRunning(dir)) continue;
    const now = ops.read(path.join(dir, 'logs/latest.log')).split('\n').filter(line => line.includes(`${player} joined the game`)).length;
    let before = seen.get(dir) || 0; if (now < before) before = 0;
    if (now > before) { await pause(1000, options.signal); if (options.signal?.aborted) break; writeConsole(dir, `gamemode spectator ${player}\nspectate Jev ${player}`); say(`${new Date().toISOString()} ${player} on ${path.basename(dir)}: spectating Jev`); }
    seen.set(dir, now);
  }
  return seen;
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'spectate.js <player> [--once]')) return; const parsed = ops.options(argv); const seen = new Map(); return ops.loop(() => scan(parsed.args[0], { ...options, seen }), { ...options, once: parsed.once, every: 2000 }); }
if (require.main === module) ops.cli(main);
module.exports = { scan, main };
